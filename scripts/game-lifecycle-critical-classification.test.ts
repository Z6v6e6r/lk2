import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

type Classification = 'CRITICAL' | 'IMPORTANT' | 'EDGE';

const matrixPath = resolve(
  process.cwd(),
  'docs/audits/game-lifecycle-2026-08-28/process-matrix.csv',
);

function range(prefix: string, start: number, end: number): string[] {
  return Array.from(
    { length: end - start + 1 },
    (_, index) => `${prefix}-${String(start + index).padStart(3, '0')}`,
  );
}

export const CRITICAL_GAME_SCENARIOS = new Set([
  // Canonical readback and permission boundaries used after every write.
  'A-004',
  'A-005',
  'A-008',
  'A-010',
  'A-013',
  'A-014',
  // Free create, invalid/dependency failures, replay and projection/readback.
  'B-001',
  ...range('B', 11, 15),
  ...range('B', 17, 21),
  'B-023',
  // Free join, missing/terminal/full guards, replay and operation/readback.
  'E-001',
  'E-002',
  'E-003',
  'E-006',
  'E-007',
  'E-008',
  'E-010',
  'E-013',
  'E-033',
  'E-035',
  'E-036',
  'E-037',
  'E-040',
  // Free leave, owner policy, repeated leave and durable history.
  ...range('G', 1, 7),
  'G-022',
  // Free cancel, actor policy, after-start/terminal guards and canonical effects.
  'H-001',
  'H-003',
  'H-004',
  'H-005',
  'H-007',
  'H-023',
  'H-024',
  'H-025',
  'H-029',
  // Retry, rollback/crash, last-slot concurrency and tenant/actor isolation.
  ...range('K', 1, 8),
  'K-022',
  'K-023',
]);

export const IMPORTANT_GAME_SCENARIOS = new Set([
  // Paid reservation expiry stays blocked until generation/payment fencing exists.
  'E-027',
  'E-028',
  // Free waitlist, promotion and notification trigger subset.
  ...range('F', 1, 19),
  'G-029',
  'H-022',
  'H-021',
  'H-026',
  // Outbox/process recovery, expiry and promotion recovery.
  ...range('K', 9, 14),
]);

type CriticalEvidenceMode = 'UNIT' | 'HTTP_POSTGRES' | 'POSTGRES_RLS';

type CriticalEvidenceRecord = Readonly<{
  scenarioId: string;
  expected: string;
  mode: CriticalEvidenceMode;
  assertion: Readonly<{ file: string; testName: string }>;
}>;

function pass(
  scenarioId: string,
  mode: CriticalEvidenceMode,
  file: string,
  testName: string,
  expected: string,
): CriticalEvidenceRecord {
  return { scenarioId, mode, assertion: { file, testName }, expected };
}

const http = 'apps/api/src/games/game-lifecycle-http-postgres.test.ts';
const recovery = 'packages/database/src/game-create-recovery-postgres.test.ts';
const gameRepository = 'packages/database/src/game-repository.test.ts';
const rosterRepository = 'packages/database/src/game-roster-repository.test.ts';

export const CRITICAL_GAME_EVIDENCE: readonly CriticalEvidenceRecord[] = [
  pass(
    'A-004',
    'UNIT',
    'apps/api/src/games/game-read-routes.test.ts',
    'returns an anonymous public card without PadlHub user identifiers',
    'public detail is visible without internal user identifiers',
  ),
  pass(
    'A-005',
    'UNIT',
    'apps/api/src/games/game-read-routes.test.ts',
    'fails closed for unconfigured reads, allows public discovery detail and hides private games',
    'authenticated detail applies viewer visibility policy',
  ),
  pass(
    'A-008',
    'POSTGRES_RLS',
    recovery,
    'enforces forced tenant RLS under a temporary NOSUPERUSER NOBYPASSRLS NOINHERIT role',
    'foreign tenant aggregate is not readable or mutable',
  ),
  pass(
    'A-010',
    'HTTP_POSTGRES',
    http,
    'leaves and cancels with idempotent terminal state and owner-only authorization',
    'cancelled projection is visible in detail and owner history as CANCELLED',
  ),
  pass(
    'A-013',
    'UNIT',
    'apps/web/src/game-revision-readback.test.ts',
    'distinguishes a stale read model from a temporarily unavailable readback',
    'stale projection is explicit and does not masquerade as fresh state',
  ),
  pass(
    'A-014',
    'UNIT',
    'apps/web/src/game-revision-readback.test.ts',
    'waits beyond the former two-second polling window until the projection catches up',
    'read-after-write waits for the required revision',
  ),
  pass(
    'B-001',
    'HTTP_POSTGRES',
    http,
    'creates durably, replays the exact command, and rejects invalid or changed-key requests',
    'free create commits canonical state',
  ),
  pass(
    'B-011',
    'UNIT',
    gameRepository,
    'rejects an unmapped or reversed canonical range before creating aggregate state',
    'inverted level range is rejected before writes',
  ),
  pass(
    'B-012',
    'HTTP_POSTGRES',
    recovery,
    'rejects a new past-start key without any durable command or side effect',
    'past start is rejected with zero durable state',
  ),
  pass(
    'B-013',
    'HTTP_POSTGRES',
    http,
    'creates durably, replays the exact command, and rejects invalid or changed-key requests',
    'end-before-start payload is rejected before persistence',
  ),
  pass(
    'B-014',
    'HTTP_POSTGRES',
    http,
    'creates durably, replays the exact command, and rejects invalid or changed-key requests',
    'invalid timezone is rejected before persistence',
  ),
  pass(
    'B-015',
    'UNIT',
    gameRepository,
    'rejects a missing or foreign station before admission with zero durable side effects',
    'unknown or foreign station is fail-closed',
  ),
  pass(
    'B-017',
    'HTTP_POSTGRES',
    recovery,
    'serializes concurrent same-key creates into one game and one replay',
    'double create intent produces one aggregate',
  ),
  pass(
    'B-018',
    'HTTP_POSTGRES',
    recovery,
    'replays a committed create after startsAt passes and conflicts before admission',
    'lost create response replays committed result',
  ),
  pass(
    'B-019',
    'HTTP_POSTGRES',
    http,
    'creates durably, replays the exact command, and rejects invalid or changed-key requests',
    'same create key and payload replays exactly',
  ),
  pass(
    'B-020',
    'HTTP_POSTGRES',
    http,
    'creates durably, replays the exact command, and rejects invalid or changed-key requests',
    'same create key with changed payload conflicts',
  ),
  pass(
    'B-021',
    'HTTP_POSTGRES',
    http,
    'rolls back every create side effect when the transactional outbox write fails',
    'dependency failure rolls back aggregate command audit and outbox',
  ),
  pass(
    'B-023',
    'UNIT',
    'apps/web/src/game-revision-readback.test.ts',
    'waits beyond the former two-second polling window until the projection catches up',
    'create projection lag is revision-fenced',
  ),
  pass(
    'E-001',
    'HTTP_POSTGRES',
    http,
    'enforces join revisions, retries, permission and actor-scoped operation readback',
    'free join creates one active participation',
  ),
  pass(
    'E-002',
    'HTTP_POSTGRES',
    http,
    'serializes two HTTP joins for the final free seat without overflow or duplicates',
    'one join takes the final free seat',
  ),
  pass(
    'E-003',
    'HTTP_POSTGRES',
    recovery,
    'serializes two physical last-seat joins and rejects the loser without overflow',
    'two last-seat claims have exactly one winner',
  ),
  pass(
    'E-006',
    'HTTP_POSTGRES',
    http,
    'enforces join revisions, retries, permission and actor-scoped operation readback',
    'stale expected revision conflicts',
  ),
  pass(
    'E-007',
    'HTTP_POSTGRES',
    http,
    'enforces join revisions, retries, permission and actor-scoped operation readback',
    'missing game returns stable not-found',
  ),
  pass(
    'E-008',
    'HTTP_POSTGRES',
    http,
    'leaves and cancels with idempotent terminal state and owner-only authorization',
    'cancelled game rejects join',
  ),
  pass(
    'E-010',
    'HTTP_POSTGRES',
    http,
    'enforces join revisions, retries, permission and actor-scoped operation readback',
    'active participant cannot join twice',
  ),
  pass(
    'E-013',
    'HTTP_POSTGRES',
    http,
    'serializes two HTTP joins for the final free seat without overflow or duplicates',
    'full game returns GAME_FULL without overflow',
  ),
  pass(
    'E-033',
    'HTTP_POSTGRES',
    http,
    'enforces join revisions, retries, permission and actor-scoped operation readback',
    'join operation is readable only by its actor',
  ),
  pass(
    'E-035',
    'HTTP_POSTGRES',
    http,
    'enforces join revisions, retries, permission and actor-scoped operation readback',
    'lost join response replays the committed command',
  ),
  pass(
    'E-036',
    'UNIT',
    rosterRepository,
    'replays the original command result and rejects cross-request key reuse',
    'join key with changed request conflicts',
  ),
  pass(
    'E-037',
    'UNIT',
    'apps/web/src/game-revision-readback.test.ts',
    'distinguishes a stale read model from a temporarily unavailable readback',
    'join projection lag remains explicit',
  ),
  pass(
    'E-040',
    'UNIT',
    'apps/api/src/games/game-routes.test.ts',
    'fails closed while the production Games repository is not injected',
    'unavailable roster repository fails closed',
  ),
  pass(
    'G-001',
    'HTTP_POSTGRES',
    http,
    'leaves and cancels with idempotent terminal state and owner-only authorization',
    'participant leaves before cutoff',
  ),
  pass(
    'G-002',
    'UNIT',
    'packages/games/src/join-policy.test.ts',
    'rejects leave after cut-off',
    'leave at or after cutoff is rejected',
  ),
  pass(
    'G-003',
    'UNIT',
    'packages/games/src/join-policy.test.ts',
    'rejects leave after cut-off',
    'leave after start is rejected by the temporal policy',
  ),
  pass(
    'G-004',
    'HTTP_POSTGRES',
    http,
    'leaves and cancels with idempotent terminal state and owner-only authorization',
    'organizer must cancel instead of leaving',
  ),
  pass(
    'G-005',
    'HTTP_POSTGRES',
    http,
    'leaves and cancels with idempotent terminal state and owner-only authorization',
    'same leave key replays and a new repeat is rejected',
  ),
  pass(
    'G-006',
    'HTTP_POSTGRES',
    http,
    'leaves and cancels with idempotent terminal state and owner-only authorization',
    'leave releases capacity with durable readback',
  ),
  pass(
    'G-007',
    'HTTP_POSTGRES',
    http,
    'proves both serialized promotion-before-cancel and cancel-before-promotion orders',
    'leave from full roster schedules a replayable promotion',
  ),
  pass(
    'G-022',
    'HTTP_POSTGRES',
    http,
    'leaves and cancels with idempotent terminal state and owner-only authorization',
    'successful leave has one audit record and durable history',
  ),
  pass(
    'H-001',
    'HTTP_POSTGRES',
    http,
    'leaves and cancels with idempotent terminal state and owner-only authorization',
    'organizer cancels a free scheduled game',
  ),
  pass(
    'H-003',
    'HTTP_POSTGRES',
    http,
    'leaves and cancels with idempotent terminal state and owner-only authorization',
    'non-organizer cancellation is rejected and audited',
  ),
  pass(
    'H-004',
    'HTTP_POSTGRES',
    http,
    'leaves and cancels with idempotent terminal state and owner-only authorization',
    'same cancel key replays without duplicate effects',
  ),
  pass(
    'H-005',
    'HTTP_POSTGRES',
    http,
    'leaves and cancels with idempotent terminal state and owner-only authorization',
    'cancel terminal result is stable under retry',
  ),
  pass(
    'H-007',
    'HTTP_POSTGRES',
    http,
    'leaves and cancels with idempotent terminal state and owner-only authorization',
    'admin role alone does not bypass owner-only user cancellation',
  ),
  pass(
    'H-023',
    'HTTP_POSTGRES',
    http,
    'rejects cancellation after start and from a finished terminal state',
    'database clock rejects cancellation after start',
  ),
  pass(
    'H-024',
    'HTTP_POSTGRES',
    http,
    'rejects cancellation after start and from a finished terminal state',
    'finished game rejects cancellation',
  ),
  pass(
    'H-025',
    'HTTP_POSTGRES',
    http,
    'leaves and cancels with idempotent terminal state and owner-only authorization',
    'cancel commits one transactional game.cancelled event',
  ),
  pass(
    'H-029',
    'HTTP_POSTGRES',
    http,
    'leaves and cancels with idempotent terminal state and owner-only authorization',
    'cancel event projects a CANCELLED card and readback',
  ),
  pass(
    'K-001',
    'UNIT',
    rosterRepository,
    'replays the original command result and rejects cross-request key reuse',
    'duplicate roster command replays once',
  ),
  pass(
    'K-002',
    'UNIT',
    rosterRepository,
    'replays the original command result and rejects cross-request key reuse',
    'reused key with different request conflicts',
  ),
  pass(
    'K-003',
    'HTTP_POSTGRES',
    http,
    'enforces join revisions, retries, permission and actor-scoped operation readback',
    'lost HTTP response is recoverable by same-key replay',
  ),
  pass(
    'K-004',
    'HTTP_POSTGRES',
    http,
    'enforces join revisions, retries, permission and actor-scoped operation readback',
    'stale roster revision conflicts without mutation',
  ),
  pass(
    'K-005',
    'HTTP_POSTGRES',
    http,
    'serializes same-user concurrent joins without duplicate membership',
    'same-user concurrent commands create one membership',
  ),
  pass(
    'K-006',
    'HTTP_POSTGRES',
    recovery,
    'serializes two physical last-seat joins and rejects the loser without overflow',
    'different-user contention never exceeds capacity',
  ),
  pass(
    'K-007',
    'HTTP_POSTGRES',
    http,
    'rolls back every create side effect when the transactional outbox write fails',
    'transaction failure leaves no partial lifecycle state',
  ),
  pass(
    'K-008',
    'HTTP_POSTGRES',
    recovery,
    'replays a committed create after startsAt passes and conflicts before admission',
    'post-commit process loss recovers from durable idempotency',
  ),
  pass(
    'K-022',
    'POSTGRES_RLS',
    recovery,
    'enforces forced tenant RLS under a temporary NOSUPERUSER NOBYPASSRLS NOINHERIT role',
    'RLS blocks cross-tenant mutation',
  ),
  pass(
    'K-023',
    'HTTP_POSTGRES',
    http,
    'enforces join revisions, retries, permission and actor-scoped operation readback',
    'unauthorized mutation and foreign operation readback are denied',
  ),
];

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  if (quoted) throw new Error('GAME_LIFECYCLE_MATRIX_UNTERMINATED_QUOTE');
  return rows;
}

export function classifyGameScenario(scenarioId: string): Classification {
  if (CRITICAL_GAME_SCENARIOS.has(scenarioId)) return 'CRITICAL';
  if (IMPORTANT_GAME_SCENARIOS.has(scenarioId)) return 'IMPORTANT';
  return 'EDGE';
}

describe('Game Lifecycle Atlas critical classification', () => {
  it('keeps paid join fail-closed until the expiry and payment recovery contour exists', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'packages/database/src/game-roster-repository.ts'),
      'utf8',
    );
    const joinStart = source.indexOf('    join(input) {');
    const confirmPaymentStart = source.indexOf('    confirmPayment(input) {', joinStart);
    expect(joinStart).toBeGreaterThan(-1);
    expect(confirmPaymentStart).toBeGreaterThan(joinStart);
    const joinSource = source.slice(joinStart, confirmPaymentStart);
    expect(joinSource).toContain("prepared.game.payment_mode === 'SPLIT'");
    expect(joinSource).toContain("prepared.game.payment_mode === 'SUBSCRIPTION'");
    expect(joinSource).toContain("'GAME_PAYMENT_REQUIRED'");
    expect(joinSource).not.toContain('insert into games.seat_reservations');
    expect(joinSource).not.toContain('insert into eligibility.payment_snapshots');
    expect(joinSource).not.toContain('game.reservation.expire.v1');
    expect(joinSource).not.toContain('game.participation.reserved.v1');
  });

  it('classifies every one of the 344 canonical scenarios exactly once', () => {
    const [header, ...rows] = parseCsv(readFileSync(matrixPath, 'utf8'));
    if (!header) throw new Error('GAME_LIFECYCLE_MATRIX_HEADER_MISSING');
    expect(header).toHaveLength(101);
    expect(rows).toHaveLength(344);
    expect(rows.every((row) => row.length === header.length)).toBe(true);

    const scenarioIds = rows.map((row) => row[0]);
    expect(new Set(scenarioIds).size).toBe(344);
    expect([...CRITICAL_GAME_SCENARIOS].every((id) => scenarioIds.includes(id))).toBe(true);
    expect([...IMPORTANT_GAME_SCENARIOS].every((id) => scenarioIds.includes(id))).toBe(true);
    expect([...CRITICAL_GAME_SCENARIOS].filter((id) => IMPORTANT_GAME_SCENARIOS.has(id))).toEqual(
      [],
    );

    const counts = rows.reduce<Record<Classification, number>>(
      (current, row) => {
        current[classifyGameScenario(row[0] ?? '')] += 1;
        return current;
      },
      { CRITICAL: 0, IMPORTANT: 0, EDGE: 0 },
    );
    expect(counts).toEqual({ CRITICAL: 58, IMPORTANT: 31, EDGE: 255 });
  });

  it('keeps the mandatory core, retry, permission and Important subsets explicit', () => {
    expect(
      [
        'B-001',
        'B-011',
        'B-017',
        'B-021',
        'B-023',
        'E-001',
        'E-002',
        'E-003',
        'E-006',
        'E-008',
        'E-010',
        'E-013',
        'E-035',
        'E-036',
        'G-001',
        'G-004',
        'G-005',
        'G-022',
        'H-001',
        'H-003',
        'H-004',
        'H-023',
        'K-001',
        'K-006',
        'K-022',
        'K-023',
      ].map(classifyGameScenario),
    ).toEqual(Array.from({ length: 26 }, () => 'CRITICAL'));
    expect(
      ['E-027', 'E-028', 'F-001', 'F-011', 'F-017', 'F-019', 'K-013', 'K-014'].map(
        classifyGameScenario,
      ),
    ).toEqual(Array.from({ length: 8 }, () => 'IMPORTANT'));
  });

  it('maps every Critical scenario exactly once to an explicit expected executable result', () => {
    const mappedScenarioIds = CRITICAL_GAME_EVIDENCE.map((record) => record.scenarioId);
    expect(new Set(mappedScenarioIds).size).toBe(mappedScenarioIds.length);
    expect([...mappedScenarioIds].sort()).toEqual([...CRITICAL_GAME_SCENARIOS].sort());
    expect(CRITICAL_GAME_EVIDENCE).toHaveLength(58);

    for (const record of CRITICAL_GAME_EVIDENCE) {
      expect(record.expected.length).toBeGreaterThan(10);
      const { file, testName } = record.assertion;
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(source, `${record.scenarioId}: ${file} must retain ${testName}`).toContain(testName);
    }
  });
});
