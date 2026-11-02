import { describe, expect, it } from 'vitest';
import { r1TailPreparationPlan, r1TailAclTransaction } from './r1-tail-migration-acl.js';
import type { R1AclRow } from './r1-tail-migration-acl.js';
// Synthetic metadata with the independently observed intents/deliveries owner and ACL shapes.
function preimage(): R1AclRow[] {
  const rows: R1AclRow[] = [];
  for (const schema of [
    'booking',
    'commerce',
    'eligibility',
    'games',
    'identity',
    'integration',
    'locations',
    'notifications',
  ])
    rows.push({
      key: 'schema:' + schema,
      owner: 'phub_beta',
      aclIsNull: false,
      props: { USAGE: true, CREATE: false },
      acl: [
        ['phub_beta', 'phub_beta', 'CREATE', false],
        ['phub_beta', 'phub_beta', 'USAGE', false],
        ['phub_beta', 'phub_migrator', 'USAGE', false],
      ],
    });
  const parents: { name: string; columns: string[] }[] = [
    { name: 'identity.tenants', columns: ['id'] },
    { name: 'identity.users', columns: ['tenant_id', 'id'] },
    { name: 'identity.refresh_sessions', columns: ['tenant_id', 'id'] },
    { name: 'locations.profiles', columns: ['tenant_id', 'id'] },
    { name: 'integration.external_entity_map', columns: ['tenant_id', 'id'] },
    { name: 'games.command_idempotency', columns: ['tenant_id', 'id'] },
    { name: 'games.games', columns: ['tenant_id', 'id'] },
    { name: 'games.participations', columns: ['tenant_id', 'game_id', 'id'] },
    { name: 'games.seat_reservations', columns: ['tenant_id', 'game_id', 'id'] },
    { name: 'games.payment_confirmation_evidence', columns: ['tenant_id', 'id'] },
    { name: 'eligibility.decisions', columns: ['tenant_id', 'id'] },
    { name: 'eligibility.payment_snapshots', columns: ['tenant_id', 'operation_id'] },
  ];
  for (const parent of parents) {
    rows.push({
      key: 'table:' + parent.name,
      owner: 'phub_beta',
      aclIsNull: true,
      props: { rls: true, force: true },
      acl: [],
    });
    for (const column of parent.columns)
      rows.push({
        key: `column:${parent.name}:${column}`,
        owner: 'phub_beta',
        aclIsNull: true,
        props: { REFERENCES: false },
        acl: [],
      });
  }
  for (const [table, owner] of [
    ['notifications.intents', 'phub_beta'],
    ['notifications.deliveries', 'phub_migrator'],
  ] as const) {
    const acl: [string, string, string, boolean][] = [];
    for (const privilege of [
      'DELETE',
      'INSERT',
      'REFERENCES',
      'SELECT',
      'TRIGGER',
      'TRUNCATE',
      'UPDATE',
    ])
      acl.push([owner, owner, privilege, false]);
    for (const privilege of ['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
      acl.push([owner, 'phub_runtime', privilege, false]);
    rows.push({
      key: 'table:' + table,
      owner,
      aclIsNull: false,
      props: { rls: true, force: true },
      acl,
    });
  }
  for (const column of ['id', 'tenant_id'])
    rows.push({
      key: 'column:notifications.intents:' + column,
      owner: 'phub_beta',
      aclIsNull: false,
      props: { REFERENCES: true },
      acl: [['phub_beta', 'phub_migrator', 'REFERENCES', false]],
    });
  return rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
describe('R1 tail exact temporary owner and grantor recovery', () => {
  it('restores original intents owner, runtime DML and both column REFERENCES without owner membership', () => {
    const input = preimage(),
      plan = r1TailPreparationPlan(input);
    expect(plan.bootstrapStatements.at(-1)).toBe(
      'alter table notifications.intents owner to phub_migrator;',
    );
    expect(plan.cleanupStatements).toContain(
      'alter table notifications.intents owner to phub_beta;',
    );
    for (const column of ['id', 'tenant_id'])
      expect(plan.cleanupStatements).toContain(
        `grant REFERENCES ("${column}") on notifications.intents to "phub_migrator";`,
      );
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
      expect(plan.cleanupStatements).toContain(
        `grant ${privilege} on notifications.intents to "phub_runtime";`,
      );
    expect(plan.cleanupStatements.join('\n')).not.toMatch(
      /cascade|disable row level|grant phub_beta|owner to phub_runtime/i,
    );
    expect(r1TailAclTransaction(plan, 'bootstrap', input)).toContain('R1_TAIL_ACL_PREIMAGE_DRIFT');
    expect(input).toEqual(preimage());
  });
  it.each(['owner', 'grantor', 'grantable', 'nullacl', 'rls'] as const)(
    'refuses unsupported%s before producing SQL',
    (kind) => {
      const rows = preimage(),
        row = rows.find((row) => row.key === 'table:notifications.intents')!;
      if (kind === 'owner') row.owner = 'phub_runtime';
      if (kind === 'grantor') row.acl[0]![0] = 'foreign_role';
      if (kind === 'grantable') row.acl[0]![3] = true;
      if (kind === 'nullacl') row.aclIsNull = true;
      if (kind === 'rls') row.props.force = false;
      expect(() => r1TailPreparationPlan(rows)).toThrow();
    },
  );
  it('does not revoke a preexisting CREATE/REFERENCES capability', () => {
    const rows = preimage();
    rows.find((row) => row.key === 'schema:games')!.props.CREATE = true;
    rows.find((row) => row.key === 'column:identity.users:id')!.props.REFERENCES = true;
    const plan = r1TailPreparationPlan(rows);
    expect(plan.cleanupStatements).not.toContain(
      'revoke CREATE on schema "games" from phub_migrator;',
    );
    expect(plan.cleanupStatements).not.toContain(
      'revoke references ("id") on "identity"."users" from phub_migrator;',
    );
  });
});
