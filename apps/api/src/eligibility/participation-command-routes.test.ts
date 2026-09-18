import { createHash } from 'node:crypto';

import type { ParticipationCommandRepository, ParticipationCommandView } from '@phub/database';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CupIdentityVerificationError,
  type VerifiedCupIdentity,
} from '../identity/cup-identity-verifier.js';
import { registerParticipationCommandRoutes } from './participation-command-routes.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const activityId = '95a76d36-d8a7-4ff5-a988-84f33c0fd05a';
const commandId = '21ad9428-4218-48d7-9acd-5b6661bb0155';
const token = 'participation-command-token-at-least-32-characters';
const apps: FastifyInstance[] = [];

function body() {
  return {
    activity: { type: 'GAME', id: activityId, expectedSourceRevision: 7 },
    action: 'JOIN',
  } as const;
}

const verifiedIdentity: VerifiedCupIdentity = {
  issuer: 'https://cup.padlhub.test/realms/lk',
  subject: 'legacy-user-4711',
  phoneNorm: '+79990000000',
  tenantKey: 'local-padel',
  authorizedParty: 'lk-legacy',
};

function verifier(identity: VerifiedCupIdentity = verifiedIdentity) {
  return { verify: vi.fn().mockResolvedValue(identity) };
}

const USER_ASSERTION = { authorization: 'Bearer legacy-user-assertion' } as const;

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

async function appWith(
  repository: ParticipationCommandRepository,
  enabled = true,
  identityVerifier: {
    verify: (authorization: string) => Promise<VerifiedCupIdentity>;
  } = verifier(),
) {
  const app = Fastify();
  registerParticipationCommandRoutes(app, {
    enabled,
    integrationToken: token,
    authorizedTenantKey: 'local-padel',
    principalKey: 'legacy-lk-writer',
    authorizationTtlSeconds: 300,
    repository,
    identityVerifier,
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
    resolveActor: vi.fn().mockResolvedValue({ outcome: 'resolved', userId: actorUserId }),
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
      headers: {
        ...USER_ASSERTION,
        'x-phub-participation-token': token,
        'idempotency-key': 'join-request-0001',
      },
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
        headers: {
          ...USER_ASSERTION,
          'x-phub-participation-token': token,
          'idempotency-key': 'join-request-0002',
        },
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
          ...USER_ASSERTION,
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
      headers: {
        ...USER_ASSERTION,
        'x-phub-participation-token': token,
        'idempotency-key': 'join-request-0005',
      },
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

  it('ignores no caller-supplied actor: a body actor is rejected outright', async () => {
    const repo = repository();
    const app = await appWith(repo);
    const response = await app.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/participation-commands',
      headers: {
        ...USER_ASSERTION,
        'x-phub-participation-token': token,
        'idempotency-key': 'join-request-forged-actor',
      },
      payload: { ...body(), actor: { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } },
    });
    expect(response.statusCode).toBe(400);
    expect(repo.authorize).not.toHaveBeenCalled();
  });

  it('requires a forwarded end-user assertion and resolves the actor server-side', async () => {
    const repo = repository();
    const app = await appWith(repo);
    const withoutAssertion = await app.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/participation-commands',
      headers: { 'x-phub-participation-token': token, 'idempotency-key': 'join-request-no-user' },
      payload: body(),
    });
    expect(withoutAssertion.statusCode).toBe(401);
    expect(withoutAssertion.json()).toMatchObject({
      code: 'PARTICIPATION_USER_ASSERTION_REQUIRED',
    });
    expect(repo.resolveActor).not.toHaveBeenCalled();
    expect(repo.authorize).not.toHaveBeenCalled();

    const withAssertion = await app.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/participation-commands',
      headers: {
        ...USER_ASSERTION,
        'x-phub-participation-token': token,
        'idempotency-key': 'join-request-resolved',
      },
      payload: body(),
    });
    expect(withAssertion.statusCode).toBe(200);
    expect(repo.resolveActor).toHaveBeenCalledWith({
      tenantId,
      issuer: verifiedIdentity.issuer,
      subject: verifiedIdentity.subject,
    });
    expect(repo.authorize).toHaveBeenCalledWith(expect.objectContaining({ actorUserId, tenantId }));
  });

  it('refuses an assertion that belongs to another tenant', async () => {
    const repo = repository();
    const app = await appWith(
      repo,
      true,
      verifier({ ...verifiedIdentity, tenantKey: 'another-tenant' }),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/participation-commands',
      headers: {
        ...USER_ASSERTION,
        'x-phub-participation-token': token,
        'idempotency-key': 'join-request-foreign-tenant',
      },
      payload: body(),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'PARTICIPATION_USER_TENANT_MISMATCH' });
    expect(repo.resolveActor).not.toHaveBeenCalled();
    expect(repo.authorize).not.toHaveBeenCalled();
  });

  it('fails closed when the identity assertion is rejected or the verifier is unavailable', async () => {
    const repo = repository();
    const rejected = await appWith(repo, true, {
      verify: vi.fn().mockRejectedValue(new CupIdentityVerificationError('rejected', 'nope')),
    });
    const rejectedResponse = await rejected.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/participation-commands',
      headers: {
        ...USER_ASSERTION,
        'x-phub-participation-token': token,
        'idempotency-key': 'join-request-rejected',
      },
      payload: body(),
    });
    expect(rejectedResponse.statusCode).toBe(401);

    const unavailable = await appWith(repo, true, {
      verify: vi.fn().mockRejectedValue(new CupIdentityVerificationError('unavailable', 'down')),
    });
    const unavailableResponse = await unavailable.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/participation-commands',
      headers: {
        ...USER_ASSERTION,
        'x-phub-participation-token': token,
        'idempotency-key': 'join-request-unavailable',
      },
      payload: body(),
    });
    expect(unavailableResponse.statusCode).toBe(503);
    expect(repo.authorize).not.toHaveBeenCalled();
  });

  it('refuses to serve when no identity verifier is configured', async () => {
    const repo = repository();
    const app = Fastify();
    registerParticipationCommandRoutes(app, {
      enabled: true,
      integrationToken: token,
      authorizedTenantKey: 'local-padel',
      principalKey: 'legacy-lk-writer',
      authorizationTtlSeconds: 300,
      repository: repo,
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
    const response = await app.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/participation-commands',
      headers: {
        ...USER_ASSERTION,
        'x-phub-participation-token': token,
        'idempotency-key': 'join-request-no-verifier',
      },
      payload: body(),
    });
    expect(response.statusCode).toBe(503);
    expect(repo.authorize).not.toHaveBeenCalled();
  });

  it('binds an acknowledgement to the caller that authorized the command', async () => {
    const repo = repository();
    const app = await appWith(repo);
    await app.inject({
      method: 'POST',
      url: `/internal/api/v1/local-padel/participation-commands/${commandId}/acknowledgements`,
      headers: {
        'x-phub-participation-token': token,
        'x-phub-participation-caller-token': 'writer-one-credential',
        'idempotency-key': 'ack-request-caller-one',
      },
      payload: {
        outcome: 'APPLIED',
        writerOperationId: '340f475e-686d-44fa-9729-bc073bce3c2c',
      },
    });
    const [firstCall] = vi.mocked(repo.acknowledge).mock.calls;
    expect(firstCall?.[0]).toMatchObject({
      callerKey: createHash('sha256').update('writer-one-credential').digest('hex'),
    });
  });
});
