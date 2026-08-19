import type { ParticipationCommandRepository, ParticipationCommandView } from '@phub/database';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerParticipationCommandRoutes } from './participation-command-routes.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const activityId = '95a76d36-d8a7-4ff5-a988-84f33c0fd05a';
const commandId = '21ad9428-4218-48d7-9acd-5b6661bb0155';
const token = 'participation-command-token-at-least-32-characters';
const apps: FastifyInstance[] = [];

function body() {
  return {
    actor: { userId: actorUserId },
    activity: { type: 'GAME', id: activityId, expectedSourceRevision: 7 },
    action: 'JOIN',
  } as const;
}

function view(state: ParticipationCommandView['state'] = 'AUTHORIZED'): ParticipationCommandView {
  return {
    outcome: 'command',
    commandId,
    state,
    activityType: 'GAME',
    activityId,
    action: 'JOIN',
    activitySourceRevision: 7,
    decision: {
      decisionId: '1cd7e4c9-9d72-49d0-bf27-af4f2ec96eb5',
      status: state === 'REJECTED' ? 'DENIED' : 'ALLOWED',
      ruleCode: 'LEVEL_RANGE',
      outcome: state === 'REJECTED' ? 'FAIL' : 'PASS',
      reasonCode: state === 'REJECTED' ? 'LEVEL_NOT_ALLOWED' : 'LEVEL_ALLOWED',
      policyVersion: 1,
      levelScaleVersion: 1,
      constraintSource: 'CANONICAL',
      evaluatedAt: '2026-08-19T10:00:00.000Z',
    },
    ...(state === 'AUTHORIZED'
      ? { authorizationExpiresAt: '2026-08-19T10:05:00.000Z' }
      : { errorCode: 'LEVEL_NOT_ALLOWED' }),
    replayed: false,
  };
}

async function appWith(repository: ParticipationCommandRepository, enabled = true) {
  const app = Fastify();
  registerParticipationCommandRoutes(app, {
    enabled,
    integrationToken: token,
    authorizedTenantKey: 'local-padel',
    principalKey: 'legacy-lk-writer',
    authorizationTtlSeconds: 300,
    repository,
    commandHandlers: [
      (request) => {
        request.tenantId = tenantId;
        return Promise.resolve();
      },
    ],
    readHandlers: [
      (request) => {
        request.tenantId = tenantId;
        return Promise.resolve();
      },
    ],
  });
  apps.push(app);
  return app;
}

function repository(overrides: Partial<ParticipationCommandRepository> = {}) {
  return {
    authorize: vi.fn().mockResolvedValue(view()),
    acknowledge: vi.fn().mockResolvedValue({ ...view(), state: 'APPLIED' }),
    get: vi.fn().mockResolvedValue(view()),
    expireAuthorizedBatch: vi.fn().mockResolvedValue({ expired: 0 }),
    ...overrides,
  } satisfies ParticipationCommandRepository;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('participation command routes', () => {
  it('authorizes only canonical server-owned identifiers', async () => {
    const repo = repository();
    const app = await appWith(repo);
    const response = await app.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/participation-commands',
      headers: { 'x-phub-participation-token': token, 'idempotency-key': 'join-request-0001' },
      payload: body(),
    });
    expect(response.statusCode).toBe(200);
    expect(repo.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        principalKey: 'legacy-lk-writer',
        actorUserId,
        activityId,
        expectedActivityRevision: 7,
      }),
    );
  });

  it('rejects client-owned level, bypass, and invitation context', async () => {
    const repo = repository();
    const app = await appWith(repo);
    for (const extra of [
      { playerLevel: { rank: 7 } },
      { skipEligibility: true },
      { invitation: { source: 'PERSONAL' } },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/api/v1/local-padel/participation-commands',
        headers: { 'x-phub-participation-token': token, 'idempotency-key': 'join-request-0002' },
        payload: { ...body(), ...extra },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(repo.authorize).not.toHaveBeenCalled();
  });

  it('is fail-closed when disabled, cross-tenant, or supplied a wrong token', async () => {
    const disabledRepo = repository();
    const disabled = await appWith(disabledRepo, false);
    expect(
      (
        await disabled.inject({
          method: 'POST',
          url: '/internal/api/v1/local-padel/participation-commands',
          headers: { 'x-phub-participation-token': token, 'idempotency-key': 'join-request-0003' },
          payload: body(),
        })
      ).statusCode,
    ).toBe(503);

    const enabledRepo = repository();
    const enabled = await appWith(enabledRepo);
    for (const request of [
      { tenantKey: 'another-tenant', suppliedToken: token },
      { tenantKey: 'local-padel', suppliedToken: 'wrong-token-at-least-32-characters' },
    ]) {
      const response = await enabled.inject({
        method: 'POST',
        url: `/internal/api/v1/${request.tenantKey}/participation-commands`,
        headers: {
          'x-phub-participation-token': request.suppliedToken,
          'idempotency-key': 'join-request-0004',
        },
        payload: body(),
      });
      expect(response.statusCode).toBe(403);
    }
    expect(disabledRepo.authorize).not.toHaveBeenCalled();
    expect(enabledRepo.authorize).not.toHaveBeenCalled();
  });

  it('returns rejected commands as conflicts and forwards writer acknowledgements', async () => {
    const repo = repository({ authorize: vi.fn().mockResolvedValue(view('REJECTED')) });
    const app = await appWith(repo);
    const rejected = await app.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/participation-commands',
      headers: { 'x-phub-participation-token': token, 'idempotency-key': 'join-request-0005' },
      payload: body(),
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({ state: 'REJECTED' });

    const acknowledged = await app.inject({
      method: 'POST',
      url: `/internal/api/v1/local-padel/participation-commands/${commandId}/acknowledgements`,
      headers: { 'x-phub-participation-token': token, 'idempotency-key': 'ack-request-0001' },
      payload: {
        outcome: 'APPLIED',
        writerOperationId: '340f475e-686d-44fa-9729-bc073bce3c2c',
      },
    });
    expect(acknowledged.statusCode).toBe(200);
    expect(repo.acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({ commandId, result: { outcome: 'APPLIED' } }),
    );
  });
});
