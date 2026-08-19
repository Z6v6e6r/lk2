import { describe, expect, it, vi } from 'vitest';

import {
  createParticipationCommandRepository,
  type AuthorizeParticipationCommandInput,
  type ParticipationCommandView,
} from './participation-command-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const activityId = '95a76d36-d8a7-4ff5-a988-84f33c0fd05a';

function pool(query: ReturnType<typeof vi.fn>) {
  return { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };
}

function input(overrides: Partial<AuthorizeParticipationCommandInput> = {}) {
  return {
    tenantId,
    principalKey: 'legacy-lk-writer',
    idempotencyKey: 'join-request-0001',
    requestHash: 'a'.repeat(64),
    actorUserId,
    activityType: 'GAME',
    activityId,
    action: 'JOIN',
    expectedActivityRevision: 7,
    correlationId: 'participation-correlation-0001',
    authorizationTtlSeconds: 300,
    ...overrides,
  } satisfies AuthorizeParticipationCommandInput;
}

function authorizedView(): ParticipationCommandView {
  return {
    outcome: 'command',
    commandId: '21ad9428-4218-48d7-9acd-5b6661bb0155',
    state: 'AUTHORIZED',
    activityType: 'GAME',
    activityId,
    action: 'JOIN',
    activitySourceRevision: 7,
    decision: {
      decisionId: '1cd7e4c9-9d72-49d0-bf27-af4f2ec96eb5',
      status: 'ALLOWED',
      ruleCode: 'LEVEL_RANGE',
      outcome: 'PASS',
      reasonCode: 'LEVEL_ALLOWED',
      policyVersion: 1,
      levelScaleVersion: 1,
      constraintSource: 'CANONICAL',
      evaluatedAt: '2026-08-19T10:00:00.000Z',
    },
    authorizationExpiresAt: '2026-08-19T10:05:00.000Z',
    replayed: false,
  };
}

function authorizedQuery(options: { paymentConflict?: boolean } = {}) {
  return vi.fn((text: string) => {
    if (text === 'begin' || text === 'commit' || text === 'rollback') {
      return Promise.resolve({ rows: [] });
    }
    if (text.includes("set_config('app.tenant_id'") || text.includes('pg_advisory_xact_lock')) {
      return Promise.resolve({ rows: [] });
    }
    if (
      text.includes('from eligibility.participation_commands') &&
      text.includes('idempotency_key')
    ) {
      return Promise.resolve({ rows: [] });
    }
    if (text.includes('from identity.users'))
      return Promise.resolve({ rows: [{ id: actorUserId }] });
    if (text.includes('from eligibility.activity_level_projections')) {
      return Promise.resolve({
        rows: [
          {
            activity_id: activityId,
            sport_code: 'PADEL',
            constraint_mode: 'RANGE',
            min_level_id: 'level-c',
            max_level_id: 'level-b',
            minimum_rank: 3,
            maximum_rank: 5,
            constraint_source: 'CANONICAL',
            data_quality: 'VALID',
            scale_version: 1,
            source_revision: 7,
          },
        ],
      });
    }
    if (text.includes('from eligibility.level_policies')) {
      return Promise.resolve({
        rows: [
          {
            mode: 'BLOCK',
            lower_tolerance_steps: 0,
            upper_tolerance_steps: 0,
            missing_activity_constraint_action: 'BLOCK',
            legacy_text_constraint_action: 'WARN',
            version: 1,
          },
        ],
      });
    }
    if (text.includes('from eligibility.player_sport_levels')) {
      return Promise.resolve({
        rows: [
          {
            player_id: actorUserId,
            sport_code: 'PADEL',
            level_id: 'level-c-plus',
            rank: 4,
            source: 'MANUAL',
            scale_version: 1,
          },
        ],
      });
    }
    if (text.includes('insert into eligibility.decisions')) {
      return Promise.resolve({ rows: [{ evaluated_at: '2026-08-19T10:00:00.000Z' }] });
    }
    if (text.includes('make_interval')) {
      return Promise.resolve({ rows: [{ expires_at: '2026-08-19T10:05:00.000Z' }] });
    }
    if (text.includes('insert into eligibility.payment_snapshots')) {
      return Promise.resolve({ rows: [], rowCount: options.paymentConflict ? 0 : 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  });
}

describe('participation command repository', () => {
  it('evaluates authoritative projections and persists decision, command, audit, and outbox atomically', async () => {
    const query = authorizedQuery();
    const result = await createParticipationCommandRepository(pool(query) as never).authorize(
      input(),
    );
    expect(result).toMatchObject({
      outcome: 'command',
      state: 'AUTHORIZED',
      activitySourceRevision: 7,
      decision: { outcome: 'PASS', reasonCode: 'LEVEL_ALLOWED' },
    });
    for (const statement of [
      'insert into eligibility.decisions',
      'insert into eligibility.participation_commands',
      'insert into audit.audit_log',
      'insert into audit.outbox_events',
    ]) {
      expect(query.mock.calls.some(([text]) => text.includes(statement))).toBe(true);
    }
    expect(
      (query.mock.calls as unknown as Array<[string, readonly unknown[] | undefined]>).some(
        ([text, values]) =>
          text.includes('pg_advisory_xact_lock') &&
          values?.[0] === `player-level:${tenantId}:${actorUserId}:PADEL`,
      ),
    ).toBe(true);
    expect(query.mock.calls.some(([text]) => text === 'commit')).toBe(true);
  });

  it('rolls the whole transaction back when a payment operation was already claimed', async () => {
    const query = authorizedQuery({ paymentConflict: true });
    await expect(
      createParticipationCommandRepository(pool(query) as never).authorize(
        input({
          payment: {
            operationId: '340f475e-686d-44fa-9729-bc073bce3c2c',
            mode: 'SUBSCRIPTION',
          },
        }),
      ),
    ).resolves.toEqual({ outcome: 'payment_operation_conflict' });
    expect(query.mock.calls.some(([text]) => text === 'rollback')).toBe(true);
    expect(
      query.mock.calls.some(([text]) =>
        text.includes('insert into eligibility.participation_commands'),
      ),
    ).toBe(false);
  });

  it('replays the exact authorization and rejects idempotency-key reuse', async () => {
    const stored = authorizedView();
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [] });
      if (text.includes('from eligibility.participation_commands')) {
        return Promise.resolve({
          rows: [
            {
              id: stored.commandId,
              request_hash: 'a'.repeat(64),
              state: stored.state,
              result_payload: stored,
              authorization_expires_at: stored.authorizationExpiresAt,
              acknowledgement_idempotency_key: null,
              acknowledgement_request_hash: null,
              writer_operation_id: null,
            },
          ],
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createParticipationCommandRepository(pool(query) as never);
    await expect(repository.authorize(input())).resolves.toMatchObject({ replayed: true });
    await expect(repository.authorize(input({ requestHash: 'b'.repeat(64) }))).resolves.toEqual({
      outcome: 'idempotency_conflict',
    });
  });

  it('expires stale writer authorizations instead of accepting a late acknowledgement', async () => {
    const stored = authorizedView();
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [] });
      if (text.includes('from eligibility.participation_commands')) {
        return Promise.resolve({
          rows: [
            {
              id: stored.commandId,
              actor_user_id: actorUserId,
              request_hash: 'a'.repeat(64),
              state: 'AUTHORIZED',
              result_payload: stored,
              authorization_expires_at: stored.authorizationExpiresAt,
              authorization_expired: true,
              acknowledgement_idempotency_key: null,
              acknowledgement_request_hash: null,
              writer_operation_id: null,
            },
          ],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const result = await createParticipationCommandRepository(pool(query) as never).acknowledge({
      tenantId,
      principalKey: 'legacy-lk-writer',
      commandId: stored.commandId,
      idempotencyKey: 'ack-request-0001',
      requestHash: 'c'.repeat(64),
      writerOperationId: '340f475e-686d-44fa-9729-bc073bce3c2c',
      result: { outcome: 'APPLIED' },
      correlationId: 'participation-correlation-0002',
    });
    expect(result).toMatchObject({
      state: 'EXPIRED',
      errorCode: 'PARTICIPATION_AUTHORIZATION_EXPIRED',
    });
  });

  it('rolls back when one writer operation is reused for another command', async () => {
    const stored = authorizedView();
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [] });
      }
      if (text === 'rollback' || text.includes('pg_advisory_xact_lock')) {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes('from eligibility.participation_commands')) {
        return Promise.resolve({
          rows: [
            {
              id: stored.commandId,
              actor_user_id: actorUserId,
              request_hash: 'a'.repeat(64),
              state: 'AUTHORIZED',
              result_payload: stored,
              authorization_expires_at: stored.authorizationExpiresAt,
              authorization_expired: false,
              acknowledgement_idempotency_key: null,
              acknowledgement_request_hash: null,
              writer_operation_id: null,
            },
          ],
        });
      }
      if (text.includes('update eligibility.participation_commands')) {
        return Promise.reject(
          Object.assign(new Error('duplicate writer operation'), { code: '23505' }),
        );
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    await expect(
      createParticipationCommandRepository(pool(query) as never).acknowledge({
        tenantId,
        principalKey: 'legacy-lk-writer',
        commandId: stored.commandId,
        idempotencyKey: 'ack-request-0002',
        requestHash: 'f'.repeat(64),
        writerOperationId: '340f475e-686d-44fa-9729-bc073bce3c2c',
        result: { outcome: 'APPLIED' },
        correlationId: 'participation-correlation-0003',
      }),
    ).resolves.toEqual({ outcome: 'writer_operation_conflict' });
    expect(query.mock.calls.some(([text]) => text === 'rollback')).toBe(true);
  });
});
