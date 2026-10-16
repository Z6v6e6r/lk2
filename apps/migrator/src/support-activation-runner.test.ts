import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  assertSupportActivationLedger,
  readSupportPackagedMigrations,
  runSupportActivation,
  supportLedgerSha256,
  validateSupportActivationBinding,
  supportActivationBindingSha256,
  SUPPORT_ACTIVATION_CONFIRMATION,
  SUPPORT_ACTIVATION_LEDGER_SHA256,
  type SupportActivationBinding,
  type SupportActivationClient,
} from './support-activation-runner.js';
import { SUPPORT_DATABASE_OWNER_ROLE } from '@phub/database/support-activation';
import {
  supportCatalogClientFixture,
  supportPrivilegeFixture,
} from '../../../packages/database/src/support-ticket-activation.fixture.js';
const packaged = await readSupportPackagedMigrations(resolve('packages/database/migrations'));
const binding = (count: 99 | 101 = 101): SupportActivationBinding => ({
  schema: 'PHUB_SUPPORT_DATABASE_ACTIVATION_V1',
  executorKind: 'EXISTING_PRIVILEGED_BOOTSTRAP',
  bootstrapRoleName: 'bootstrap',
  databaseHost: '127.0.0.1',
  databasePort: '5432',
  databaseName: 'support_verify',
  systemIdentifier: '123456789',
  runtimeRoleName: 'support_runtime',
  migratorRoleName: SUPPORT_DATABASE_OWNER_ROLE,
  preLedgerCount: count,
  preLedgerSha256: supportLedgerSha256(packaged.slice(0, count)),
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  confirmation: SUPPORT_ACTIVATION_CONFIRMATION,
});
const url = 'postgres://bootstrap:synthetic@127.0.0.1:5432/support_verify';
function fixture(
  options: {
    count?: 99 | 101 | 102;
    failAt?: string;
    unsafeRole?: boolean;
    namespace?: boolean;
    badDefault?: boolean;
    capability?: boolean;
  } = {},
) {
  let rows = packaged
    .slice(0, options.count ?? 101)
    .map(({ filename, checksum }) => ({ filename, checksum }));
  let granted = false;
  const catalog = supportCatalogClientFixture();
  const inventory = supportPrivilegeFixture();
  const statements: string[] = [];
  const client = {
    connect: vi.fn(() => Promise.resolve()),
    end: vi.fn(() => Promise.resolve()),
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      statements.push(sql);
      if (options.failAt && sql.includes(options.failAt)) throw Error('synthetic failure');
      if (sql.includes('support-owner-inventory'))
        return {
          rows: [
            {
              unsafe: false,
              functionCount: rows.length === 102 ? 4 : 0,
              schemaCount: rows.length === 102 ? 1 : 0,
            },
          ],
        };
      if (sql.includes('system_identifier::text'))
        return {
          rows: [
            {
              databaseName: 'support_verify',
              systemIdentifier: '123456789',
              roleName: 'bootstrap',
              sessionRole: 'bootstrap',
              recovery: false,
            },
          ],
        };
      if (sql.includes('from pg_roles r where rolname=any'))
        return {
          rows: [
            {
              name: 'support_runtime',
              login: true,
              unsafe: options.unsafeRole ?? false,
              membershipCount: 0,
            },
            { name: SUPPORT_DATABASE_OWNER_ROLE, login: false, unsafe: false, membershipCount: 0 },
          ],
        };
      if (sql === 'select filename,checksum from public.schema_migrations order by filename')
        return { rows };
      if (sql.startsWith('insert into public.schema_migrations'))
        rows = [...rows, { filename: String(values[0]), checksum: String(values[1]) }];
      if (sql.includes("to_regnamespace('support')"))
        return { rows: [{ present: options.namespace ?? false }] };
      if (sql.includes('from pg_default_acl'))
        return { rows: [{ unsafe: options.badDefault ?? false }] };
      if (sql.includes(' as ready')) return { rows: [{ ready: options.capability ?? true }] };
      if (sql.startsWith('grant ')) granted = true;
      if (sql.includes('with relations as')) return { rows: granted ? inventory.relations : [] };
      if (sql.startsWith('select n.nspname as'))
        return {
          rows: granted ? inventory.schemas : [{ schemaName: 'public', privilege: 'USAGE' }],
        };
      return catalog.query(sql);
    }),
  };
  return {
    client: client as unknown as SupportActivationClient,
    statements,
    connect: client.connect,
    end: client.end,
  };
}
describe('closed support activation phase runner', () => {
  it('pins actual 102-row package and accepts only exact99/101 preimages', () => {
    expect(supportLedgerSha256(packaged)).toBe(SUPPORT_ACTIVATION_LEDGER_SHA256);
    for (const count of [99, 101] as const)
      expect(() =>
        assertSupportActivationLedger(packaged.slice(0, count), packaged, 'pre', binding(count)),
      ).not.toThrow();
    for (const count of [0, 98, 100, 102])
      expect(() =>
        assertSupportActivationLedger(packaged.slice(0, count), packaged, 'pre', binding()),
      ).toThrow();
  });
  it('rejects unknown, expired, unconfirmed, owner-drift and foreign connection inputs before connect', async () => {
    for (const patch of [
      { extra: true },
      { confirmation: 'yes' },
      { executorKind: 'bounded' },
      { migratorRoleName: 'bootstrap' },
      { expiresAt: new Date(Date.now() - 1).toISOString() },
    ])
      expect(() =>
        validateSupportActivationBinding({ ...binding(), ...patch } as SupportActivationBinding),
      ).toThrow();
    const { client, connect: fixtureConnect } = fixture();
    await expect(
      runSupportActivation(
        'migrate',
        binding(),
        url.replace('127.0.0.1', 'other'),
        packaged,
        () => client,
      ),
    ).rejects.toThrow('CONNECTION');
    expect(fixtureConnect).not.toHaveBeenCalled();
  });
  it('never lets support owner execute compatibility96/97', async () => {
    const f = fixture({ count: 99 });
    await expect(
      runSupportActivation('migrate', binding(99), url, packaged, () => f.client),
    ).rejects.toThrow('PRECONDITION');
    expect(f.connect).not.toHaveBeenCalled();
    const result = await runSupportActivation(
      'compatibility',
      binding(99),
      url,
      packaged,
      () => f.client,
    );
    expect(result.ledgerCount).toBe(101);
    expect(f.statements).toContain(packaged[99]!.sql);
    expect(f.statements).toContain(packaged[100]!.sql);
    expect(f.statements).not.toContain(packaged[101]!.sql);
    expect(f.statements.join(' ')).not.toContain('set local role');
  });
  it('preserves owner switch/lock/ledger/commit ordering and binds the exact request', async () => {
    const b = binding(),
      f = fixture();
    const result = await runSupportActivation('migrate', b, url, packaged, () => f.client);
    expect(result.bindingSha256).toBe(supportActivationBindingSha256(b));
    expect(result.ledgerCount).toBe(102);
    const sql = f.statements;
    expect(sql).toContain("set local lock_timeout = '5s'");
    expect(sql).toContain("set local statement_timeout = '120s'");
    expect(sql.indexOf('select pg_advisory_xact_lock($1)')).toBeLessThan(
      sql.indexOf(packaged[101]!.sql),
    );
    expect(sql.indexOf(`set local role "${SUPPORT_DATABASE_OWNER_ROLE}"`)).toBeLessThan(
      sql.indexOf(packaged[101]!.sql),
    );
    expect(sql.indexOf('reset role')).toBeGreaterThan(sql.indexOf(packaged[101]!.sql));
    expect(sql.at(-1)).toBe('commit');
    expect(sql).not.toContain(packaged[99]!.sql);
  });
  it.each(['create schema if not exists support', 'insert into public.schema_migrations'])(
    'rolls back the whole DDL/ledger transaction after failure at %s',
    async (failAt) => {
      const f = fixture({ failAt });
      await expect(
        runSupportActivation('migrate', binding(), url, packaged, () => f.client),
      ).rejects.toThrow();
      expect(f.statements.at(-1)).toBe('rollback');
      expect(f.statements).not.toContain('commit');
      expect(f.end).toHaveBeenCalledOnce();
    },
  );
  it.each([{ unsafeRole: true }, { namespace: true }, { badDefault: true }, { capability: false }])(
    'rejects unsafe preimages beforeDDL: %j',
    async (options) => {
      const f = fixture(options);
      await expect(
        runSupportActivation('migrate', binding(), url, packaged, () => f.client),
      ).rejects.toThrow();
      expect(f.statements).not.toContain(packaged[101]!.sql);
      expect(f.statements.at(-1)).toBe('rollback');
    },
  );
  it('rolls back all grants on a later dependency grant failure', async () => {
    const f = fixture({ count: 102, failAt: 'grant SELECT' });
    await expect(
      runSupportActivation('acl', binding(), url, packaged, () => f.client),
    ).rejects.toThrow();
    expect(f.statements.some((sql) => sql.startsWith('grant usage'))).toBe(true);
    expect(f.statements.at(-1)).toBe('rollback');
    expect(f.statements).not.toContain('commit');
  });
  it('preflight does no DDL/DCL/advisory locking', async () => {
    const f = fixture();
    await runSupportActivation('preflight', binding(), url, packaged, () => f.client);
    expect(f.statements[0]).toContain('read only');
    expect(f.statements.join(' ')).not.toMatch(
      /pg_advisory|grant usage|create schema|insert into/iu,
    );
  });
});
