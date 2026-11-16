import { expect, it, vi } from 'vitest';
import type { LegacyGameSourceSnapshot } from '@phub/legacy-games-adapter';
import {
  exactLegacyGameRosterRepair,
  EXACT_SOURCE_REPLACEMENT_CONFIRMATION,
} from './exact-legacy-game-roster-repair.js';
import {
  attestExactRosterPlayerMappings,
  exactRosterParticipations,
  exactRosterValueSha256,
} from '@phub/database';
import {
  parseRepairArguments,
  exactRosterRepairPoolOptions,
  rosterRepairFailureReport,
} from './repair-legacy-game-rosters.js';
const gameId = '11111111-1111-4111-8111-111111111111',
  tenantId = '22222222-2222-4222-8222-222222222222';
function fixture() {
  const snapshot: { -readonly [K in keyof LegacyGameSourceSnapshot]: LegacyGameSourceSnapshot[K] } =
    {
      externalId: 'private-source-game',
      externalAliases: ['raw-game'],
      externalVersion: 'a'.repeat(64),
      vivaExerciseExternalId: null,
      title: 'Синтетическая игра',
      kind: 'FRIENDLY',
      visibility: 'PRIVATE',
      cancelled: false,
      startsAt: '2026-11-15T04:00:00Z',
      endsAt: '2026-11-15T05:00:00Z',
      timezone: 'Europe/Moscow',
      station: {
        externalId: 'private-station',
        name: 'Терехово',
        courtExternalId: null,
        courtName: null,
      },
      capacity: 4,
      waitlistEnabled: true,
      paymentMode: 'SPLIT',
      levelFrom: null,
      levelTo: null,
      organizerExternalId: 'private-player',
      participants: [
        {
          externalId: 'private-player',
          displayName: 'Синтетическое имя',
          level: null,
          levelValue: null,
          role: 'ORGANIZER',
          paymentState: 'PAID',
          avatarSourceUrl: null,
        },
      ],
    };
  const row = {
    game_id: gameId,
    revision: 1,
    lifecycle_state: 'SCHEDULED',
    mode: 'CONFLICT',
    conflict_code: 'LEGACY_GAME_ROSTER_BASELINE_MISMATCH' as string | null,
    sync_revision: 1,
    sync_version: 'b'.repeat(64),
    source_aliases: ['private-source-game', 'raw-game'],
    participations: [['synthetic-participation', 'synthetic-user', 'ORGANIZER', 'ACTIVE', 'PAID']],
    previous_audits: [] as { revision: number; playerMappingsSha256: string }[],
  };
  const playerMappings = [
    {
      external_id: 'private-player',
      internal_id: '33333333-3333-4333-8333-333333333333',
      sync_status: 'synced',
      sync_error_code: null as string | null,
    },
  ];
  const query = vi.fn<(sql: string) => Promise<{ rows: unknown[] }>>((sql: string) =>
    Promise.resolve({
      rows: sql.includes("entity_type='game_player'")
        ? playerMappings
        : sql.includes('select g.id as game_id')
          ? [row]
          : [],
    }),
  );
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [{ id: tenantId }] }),
    connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
  };
  const rebaselineParticipants = vi.fn().mockResolvedValue({
    tenantId,
    rebaselined: [{ gameId, externalId: snapshot.externalId }],
    deferred: [],
    skipped: 0,
  });
  const readRosterByExternalIds = vi.fn().mockResolvedValue([snapshot]);
  const input = {
    pool: pool as never,
    source: { readRosterByExternalIds },
    repository: { rebaselineParticipants },
    tenantKey: 'local-padel',
    gameId,
    operationId: 'synthetic-operation-1',
    planOnly: true,
  };
  return {
    input,
    row,
    snapshot,
    playerMappings,
    query,
    rebaselineParticipants,
    readRosterByExternalIds,
  };
}
it('plans one canonical game without invoking the writer and prints no integration identity', async () => {
  const f = fixture(),
    plan = await exactLegacyGameRosterRepair(f.input);
  expect(plan).toMatchObject({
    status: 'PLAN',
    gameId,
    sourceParticipants: 1,
    allowLocalRemovals: false,
    authorizesDeploy: false,
  });
  expect(f.rebaselineParticipants).not.toHaveBeenCalled();
  expect(f.readRosterByExternalIds).toHaveBeenCalledExactlyOnceWith({
    externalIds: f.row.source_aliases,
    limit: 1,
  });
  expect(JSON.stringify(plan)).not.toMatch(
    /private-source|raw-game|private-player|Синтетическое имя/,
  );
});
it('applies only the reviewed hash through the fenced audited no-removal path', async () => {
  const f = fixture(),
    plan = await exactLegacyGameRosterRepair(f.input);
  const report = await exactLegacyGameRosterRepair({
    ...f.input,
    planOnly: false,
    expectedPlanSha256: plan.planSha256,
  });
  expect(report.status).toBe('REPAIRED');
  expect(f.rebaselineParticipants).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      allowLocalRemovals: false,
      expected: {
        gameId,
        revision: 1,
        sourceVersion: 'a'.repeat(64),
        syncSourceVersion: 'b'.repeat(64),
        playerMappingsSha256: attestExactRosterPlayerMappings(f.snapshot, f.playerMappings).sha256,
      },
      correlationId: `legacy-roster-repair:${f.input.operationId}:${plan.planSha256}`,
    }),
  );
});
it.each([
  'source-version',
  'participants',
  'revision',
  'quarantine',
  'cancelled',
  'mapping',
  'missing',
  'duplicate',
] as const)('stops %s drift before the writer', async (scenario) => {
  const f = fixture(),
    plan = await exactLegacyGameRosterRepair(f.input);
  if (scenario === 'source-version') f.snapshot.externalVersion = 'c'.repeat(64);
  if (scenario === 'participants')
    f.row.participations.push(['other', 'other-user', 'PLAYER', 'ACTIVE', 'PAID']);
  if (scenario === 'revision') f.row.revision = 2;
  if (scenario === 'quarantine') f.row.conflict_code = 'LEGACY_GAME_ROSTER_LOCAL_REVISION_CHANGED';
  if (scenario === 'cancelled') f.snapshot.cancelled = true;
  if (scenario === 'mapping') {
    f.snapshot.externalAliases = [];
    f.snapshot.externalId = 'other';
  }
  if (scenario === 'missing') f.readRosterByExternalIds.mockResolvedValue([]);
  if (scenario === 'duplicate')
    f.readRosterByExternalIds.mockResolvedValue([f.snapshot, f.snapshot]);
  await expect(
    exactLegacyGameRosterRepair({
      ...f.input,
      planOnly: false,
      expectedPlanSha256: plan.planSha256,
    }),
  ).rejects.toThrow(/LEGACY_GAME_EXACT_REPAIR_/);
  expect(f.rebaselineParticipants).not.toHaveBeenCalled();
});
it('recognizes a committed audited operation after lost acknowledgement without reapplying', async () => {
  const f = fixture(),
    plan = await exactLegacyGameRosterRepair(f.input);
  Object.assign(f.row, {
    revision: 2,
    sync_revision: 2,
    mode: 'MIRROR',
    conflict_code: null,
    sync_version: f.snapshot.externalVersion,
    previous_audits: [
      {
        revision: 2,
        playerMappingsSha256: attestExactRosterPlayerMappings(f.snapshot, f.playerMappings).sha256,
      },
    ],
  });
  expect(
    (
      await exactLegacyGameRosterRepair({
        ...f.input,
        planOnly: false,
        expectedPlanSha256: plan.planSha256,
      })
    ).status,
  ).toBe('ALREADY_REPAIRED');
  expect(f.rebaselineParticipants).not.toHaveBeenCalled();
});
it('requires exact CLI scope, stable operation and reviewed plan hash, forbidding removal or broad limits', () => {
  const args = [
    '--tenant-key',
    'local-padel',
    '--game-id',
    gameId,
    '--operation-id',
    'synthetic-operation-1',
  ];
  expect(parseRepairArguments([...args, '--plan'])).toMatchObject({
    gameId,
    planOnly: true,
    limit: 1,
    allowLocalRemovals: false,
  });
  expect(parseRepairArguments([...args, '--plan-sha', 'a'.repeat(64)])).toMatchObject({
    gameId,
    planOnly: false,
    expectedPlanSha256: 'a'.repeat(64),
  });
  for (const suffix of [
    [],
    ['--allow-local-removals', '--plan'],
    ['--limit', '2', '--plan'],
    ['--plan', '--plan-sha', 'a'.repeat(64)],
    ['--game-id', gameId, '--plan'],
  ])
    expect(() => parseRepairArguments([...args, ...suffix])).toThrow();
});

it('rejects a uniquely repointed player mapping between plan and apply', async () => {
  const f = fixture(),
    plan = await exactLegacyGameRosterRepair(f.input);
  f.playerMappings[0]!.internal_id = '44444444-4444-4444-8444-444444444444';
  await expect(
    exactLegacyGameRosterRepair({
      ...f.input,
      planOnly: false,
      expectedPlanSha256: plan.planSha256,
    }),
  ).rejects.toThrow('PLAN_DRIFT');
  expect(f.rebaselineParticipants).not.toHaveBeenCalled();
});
it.each(['unbound', 'conflicted'] as const)(
  'refuses an %s player identity before planning any write',
  async (scenario) => {
    const f = fixture();
    if (scenario === 'unbound') f.playerMappings.length = 0;
    else f.playerMappings[0]!.sync_status = 'conflict';
    await expect(exactLegacyGameRosterRepair(f.input)).rejects.toThrow('EXACT_REPAIR_IDENTITY');
    expect(f.rebaselineParticipants).not.toHaveBeenCalled();
  },
);
it('bounds DB connection, query, locks and idle transactions while keeping plans read-only', () => {
  expect(exactRosterRepairPoolOptions(true)).toMatchObject({
    connectionTimeoutMillis: 5000,
    query_timeout: 20000,
  });
  for (const setting of [
    'statement_timeout=15000',
    'lock_timeout=3000',
    'idle_in_transaction_session_timeout=20000',
    'default_transaction_read_only=on',
  ])
    expect(exactRosterRepairPoolOptions(true).options).toContain(setting);
  expect(exactRosterRepairPoolOptions(false).options).not.toContain(
    'default_transaction_read_only',
  );
});
it.each(['55P03', '57014'])(
  'reports SQL timeout %s without automatic retry or private errors',
  (code) => {
    expect(
      rosterRepairFailureReport(Object.assign(new Error('private source data'), { code })),
    ).toMatchObject({ status: 'STOP', automaticRetry: false });
    expect(
      JSON.stringify(
        rosterRepairFailureReport(Object.assign(new Error('private source data'), { code })),
      ),
    ).not.toContain('private source');
  },
);

function replacementFixture() {
  const f = fixture();
  f.snapshot.startsAt = '2099-11-16T06:00:00Z';
  f.snapshot.endsAt = '2099-11-16T07:00:00Z';
  f.snapshot.participants = Array.from({ length: 4 }, (_, i) => ({
    ...f.snapshot.participants[0]!,
    externalId: i === 0 ? 'private-player' : `source-${i}`,
    role: i === 0 ? ('ORGANIZER' as const) : ('PLAYER' as const),
  }));
  f.playerMappings.splice(
    0,
    1,
    ...f.snapshot.participants.map((p, i) => ({
      external_id: p.externalId,
      internal_id: `33333333-3333-4333-8333-33333333333${i}`,
      sync_status: 'synced',
      sync_error_code: null,
    })),
  );
  Object.assign(f.row, {
    starts_at: f.snapshot.startsAt,
    ends_at: f.snapshot.endsAt,
    capacity: 4,
    before_start: true,
    active_reservations: false,
    active_waitlist: false,
    conflict_code: 'LEGACY_GAME_ROSTER_REPAIR_REQUIRES_LOCAL_REMOVAL',
    participations: [
      ['old-1', 'old-user-1', 'ORGANIZER', 'ACTIVE', 'PAID'],
      ['old-2', 'old-user-2', 'PLAYER', 'ACTIVE', 'PAID'],
    ],
  });
  f.query.mockImplementation((sql: string) =>
    Promise.resolve({
      rows: sql.includes("entity_type='game_player'")
        ? f.playerMappings
        : sql.includes('select g.id as game_id')
          ? [f.row]
          : sql.includes('from identity.users')
            ? f.playerMappings.map((p) => ({ id: p.internal_id }))
            : sql.includes('from profile.user_summaries')
              ? f.playerMappings.map((p) => ({ user_id: p.internal_id }))
              : [],
    }),
  );
  return { ...f, input: { ...f.input, replaceSourceRoster: true } };
}
it('plans an explicit source4 replacement while retaining the two paid rows and keeping identifiers private', async () => {
  const f = replacementFixture();
  const plan = await exactLegacyGameRosterRepair(f.input);
  expect(plan).toMatchObject({
    schema: 'PHUB_EXACT_LEGACY_ROSTER_REPLACEMENT_V1',
    status: 'PLAN',
    sourceParticipants: 4,
    allowLocalRemovals: true,
    replacement: {
      retainedParticipationCount: 2,
      retainedPaidParticipationCount: 2,
      existingAccountsAndProfilesOnly: true,
      visibleHistoryGuaranteed: false,
    },
  });
  expect(f.rebaselineParticipants).not.toHaveBeenCalled();
  expect(JSON.stringify(plan)).not.toMatch(/old-user|old-1|private-player|Синтетическое имя/);
  expect(f.readRosterByExternalIds).toHaveBeenCalledExactlyOnceWith({
    externalIds: f.row.source_aliases,
    limit: 1,
    requirePaidRosterProof: true,
  });
  const report = await exactLegacyGameRosterRepair({
    ...f.input,
    planOnly: false,
    replacementConfirmed: true,
    expectedPlanSha256: plan.planSha256,
  });
  expect(report.status).toBe('REPAIRED');
  expect(f.rebaselineParticipants).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      allowLocalRemovals: true,
      snapshots: [f.snapshot],
      expected: {
        gameId,
        revision: 1,
        sourceVersion: f.snapshot.externalVersion,
        syncSourceVersion: f.row.sync_version,
        playerMappingsSha256: attestExactRosterPlayerMappings(f.snapshot, f.playerMappings).sha256,
        replacement: {
          participationsSha256: exactRosterValueSha256(
            exactRosterParticipations(f.row.participations),
          ),
          retainedParticipationIdsSha256: exactRosterValueSha256(['old-1', 'old-2']),
        },
      },
    }),
  );
});
it.each([
  'started',
  'time',
  'capacity',
  'missing-account',
  'missing-profile',
  'payment',
  'empty',
  'identity',
  'paid-drift',
  'reservation',
  'waitlist',
])('refuses replacement %s drift before invoking the writer', async (scenario) => {
  const f = replacementFixture();
  const plan = await exactLegacyGameRosterRepair(f.input);
  if (scenario === 'reservation') Object.assign(f.row, { active_reservations: true });
  if (scenario === 'waitlist') Object.assign(f.row, { active_waitlist: true });
  if (scenario === 'started') Object.assign(f.row, { before_start: false });
  if (scenario === 'time') f.snapshot.startsAt = '2099-11-16T07:00:00Z';
  if (scenario === 'capacity') f.snapshot.capacity = 2;
  if (scenario === 'payment') f.row.participations[1]![4] = 'PROCESSING';
  if (scenario === 'paid-drift') f.row.participations[1]![4] = 'NOT_REQUIRED';
  if (scenario === 'empty') f.row.participations.length = 0;
  if (scenario === 'identity')
    f.playerMappings[0]!.internal_id = '44444444-4444-4444-8444-444444444444';
  if (scenario === 'missing-account' || scenario === 'missing-profile') {
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation((sql: string) =>
      sql.includes(
        scenario === 'missing-account' ? 'from identity.users' : 'from profile.user_summaries',
      )
        ? Promise.resolve({ rows: [] })
        : original(sql),
    );
  }
  await expect(
    exactLegacyGameRosterRepair({
      ...f.input,
      planOnly: false,
      replacementConfirmed: true,
      expectedPlanSha256: plan.planSha256,
    }),
  ).rejects.toThrow(/LEGACY_GAME_EXACT_REPAIR_/);
  expect(f.rebaselineParticipants).not.toHaveBeenCalled();
});
it('requires independent replacement confirmation and excludes mixed CLI modes', () => {
  const args = [
    '--tenant-key',
    'local-padel',
    '--game-id',
    gameId,
    '--operation-id',
    'replace-source-1',
  ];
  expect(parseRepairArguments([...args, '--replace-source-roster', '--plan'])).toMatchObject({
    replaceSourceRoster: true,
    planOnly: true,
    replacementConfirmed: false,
  });
  expect(
    parseRepairArguments([
      ...args,
      '--replace-source-roster',
      '--plan-sha',
      'a'.repeat(64),
      '--confirm',
      EXACT_SOURCE_REPLACEMENT_CONFIRMATION,
    ]),
  ).toMatchObject({ replaceSourceRoster: true, replacementConfirmed: true, planOnly: false });
  for (const suffix of [
    ['--replace-source-roster', '--plan-sha', 'a'.repeat(64)],
    ['--replace-source-roster', '--plan', '--confirm', EXACT_SOURCE_REPLACEMENT_CONFIRMATION],
    ['--plan-sha', 'a'.repeat(64), '--confirm', EXACT_SOURCE_REPLACEMENT_CONFIRMATION],
    ['--replace-source-roster', '--plan-sha', 'a'.repeat(64), '--confirm', 'yes'],
    ['--replace-source-roster', '--plan', '--limit', '1'],
    ['--replace-source-roster', '--plan', '--replace-source-roster'],
  ])
    expect(() => parseRepairArguments([...args, ...suffix])).toThrow();
});
it.each(['same', 'wrong-plan', 'paid-change', 'new-plan'])(
  'handles replacement lost-ACK readback %s without repeating a mutation',
  async (scenario) => {
    const f = replacementFixture();
    const plan = await exactLegacyGameRosterRepair(f.input);
    const post = f.row.participations.map((p) => [...p]);
    post.forEach((p) => {
      p[3] = 'LEFT';
    });
    post.push(
      ...f.playerMappings.map((p, i) => [
        `new-${i}`,
        p.internal_id,
        i === 0 ? 'ORGANIZER' : 'PLAYER',
        'ACTIVE',
        'PAID',
      ]),
    );
    Object.assign(f.row, {
      revision: 2,
      sync_revision: 2,
      mode: 'MIRROR',
      conflict_code: null,
      sync_version: f.snapshot.externalVersion,
      participations: post,
      previous_audits: [
        {
          revision: 2,
          playerMappingsSha256: attestExactRosterPlayerMappings(f.snapshot, f.playerMappings)
            .sha256,
          correlationId: `legacy-roster-repair:${f.input.operationId}:${plan.planSha256}`,
          replacement: {
            participationsBeforeSha256: plan.replacement!.participationsBeforeSha256,
            participationsAfterSha256: exactRosterValueSha256(exactRosterParticipations(post)),
            retainedParticipationIdsSha256: plan.replacement!.retainedParticipationIdsSha256,
            retainedParticipationCount: 2,
            retainedPaidParticipationCount: 2,
          },
        },
      ],
    });
    if (scenario === 'paid-change') post[0]![4] = 'NOT_REQUIRED';
    const request = {
      ...f.input,
      planOnly: scenario === 'new-plan',
      replacementConfirmed: scenario !== 'new-plan',
      ...(scenario === 'new-plan'
        ? {}
        : { expectedPlanSha256: scenario === 'wrong-plan' ? 'e'.repeat(64) : plan.planSha256 }),
    };
    if (scenario === 'same')
      expect((await exactLegacyGameRosterRepair(request)).status).toBe('ALREADY_REPAIRED');
    else
      await expect(exactLegacyGameRosterRepair(request)).rejects.toThrow('PREVIOUS_OUTCOME_DRIFT');
    expect(f.rebaselineParticipants).not.toHaveBeenCalled();
  },
);
