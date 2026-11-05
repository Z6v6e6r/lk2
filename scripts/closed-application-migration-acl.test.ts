import { createHash } from 'node:crypto';
import { closedApplicationRoleProbeSource } from './timeweb-closed-application-profile.js';
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

describe('R1 temporary games schema USAGE', () => {
  const rows = (profile: ClosedApplicationAclProfile = 'game_start_0103') =>
    [
      ...fixture(profile),
      {
        key: 'schema:games',
        owner: 'phub_beta',
        aclIsNull: false,
        effective: { CREATE: false, USAGE: false },
        acl: [
          ['phub_beta', 'phub_beta', 'CREATE', false],
          ['phub_beta', 'phub_beta', 'USAGE', false],
          ['phub_beta', 'phub_runtime', 'USAGE', false],
        ],
      } satisfies ClosedApplicationAclRow,
    ].sort((a, b) => (a.key < b.key ? -1 : 1));
  it.each(['game_start_0103', 'subject_link_0104'] as const)(
    'captures %s schema ownership/ACL via catalog OIDs before granting narrow USAGE',
    (profile) => {
      const input = rows(profile);
      const plan = closedApplicationAclPlan(profile, input, 'R1_PACKAGE119');
      expect(plan.added).toContainEqual(['schema:games', 'USAGE']);
      expect(plan.bootstrapSql).toContain('grant USAGE on schema games to phub_migrator;');
      expect(plan.cleanupSql).toContain('revoke USAGE on schema games from phub_migrator;');
      expect(plan.bootstrapSql).not.toContain('grant CREATE on schema games');
      expect(plan.bootstrap.find((row) => row.key === 'schema:games')?.acl).toContainEqual([
        'phub_beta',
        'phub_runtime',
        'USAGE',
        false,
      ]);
      expect(plan.preimage).toEqual(input);
      for (const profile of ['game_start_0103', 'subject_link_0104'] as const) {
        const sql = closedApplicationAclSql(profile, 'R1_PACKAGE119');
        expect(sql).not.toContain('::regclass');
        expect(sql).toContain('pg_catalog.pg_namespace');
        expect(sql).toContain('pg_catalog.pg_class');
        expect(sql).toContain('pg_catalog.has_column_privilege');
      }
    },
  );
  it('retains existing USAGE and rejects missing, null or unconfirmed owner evidence', () => {
    const input = rows();
    const games = input.find((row) => row.key === 'schema:games')!;
    Object.assign(games, {
      effective: { CREATE: false, USAGE: true },
      acl: [
        ...games.acl.slice(0, 2),
        ['phub_beta', 'phub_migrator', 'USAGE', false],
        ...games.acl.slice(2),
      ],
    });
    const plan = closedApplicationAclPlan('game_start_0103', input, 'R1_PACKAGE119');
    expect(plan.added).not.toContainEqual(['schema:games', 'USAGE']);
    expect(plan.cleanupSql).not.toContain('revoke USAGE on schema games');
    for (const invalid of [
      rows().filter((row) => row.key !== 'schema:games'),
      rows().map((row) =>
        row.key === 'schema:games' ? { ...row, owner: 'unexpected_owner' } : row,
      ),
      rows().map((row) => (row.key === 'schema:games' ? { ...row, aclIsNull: true } : row)),
    ])
      expect(() => closedApplicationAclPlan('game_start_0103', invalid, 'R1_PACKAGE119')).toThrow(
        'CLOSED_APPLICATION_ACL_',
      );
    expect(() => closedApplicationAclPlan('game_start_0103', rows())).toThrow(
      'CLOSED_APPLICATION_ACL_',
    );
    expect(() => closedApplicationAclSql('game_start_0103', 'unknown' as never)).toThrow(
      'CLOSED_APPLICATION_ACL_FAMILY',
    );
  });
  it.each([
    [
      'game_start_0103',
      '220abd02756eccaaabd38827a6a68dc6d4ae5e2df8477018812af9cc79101252',
      'da2da17ea51370084fd2419178bd1e3d2cc4f5ce0deee5556c873da801d1338d',
    ],
    [
      'subject_link_0104',
      '7f50e86172ba225c3492f395eb05bf168bed4caf98b7693eb79960cd43e1763c',
      'a69526a37e1eea66b26263e038c84b47666710951c05b1020e938c52ee923f62',
    ],
  ] as const)('preserves historical108 %s SQL and probe bytes', (profile, sqlHash, probeHash) => {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    expect(hash(closedApplicationAclSql(profile))).toBe(sqlHash);
    expect(hash(closedApplicationRoleProbeSource(profile))).toBe(probeHash);
  });
});
