import { describe, expect, it } from 'vitest';
import { R1_TAIL } from './r1-tail-migration-profile.js';
import { r1RuntimePrivilegeRequirements } from './r1-runtime-privilege-audit.js';
import {
  planR1RuntimeGrants119,
  r1RuntimeGrantTransaction119,
  r1RuntimeGrantCatalog119,
} from './r1-runtime-grants119.js';
import type { R1Grant119Capture, R1Grant119Acl } from './r1-runtime-grants119.js';
function capture(): R1Grant119Capture {
  const names = [
    ...new Set(
      ['api', 'worker'].flatMap((c) =>
        r1RuntimePrivilegeRequirements(c as 'api' | 'worker')
          .filter((r) => r.tenantTable)
          .map((r) => r.relation),
      ),
    ),
  ].sort();
  return {
    databaseName: 'r1_fixture',
    systemIdentifier: '7679125609183186977',
    recovery: false,
    roleSafe: true,
    schemas: [...new Set(names.map((name) => name.split('.')[0]!))].sort().map((name) => ({
      name,
      owner: 'phub_beta',
      acl: '{phub_beta=UC/phub_beta,phub_runtime=U/phub_beta}',
      migratorUsage: name !== 'games',
      migratorCreate: false,
    })),
    ledger: structuredClone(R1_TAIL.inventory),
    tables: names.map((relation) => ({
      relation,
      owner: 'phub_migrator',
      kind: 'r',
      rls: true,
      forceRls: true,
      schemaUsage: true,
      schemaCreate: false,
      schemaOwnerAssumable: false,
      acl: [],
      columns: ['completed_at', 'id', 'outcome', 'used_at'].map((name) => ({ name, acl: [] })),
    })),
  };
}
describe('fixed R1 runtime119 grants', () => {
  it('changes only18 new relations and the reviewed privilege union', () => {
    const p = planR1RuntimeGrants119(capture());
    expect(p.preimage.tables).toHaveLength(18);
    expect(p.changes.some((c) => c.relation === 'identity.users')).toBe(false);
    expect(p.changes.filter((c) => c.privilege === 'DELETE')).toEqual([
      {
        action: 'grant',
        relation: 'notifications.legacy_game_reminder_recipients',
        column: null,
        privilege: 'DELETE',
      },
    ]);
    expect(
      p.changes
        .filter(
          (c) =>
            c.relation === 'identity.external_subject_link_commands' && c.privilege === 'UPDATE',
        )
        .map((c) => c.column)
        .sort(),
    ).toEqual(['completed_at', 'outcome']);
    expect(
      p.changes
        .filter(
          (c) => c.relation === 'commerce.monthly_purchase_launches' && c.privilege === 'UPDATE',
        )
        .map((c) => c.column),
    ).toEqual(['used_at']);
    expect(planR1RuntimeGrants119(p.postimage).changes).toEqual([]);
  });
  it('records and reverses only broad command defaults while preserving foreign ACLs', () => {
    const x = capture(),
      row = x.tables.find((t) => t.relation === 'identity.external_subject_link_commands')!;
    row.acl = [
      ['phub_migrator', 'audit_reader', 'SELECT', false],
      ['phub_migrator', 'phub_runtime', 'DELETE', false],
      ['phub_migrator', 'phub_runtime', 'UPDATE', false],
    ];
    row.columns.find((c) => c.name === 'id')!.acl = [
      ['phub_migrator', 'phub_runtime', 'UPDATE', false],
    ];
    const p = planR1RuntimeGrants119(x);
    expect(p.changes.filter((c) => c.action === 'revoke')).toHaveLength(3);
    expect(p.postimage.tables.find((t) => t.relation === row.relation)!.acl).toContainEqual(
      row.acl[0],
    );
    const recovery = r1RuntimeGrantTransaction119(p, 'recover');
    expect(recovery).toContain(
      'grant DELETE on "identity"."external_subject_link_commands" to phub_runtime;',
    );
    expect(recovery).not.toMatch(/cascade|alter default|alter table|create role|disable row/iu);
  });
  it.each([
    'role',
    'rls',
    'owner',
    'schema',
    'ledger',
    'coverage',
    'grantor',
    'grantable',
    'public',
    'partial-column',
    'duplicate-column',
  ])('fails closed on %s drift', (kind) => {
    const x = capture(),
      r = x.tables[0]!;
    if (kind === 'role') x.roleSafe = false;
    if (kind === 'rls') r.forceRls = false;
    if (kind === 'owner') r.owner = 'phub_runtime';
    if (kind === 'schema') r.schemaCreate = true;
    if (kind === 'ledger') x.ledger.pop();
    if (kind === 'coverage') x.tables.pop();
    if (kind === 'grantor') r.acl = [['foreign_owner', 'phub_runtime', 'SELECT', false]];
    if (kind === 'grantable') r.acl = [['phub_migrator', 'phub_runtime', 'SELECT', true]];
    if (kind === 'public') r.acl = [['phub_migrator', 'PUBLIC', 'SELECT', false]];
    if (kind === 'partial-column')
      x.tables.find((t) => t.relation === 'commerce.monthly_purchase_launches')!.columns.pop();
    if (kind === 'duplicate-column') r.columns.push(r.columns[0]!);
    expect(() => planR1RuntimeGrants119(x)).toThrow();
  });
  it('temporarily supplies only missing schema usage and preserves all existing schema grants', () => {
    const input = capture();
    const p = planR1RuntimeGrants119(input);
    expect(p.schema).toBe('PHUB_R1_RUNTIME_GRANTS119_V2');
    expect(p.postimage.schemas).toEqual(input.schemas);
    for (const phase of ['apply', 'recover'] as const) {
      const sql = r1RuntimeGrantTransaction119(p, phase);
      expect(sql).toContain(
        'set local role phub_beta;grant USAGE on schema "games" to phub_migrator;reset role;',
      );
      expect(sql).toContain(
        'set local role phub_beta;revoke USAGE on schema "games" from phub_migrator;reset role;',
      );
      expect(sql.match(/grant USAGE on schema/g)).toHaveLength(1);
      expect(sql.match(/revoke USAGE on schema/g)).toHaveLength(1);
      expect(sql.indexOf('grant USAGE')).toBeLessThan(sql.indexOf('set local role phub_migrator'));
      expect(sql.indexOf('revoke USAGE')).toBeGreaterThan(sql.indexOf('end $r1grants$'));
      expect(sql.indexOf('R1_RUNTIME_GRANT_PREIMAGE_DRIFT')).toBeLessThan(
        sql.indexOf('grant USAGE'),
      );
      expect(sql.lastIndexOf('R1_RUNTIME_GRANT_POSTIMAGE_DRIFT')).toBeGreaterThan(
        sql.indexOf('revoke USAGE'),
      );
      expect(sql).not.toMatch(/grant CREATE|cascade|alter schema/iu);
    }
    input.schemas.find((x) => x.name === 'games')!.migratorUsage = true;
    expect(r1RuntimeGrantTransaction119(planR1RuntimeGrants119(input), 'apply')).not.toContain(
      'USAGE on schema',
    );
  });
  it.each(['missing', 'owner', 'foreign-owner', 'null-acl', 'order', 'type', 'old-plan'])(
    'refuses incomplete or forged schema custody: %s',
    (kind) => {
      const x = capture();
      if (kind === 'missing') x.schemas.pop();
      if (kind === 'owner') x.schemas[0]!.owner = 'owner; reset role';
      if (kind === 'foreign-owner') x.schemas[0]!.owner = 'foreign_owner';
      if (kind === 'null-acl') x.schemas[0]!.acl = null as unknown as string;
      if (kind === 'order') x.schemas.reverse();
      if (kind === 'type') x.schemas[0]!.migratorUsage = 'false' as unknown as boolean;
      if (kind === 'old-plan') {
        const p = planR1RuntimeGrants119(x);
        p.schema = 'PHUB_R1_RUNTIME_GRANTS119_V1' as typeof p.schema;
        expect(() => r1RuntimeGrantTransaction119(p, 'apply')).toThrow();
      } else expect(() => planR1RuntimeGrants119(x)).toThrow();
    },
  );
  it('reconstructs statements and rejects forged plans or arbitrary identifiers', () => {
    const p = planR1RuntimeGrants119(capture());
    p.changes[0]!.relation = 'public.users';
    expect(() => r1RuntimeGrantTransaction119(p, 'apply')).toThrow();
    const x = capture();
    x.databaseName = "x';drop schema games;--";
    expect(() => planR1RuntimeGrants119(x)).toThrow();
  });
  it('pins whole pre/post snapshots in one bounded transaction under relation locks', () => {
    const p = planR1RuntimeGrants119(capture()),
      sql = r1RuntimeGrantTransaction119(p, 'apply');
    expect(sql).toMatch(/^begin;/u);
    expect(sql).toMatch(/commit;$/u);
    expect(sql).toContain('set local role phub_migrator');
    expect(sql).toContain('R1_RUNTIME_GRANT_PREIMAGE_DRIFT');
    expect(sql).toContain('R1_RUNTIME_GRANT_POSTIMAGE_DRIFT');
    expect(sql.match(/in share row exclusive mode/g)).toHaveLength(18);
  });
  it('preserves unrelated table grants and all existing parent scope', () => {
    const x = capture();
    const extra: R1Grant119Acl = [['phub_migrator', 'phub_runtime', 'SELECT', false]];
    x.tables[0]!.acl = extra;
    const p = planR1RuntimeGrants119(x);
    expect(p.preimage).toEqual(x);
    expect(
      p.changes.some((c) => c.relation === x.tables[0]!.relation && c.privilege === 'SELECT'),
    ).toBe(false);
  });
});

describe('post-grant semantic catalog binding', () => {
  it('preserves PostgreSQL text serialization and changes only reviewed ACL values', () => {
    const input = capture();
    const table = input.tables[0]!;
    table.acl = [['phub_migrator', 'phub_migrator', 'SELECT', false]];
    table.columns[0]!.acl = [['phub_migrator', 'phub_runtime', 'SELECT', false]];
    const plan = planR1RuntimeGrants119(input);
    const catalog = [
      {
        key: 'relation:' + table.relation,
        value:
          '{"acl": [["MIGRATOR", "MIGRATOR", "SELECT", false]], "rls": true, "owner": "MIGRATOR"}',
      },
      ...table.columns.map((c, i) => ({
        key: 'column:' + table.relation + ':' + c.name,
        value:
          i === 0
            ? '{"acl": [["phub_runtime", "phub_migrator", "SELECT", false]], "type": "uuid"}'
            : '{"acl": [], "type": "uuid"}',
      })),
      {
        key: 'relation:identity.users',
        value: '{"acl": [["RUNTIME", "MIGRATOR", "SELECT", false]], "owner": "MIGRATOR"}',
      },
    ];
    const original = structuredClone(catalog);
    const next = r1RuntimeGrantCatalog119(catalog, plan);
    expect((JSON.parse(next[0]!.value) as { acl: R1Grant119Acl }).acl).toContainEqual([
      'RUNTIME',
      'MIGRATOR',
      'SELECT',
      false,
    ]);
    expect(next[0]!.value).toContain(', "rls": true, "owner": "MIGRATOR"}');
    expect(next.at(-1)).toEqual(catalog.at(-1));
    expect(catalog).toEqual(original);
    expect(next[1]!.value).toContain('["phub_runtime", "phub_migrator", "SELECT", false]');
    catalog[0]!.value = '{"acl": [["RUNTIME", "MIGRATOR", "DELETE", false]]}';
    expect(() => r1RuntimeGrantCatalog119(catalog, plan)).toThrow('R1_RUNTIME_GRANT_BOUNDARY');
  });
  it('rejects object-valued or malformed catalog rows instead of accepting a synthetic shape', () => {
    const plan = planR1RuntimeGrants119(capture());
    const key = 'relation:' + plan.preimage.tables[0]!.relation;
    for (const value of [{ acl: [] }, '{"acl": []', '{"acl": [], "acl": []}']) {
      expect(() => r1RuntimeGrantCatalog119([{ key, value: value as string }], plan)).toThrow();
    }
  });
});
