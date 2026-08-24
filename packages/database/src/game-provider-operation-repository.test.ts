import { describe, expect, it, vi } from 'vitest';

import {
  createGameProviderIntent,
  createGameProviderOperationRepository,
} from './game-provider-operation-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const operationId = '750209e0-6097-4bd2-8cba-6ac203829e41';
const commandId = '21ad9428-4218-48d7-9acd-5b6661bb0155';
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const gameId = '95a76d36-d8a7-4ff5-a988-84f33c0fd05a';
const reservationId = '840f475e-686d-44fa-9729-bc073bce3c2c';
const decisionId = '1cd7e4c9-9d72-49d0-bf27-af4f2ec96eb5';

function pool(query: ReturnType<typeof vi.fn>) {
  return { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: operationId,
    source_command_id: commandId,
    action: 'JOIN_PAYMENT',
    provider_idempotency_key: `game-provider-${operationId}`,
    correlation_id: 'provider-recovery-test-0001',
    request_hash: 'a'.repeat(64),
    actor_user_id: actorUserId,
    game_id: gameId,
    reservation_id: reservationId,
    waitlist_entry_id: null,
    eligibility_decision_id: decisionId,
    payment_snapshot_operation_id: commandId,
    payment_mode: 'SPLIT',
    provider_exercise_id: null,
    expected_amount_minor: null,
    expected_currency: null,
    state: 'RECONCILING',
    submit_attempts: 1,
    readback_attempts: 1,
    lease_token: '82bb8882-72b3-4c13-b422-4671821776f8',
    last_error_class: null,
    local_aggregate_revision: null,
    updated_at: '2026-08-24T18:00:00.000Z',
    ...overrides,
  };
}

function matchedFacts(overrides: Record<string, unknown> = {}) {
  return {
    providerContractVersion: 'synthetic-v1' as const,
    terminalStatus: 'PAID' as const,
    tenantRef: `synthetic:tenant:${tenantId}`,
    actorRef: `synthetic:actor:${actorUserId}`,
    gameRef: `synthetic:game:${gameId}`,
    reservationRef: `synthetic:reservation:${reservationId}`,
    paymentMode: 'SPLIT' as const,
    ...overrides,
  };
}

function aggregateLockResult(text: string, operation = row()) {
  if (text.includes('select game_id from integration.game_provider_operations')) {
    return { rows: [{ game_id: gameId }], rowCount: 1 };
  }
  if (text.includes('select lifecycle_state, revision, now() as database_now')) {
    return {
      rows: [
        {
          lifecycle_state: 'SCHEDULED',
          revision: 8,
          database_now: '2026-08-24T18:00:00.000Z',
        },
      ],
      rowCount: 1,
    };
  }
  if (text.includes('select * from integration.game_provider_operations')) {
    return { rows: [operation], rowCount: 1 };
  }
  return undefined;
}

describe('game provider operation repository', () => {
  it('persists a durable synthetic intent and bounded audit facts', async () => {
    const query = vi.fn((text: string) => {
      if (text.includes('insert into integration.game_provider_operations')) {
        return Promise.resolve({ rows: [{ id: operationId }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    await expect(
      createGameProviderIntent({ query } as never, {
        tenantId,
        sourceCommandId: commandId,
        action: 'JOIN_PAYMENT',
        actorUserId,
        gameId,
        reservationId,
        eligibilityDecisionId: decisionId,
        paymentSnapshotOperationId: commandId,
        paymentMode: 'SPLIT',
        correlationId: 'provider-recovery-test-0001',
      }),
    ).resolves.toBe(operationId);
    expect(query.mock.calls.some(([text]) => text.includes("'SYNTHETIC', 'synthetic-v1'"))).toBe(
      true,
    );
    expect(query.mock.calls.some(([text]) => text.includes('GAME_PROVIDER_INTENT_CREATED'))).toBe(
      true,
    );
  });

  it('claims at most one due operation with a fenced lease and SKIP LOCKED', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('returning operation.*')) {
        return Promise.resolve({
          rows: [row({ state: 'SUBMITTING', submit_attempts: 2 })],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const claimed = await createGameProviderOperationRepository(pool(query) as never).claimSubmit({
      tenantId,
      leaseSeconds: 30,
      maxAttempts: 3,
    });
    expect(claimed).toMatchObject({ state: 'SUBMITTING', attempt: 2, expected: { tenantId } });
    expect(query.mock.calls.some(([text]) => text.includes('for update skip locked limit 1'))).toBe(
      true,
    );
    expect(
      query.mock.calls.some(([text]) =>
        text.includes("state = 'SUBMITTING' and lease_expires_at <= now()"),
      ),
    ).toBe(true);
  });

  it('rejects an intent replay whose immutable facts do not match', async () => {
    const query = vi.fn((text: string) => {
      if (text.includes('insert into integration.game_provider_operations'))
        return Promise.resolve({ rows: [], rowCount: 0 });
      if (text.includes('select id, request_hash'))
        return Promise.resolve({
          rows: [{ id: operationId, request_hash: 'f'.repeat(64) }],
          rowCount: 1,
        });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    await expect(
      createGameProviderIntent({ query } as never, {
        tenantId,
        sourceCommandId: commandId,
        action: 'JOIN_PAYMENT',
        actorUserId,
        gameId,
        reservationId,
        eligibilityDecisionId: decisionId,
        paymentSnapshotOperationId: commandId,
        paymentMode: 'SPLIT',
        correlationId: 'provider-recovery-test-0001',
      }),
    ).rejects.toThrow('GAME_PROVIDER_INTENT_IDEMPOTENCY_CONFLICT');
    expect(query.mock.calls.some(([text]) => text.includes('GAME_PROVIDER_INTENT_CREATED'))).toBe(
      false,
    );
  });

  it('records synchronous acceptance as unknown and requires read-back before local apply', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'"))
        return Promise.resolve({ rows: [], rowCount: 0 });
      const locked = aggregateLockResult(text, row({ state: 'SUBMITTING' }));
      if (locked) return Promise.resolve(locked);
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    await expect(
      createGameProviderOperationRepository(pool(query) as never).completeSubmit({
        tenantId,
        operationId,
        leaseToken: row().lease_token,
        startedAt: '2026-08-24T18:00:00.000Z',
        result: {
          outcome: 'ACCEPTED',
          providerOperationId: 'synthetic:accepted-1',
          evidenceHash: 'accepted-evidence',
        },
        maxAttempts: 3,
      }),
    ).resolves.toBe('applied');
    expect(
      (query.mock.calls as unknown as Array<[string, readonly unknown[] | undefined]>).some(
        ([text, values]) =>
          text.includes('update integration.game_provider_operations') &&
          values?.includes('UNKNOWN'),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(([text]) => text.includes('insert into games.participations')),
    ).toBe(false);
  });

  it('applies an exact accepted read-back once without rewriting immutable eligibility facts', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      const locked = aggregateLockResult(text);
      if (locked) return Promise.resolve(locked);
      if (text.includes('from games.seat_reservations reservation')) {
        return Promise.resolve({
          rows: [
            {
              state: 'ACTIVE',
              payment_state: 'REQUIRES_ACTION',
              expires_at: '2026-08-24T18:15:00.000Z',
              eligibility_decision_id: decisionId,
              participation_id: null,
              participation_decision_id: null,
              participation_payment_state: null,
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('insert into games.participations')) {
        return Promise.resolve({
          rows: [{ id: '45bb3901-346c-4535-a70a-b7010125fb2b' }],
          rowCount: 1,
        });
      }
      if (text.includes('update games.games set revision')) {
        return Promise.resolve({ rows: [{ revision: 9 }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const result = await createGameProviderOperationRepository(
      pool(query) as never,
    ).completeReadBack({
      tenantId,
      operationId,
      leaseToken: row().lease_token,
      startedAt: '2026-08-24T18:00:00.000Z',
      result: {
        outcome: 'MATCHED_ACCEPTED',
        providerOperationId: 'synthetic:accepted-1',
        evidenceHash: 'accepted-evidence',
        facts: matchedFacts(),
      },
      maxAttempts: 8,
    });
    expect(result).toBe('applied');
    expect(
      query.mock.calls.some(([text]) => text.includes('insert into games.participations')),
    ).toBe(true);
    expect(
      query.mock.calls.some(([text]) =>
        text.includes("state = 'CONFIRMED', payment_state = 'PAID'"),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(([text]) =>
        /update\s+eligibility\.(decisions|payment_snapshots)/i.test(text),
      ),
    ).toBe(false);
    expect(
      query.mock.calls.some(([text]) => text.includes('game.participation.confirmed.v1')),
    ).toBe(true);
  });

  it('holds a late accepted payment for manual review instead of reviving an expired seat', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'"))
        return Promise.resolve({ rows: [], rowCount: 0 });
      const locked = aggregateLockResult(text);
      if (locked) return Promise.resolve(locked);
      if (text.includes('from games.seat_reservations reservation')) {
        return Promise.resolve({
          rows: [
            {
              state: 'ACTIVE',
              payment_state: 'PROCESSING',
              expires_at: '2026-08-24T17:59:59.000Z',
              eligibility_decision_id: decisionId,
              participation_id: null,
              participation_decision_id: null,
              participation_payment_state: null,
            },
          ],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    await createGameProviderOperationRepository(pool(query) as never).completeReadBack({
      tenantId,
      operationId,
      leaseToken: row().lease_token,
      startedAt: '2026-08-24T18:00:00.000Z',
      result: {
        outcome: 'MATCHED_ACCEPTED',
        providerOperationId: 'synthetic:accepted-late',
        evidenceHash: 'accepted-evidence-late',
        facts: matchedFacts(),
      },
      maxAttempts: 8,
    });
    expect(
      query.mock.calls.some(([text]) => text.includes('insert into games.participations')),
    ).toBe(false);
    expect(
      (query.mock.calls as unknown as Array<[string, readonly unknown[] | undefined]>).some(
        ([text, values]) =>
          text.includes('update integration.game_provider_operations') &&
          values?.includes('MANUAL_REVIEW') &&
          values?.includes('REFERENCE_MISMATCH'),
      ),
    ).toBe(true);
  });

  it('releases the reservation and schedules promotion after definitive rejection', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'"))
        return Promise.resolve({ rows: [], rowCount: 0 });
      const locked = aggregateLockResult(text, row({ state: 'SUBMITTING' }));
      if (locked) return Promise.resolve(locked);
      if (text.includes('select state, user_id from games.seat_reservations'))
        return Promise.resolve({
          rows: [{ state: 'ACTIVE', user_id: actorUserId }],
          rowCount: 1,
        });
      if (text.includes('update games.games set revision'))
        return Promise.resolve({ rows: [{ revision: 9 }], rowCount: 1 });
      if (text.includes('select id from games.waitlist_entries'))
        return Promise.resolve({
          rows: [{ id: 'b0ced1bc-629c-414d-b977-af39122d30cb' }],
          rowCount: 1,
        });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    await createGameProviderOperationRepository(pool(query) as never).completeSubmit({
      tenantId,
      operationId,
      leaseToken: row().lease_token,
      startedAt: '2026-08-24T18:00:00.000Z',
      result: { outcome: 'REJECTED', code: 'DECLINED', evidenceHash: 'rejected-evidence' },
      maxAttempts: 3,
    });
    expect(
      query.mock.calls.some(([text]) =>
        text.includes("state = 'CANCELLED', payment_state = 'FAILED'"),
      ),
    ).toBe(true);
    expect(query.mock.calls.some(([text]) => text.includes("'game.waitlist.promote.v1'"))).toBe(
      true,
    );
  });

  it.each([
    ['tenant', { tenantRef: 'synthetic:tenant:wrong' }, 'TENANT_MISMATCH'],
    ['actor', { actorRef: 'synthetic:actor:wrong' }, 'ACTOR_MISMATCH'],
    ['game', { gameRef: 'synthetic:game:wrong' }, 'GAME_MISMATCH'],
    ['reference', { reservationRef: 'synthetic:reservation:wrong' }, 'REFERENCE_MISMATCH'],
  ] as const)('refuses %s mismatch before local apply', async (_label, overrides, mismatch) => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'"))
        return Promise.resolve({ rows: [], rowCount: 0 });
      const locked = aggregateLockResult(text);
      if (locked) return Promise.resolve(locked);
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    await createGameProviderOperationRepository(pool(query) as never).completeReadBack({
      tenantId,
      operationId,
      leaseToken: row().lease_token,
      startedAt: '2026-08-24T18:00:00.000Z',
      result: {
        outcome: 'MATCHED_ACCEPTED',
        providerOperationId: 'synthetic:accepted-1',
        evidenceHash: 'accepted-evidence',
        facts: matchedFacts(overrides),
      },
      maxAttempts: 8,
    });
    expect(
      query.mock.calls.some(([text]) => text.includes('insert into games.participations')),
    ).toBe(false);
    expect(
      (query.mock.calls as unknown as Array<[string, readonly unknown[] | undefined]>).some(
        ([text, values]) =>
          text.includes('game_provider_operation_attempts') && values?.includes(mismatch),
      ),
    ).toBe(true);
  });

  it('moves an idle unknown callback through a constraint-valid reconciliation lease', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'"))
        return Promise.resolve({ rows: [], rowCount: 0 });
      const locked = aggregateLockResult(text, row({ state: 'UNKNOWN', lease_token: null }));
      if (locked) return Promise.resolve(locked);
      if (text.includes('from games.seat_reservations reservation')) {
        return Promise.resolve({
          rows: [
            {
              state: 'ACTIVE',
              payment_state: 'PROCESSING',
              expires_at: '2026-08-24T18:15:00.000Z',
              eligibility_decision_id: decisionId,
              participation_id: null,
              participation_decision_id: null,
              participation_payment_state: null,
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('insert into games.participations'))
        return Promise.resolve({
          rows: [{ id: '45bb3901-346c-4535-a70a-b7010125fb2b' }],
          rowCount: 1,
        });
      if (text.includes('update games.games set revision'))
        return Promise.resolve({ rows: [{ revision: 9 }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    await expect(
      createGameProviderOperationRepository(pool(query) as never).recordCallback({
        tenantId,
        operationId,
        dedupeKey: 'synthetic-event-accepted-0002',
        evidenceHash: 'accepted-evidence',
        observedAt: '2026-08-24T18:00:00.000Z',
        result: {
          outcome: 'MATCHED_ACCEPTED',
          providerOperationId: 'synthetic:accepted-1',
          evidenceHash: 'accepted-evidence',
          facts: matchedFacts(),
        },
      }),
    ).resolves.toBe('applied');
    const callbackLeaseIndex = query.mock.calls.findIndex(([text]) =>
      text.includes("set state = 'RECONCILING', lease_token"),
    );
    const terminalIndex = (
      query.mock.calls as unknown as Array<[string, readonly unknown[] | undefined]>
    ).findIndex(
      ([text, values]) =>
        text.includes('update integration.game_provider_operations') &&
        values?.includes('CONFIRMED'),
    );
    expect(callbackLeaseIndex).toBeGreaterThan(-1);
    expect(terminalIndex).toBeGreaterThan(callbackLeaseIndex);
  });

  it('deduplicates callback replay before any second side effect', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'"))
        return Promise.resolve({ rows: [], rowCount: 0 });
      const locked = aggregateLockResult(text, row({ state: 'UNKNOWN', lease_token: null }));
      if (locked) return Promise.resolve(locked);
      if (text.includes('insert into integration.game_provider_operation_observations'))
        return Promise.resolve({ rows: [], rowCount: 0 });
      if (text.includes('select operation_id, normalized_result, evidence_hash'))
        return Promise.resolve({
          rows: [
            {
              operation_id: operationId,
              normalized_result: 'ACCEPTED',
              evidence_hash: 'accepted-evidence',
            },
          ],
          rowCount: 1,
        });
      if (text === 'rollback') return Promise.resolve({ rows: [], rowCount: 0 });
      throw new Error(`Unexpected query: ${text}`);
    });
    const result = await createGameProviderOperationRepository(pool(query) as never).recordCallback(
      {
        tenantId,
        operationId,
        dedupeKey: 'synthetic-event-0001',
        evidenceHash: 'accepted-evidence',
        observedAt: '2026-08-24T18:00:00.000Z',
        result: {
          outcome: 'MATCHED_ACCEPTED',
          providerOperationId: 'synthetic:accepted-1',
          evidenceHash: 'accepted-evidence',
          facts: matchedFacts(),
        },
      },
    );
    expect(result).toBe('duplicate');
    expect(
      query.mock.calls.some(([text]) => text.includes('insert into games.participations')),
    ).toBe(false);
  });

  it('rejects a stale worker fence without recording evidence or changing state', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'"))
        return Promise.resolve({ rows: [], rowCount: 0 });
      const locked = aggregateLockResult(text, row({ lease_token: 'newer-lease' }));
      if (locked) return Promise.resolve(locked);
      if (text === 'rollback') return Promise.resolve({ rows: [], rowCount: 0 });
      throw new Error(`Unexpected query: ${text}`);
    });
    await expect(
      createGameProviderOperationRepository(pool(query) as never).completeReadBack({
        tenantId,
        operationId,
        leaseToken: 'stale-lease',
        startedAt: '2026-08-24T18:00:00.000Z',
        result: { outcome: 'UNAVAILABLE', code: 'DOWN' },
        maxAttempts: 8,
      }),
    ).resolves.toBe('stale');
  });
});
