import { describe, expect, it } from 'vitest';
import { R1_TAIL } from './r1-tail-migration-profile.js';
import { r1RuntimePrivilegeRequirements } from './r1-runtime-privilege-audit.js';
import { planR1RuntimeGrants119, r1RuntimeGrantTransaction119 } from './r1-runtime-grants119.js';
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
    recovery: false,
    roleSafe: true,
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
