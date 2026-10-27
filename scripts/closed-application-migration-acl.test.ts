import { describe, expect, it } from 'vitest';
import {
  closedApplicationAclPlan,
  closedApplicationAclSql,
  validateClosedApplicationAcl,
  type ClosedApplicationAclProfile,
  type ClosedApplicationAclRow,
} from './closed-application-migration-acl.js';

function fixture(profile: ClosedApplicationAclProfile): ClosedApplicationAclRow[] {
  const tables =
    profile === 'game_start_0103'
      ? ['games.games', 'identity.tenants', 'identity.users']
      : ['identity.users'];
  const schema = profile === 'game_start_0103' ? 'notifications' : 'identity';
  const rows: ClosedApplicationAclRow[] = [
    {
      key: `schema:${schema}`,
      owner: 'phub_beta',
      aclIsNull: false,
      effective: { CREATE: false, USAGE: true },
      acl: [
        ['phub_beta', 'phub_beta', 'CREATE', false],
        ['phub_beta', 'phub_beta', 'USAGE', false],
        ['phub_beta', 'phub_migrator', 'USAGE', false],
      ],
    },
  ];
  for (const table of tables) {
    rows.push({
      key: `table:${table}`,
      owner: 'phub_beta',
      aclIsNull: true,
      effective: { REFERENCES: false },
      acl: ['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'].map(
        (privilege) => ['phub_beta', 'phub_beta', privilege, false],
      ),
    });
    for (const column of table === 'identity.tenants' ? ['id'] : ['id', 'tenant_id'])
      rows.push({
        key: `column:${table}:${column}`,
        owner: 'phub_beta',
        aclIsNull: true,
        effective: { REFERENCES: false },
        acl: [],
      });
  }
  return rows.sort((a, b) => (a.key < b.key ? -1 : 1));
}
describe('sealed temporary application-migration ACL plan', () => {
  it.each(['game_start_0103', 'subject_link_0104'] as const)(
    'preserves mixed existing grants and removes only its own added %s bits',
    (profile) => {
      const rows = fixture(profile);
      const existing = rows.find((row) => row.key === 'column:identity.users:id')!;
      Object.assign(existing, {
        aclIsNull: false,
        effective: { REFERENCES: true },
        acl: [
          ['phub_beta', 'phub_migrator', 'REFERENCES', false],
          ['phub_beta', 'phub_runtime', 'SELECT', false],
        ],
      });
      const before = JSON.stringify(rows);
      const plan = closedApplicationAclPlan(profile, rows);
      expect(JSON.stringify(rows)).toBe(before);
      expect(plan.added.some(([key]) => key === existing.key)).toBe(false);
      expect(plan.bootstrap.find((row) => row.key === existing.key)).toEqual(existing);
      expect(plan.preimage).toEqual(rows);
      expect(plan.bootstrapSql).toContain("set local lock_timeout='5s'");
      expect(plan.bootstrapSql).toContain('pg_advisory_xact_lock(7140221)');
      expect(plan.bootstrapSql).toContain('CLOSED_APPLICATION_ACL_DRIFT');
      expect(plan.bootstrapSql).toContain(
        'grant REFERENCES (tenant_id) on identity.users to phub_migrator;',
      );
      expect(plan.cleanupSql).toContain(
        'revoke REFERENCES (tenant_id) on identity.users from phub_migrator;',
      );
      expect(plan.cleanupSql).not.toContain(
        'revoke REFERENCES (id) on identity.users from phub_migrator;',
      );
      for (const digest of [plan.preimageSha256, plan.bootstrapSha256, plan.cleanupSha256])
        expect(digest).toMatch(/^[a-f0-9]{64}$/);
    },
  );
  it('refuses ambiguous, missing, widened or mismatched ownership/ACL evidence', () => {
    const rows = fixture('subject_link_0104');
    const mutations: unknown[] = [
      null,
      {},
      [],
      rows.slice(1),
      [...rows].reverse(),
      [...rows, rows[0]],
      rows.map((row, i) => (i ? row : { ...row, owner: 'phub' })),
      rows.map((row, i) =>
        i ? row : { ...row, key: 'column:identity.users:id;drop table identity.users' },
      ),
      rows.map((row, i) => (i ? row : { ...row, extra: true })),
      rows.map((row, i) =>
        i ? row : { ...row, acl: [['phub_beta', 'phub_migrator', 'REFERENCES', true]] },
      ),
    ];
    for (const mutation of mutations)
      expect(() => closedApplicationAclPlan('subject_link_0104', mutation)).toThrow(
        'CLOSED_APPLICATION_ACL_',
      );
    expect(() => closedApplicationAclSql('__proto__' as ClosedApplicationAclProfile)).toThrow(
      'CLOSED_APPLICATION_ACL_PROFILE',
    );
    expect(() =>
      validateClosedApplicationAcl('subject_link_0104', fixture('game_start_0103')),
    ).toThrow();
  });
});
