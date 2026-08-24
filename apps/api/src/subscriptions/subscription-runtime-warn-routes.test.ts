import { exportPKCS8, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ManagedSubscriptionRuntimeQuoteClientError,
  type ManagedSubscriptionRuntimeServerEnvelope,
  type ManagedSubscriptionRuntimeV1QuoteOutcome,
  type ManagedSubscriptionRuntimeV1QuoteRequest,
} from '@phub/subscription-runtime-adapter';

import {
  SubscriptionRuntimeActorDelegationIssuer,
  subscriptionRuntimeIdempotencyKeySha256,
  subscriptionRuntimeRequestSha256,
} from './subscription-runtime-actor-delegation-issuer.js';
import { registerSubscriptionRuntimeWarnRoutes } from './subscription-runtime-warn-routes.js';

const actor = {
  userId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  tenantKey: 'padlhub',
  sessionId: '33333333-3333-4333-8333-333333333333',
  providerClientId: 'viva-client-opaque',
  providerMappingId: '44444444-4444-4444-8444-444444444444',
} as const;
const quoteRequest = {
  action: 'JOIN_GAME',
  target: { kind: 'GAME', id: 'game-001', expectedRevision: 2 },
  paymentIntent: 'AUTO_BEST_PRICE',
} as const satisfies ManagedSubscriptionRuntimeV1QuoteRequest;
const opaqueOperationHeader = ['warn', 'operation', 'quote', '0001'].join(':');
const quote = {
  contractVersion: 1,
  nonBinding: true,
  requiresReservationRecheck: true,
  outcome: 'FULL_PRICE_ONLY',
  paymentIntent: 'AUTO_BEST_PRICE',
  decisionId: 'decision-001',
  serviceAllowed: true,
  subscriptionBenefitAllowed: false,
  selectedSubscription: null,
  benefit: null,
  price: {
    priceRevision: 1,
    basePriceMinor: 400_000,
    discountMinor: 0,
    surchargeMinor: 0,
    finalPriceMinor: 400_000,
    currency: 'RUB',
  },
  limits: {
    activeServices: 0,
    activeServicesLimit: 3,
    dailyUsed: 0,
    dailyLimit: 1,
    weeklyUsed: 0,
    weeklyLimit: null,
    monthlyUsed: 0,
    monthlyLimit: null,
    remainingUnits: 2,
  },
  blockers: [{ code: 'DAILY_LIMIT_REACHED' }],
  warnings: [],
  alternatives: [{ paymentIntent: 'PAY_FULL_PRICE', requiresExplicitUserConfirmation: true }],
  evaluatedAt: '2026-08-24T10:00:00.000Z',
  expiresAt: '2026-08-24T10:02:00.000Z',
} as const satisfies ManagedSubscriptionRuntimeV1QuoteOutcome;

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function actorPreHandler(request: FastifyRequest): Promise<void> {
  const trustedRequest = request as FastifyRequest & {
    padlHubClaims: {
      sub: string;
      sid: string;
      tenants: string[];
      roles: string[];
      permissions: string[];
    };
    tenantId: string;
  };
  trustedRequest.padlHubClaims = {
    sub: actor.userId,
    sid: actor.sessionId,
    tenants: [actor.tenantId],
    roles: ['client'],
    permissions: ['games.play'],
  };
  trustedRequest.tenantId = actor.tenantId;
  return Promise.resolve();
}

function createApp(options: Parameters<typeof registerSubscriptionRuntimeWarnRoutes>[1]) {
  const app = Fastify({ genReqId: () => 'warn-correlation-0001' });
  apps.push(app);
  registerSubscriptionRuntimeWarnRoutes(app, options);
  return app;
}

function inject(app: FastifyInstance, body: unknown = quoteRequest) {
  return app.inject({
    method: 'POST',
    url: `/user/api/v1/${actor.tenantKey}/subscription-runtime/quote`,
    headers: { 'content-type': 'application/json', 'idempotency-key': opaqueOperationHeader },
    body: JSON.stringify(body),
  });
}

function errorCode(response: { json(): unknown }): string {
  const body = response.json();
  if (!body || typeof body !== 'object' || !('code' in body) || typeof body.code !== 'string') {
    throw new Error('Expected a typed API error');
  }
  return body.code;
}

async function fixture() {
  const keys = await generateKeyPair('RS256', { extractable: true });
  const issuer = new SubscriptionRuntimeActorDelegationIssuer({
    privateKeyPem: await exportPKCS8(keys.privateKey),
    keyId: 'lk2-test-key',
    issuer: 'https://api.padlhub.test',
    audience: 'ph-admin-subscription-runtime',
    ttlSeconds: 30,
  });
  const contextRepository = {
    resolve: vi.fn().mockResolvedValue({
      outcome: 'ok',
      providerClientId: actor.providerClientId,
      providerMappingId: actor.providerMappingId,
    }),
  };
  const usedJti = new Set<string>();
  const quoteClient = {
    quote: vi.fn(
      async (
        request: ManagedSubscriptionRuntimeV1QuoteRequest,
        envelope: ManagedSubscriptionRuntimeServerEnvelope,
      ) => {
        let verified;
        try {
          verified = await jwtVerify(envelope.actorDelegation, keys.publicKey, {
            algorithms: ['RS256'],
            issuer: 'https://api.padlhub.test',
            audience: 'ph-admin-subscription-runtime',
          });
        } catch {
          throw new ManagedSubscriptionRuntimeQuoteClientError(
            'SUBSCRIPTION_RUNTIME_REQUEST_FAILED',
            401,
          );
        }
        const payload = verified.payload;
        if (payload.tenant_id !== actor.tenantId || payload.tenant_key !== actor.tenantKey) {
          throw new ManagedSubscriptionRuntimeQuoteClientError(
            'SUBSCRIPTION_RUNTIME_REQUEST_FAILED',
            403,
          );
        }
        if (
          verified.protectedHeader.typ !== 'phub-subscription-runtime-actor-delegation+jwt' ||
          payload.scope !== 'subscription-runtime.quote' ||
          payload.sub !== actor.userId ||
          payload.sid !== actor.sessionId ||
          payload.provider !== 'VIVA' ||
          payload.provider_client_id !== actor.providerClientId ||
          payload.provider_mapping_id !== actor.providerMappingId ||
          payload.action !== request.action ||
          payload.correlation_id !== envelope.correlationId ||
          payload.request_sha256 !== subscriptionRuntimeRequestSha256(request) ||
          payload.idempotency_key_sha256 !==
            subscriptionRuntimeIdempotencyKeySha256(envelope.idempotencyKey) ||
          typeof payload.jti !== 'string'
        ) {
          throw new ManagedSubscriptionRuntimeQuoteClientError(
            'SUBSCRIPTION_RUNTIME_REQUEST_FAILED',
            401,
          );
        }
        if (usedJti.has(payload.jti)) {
          throw new ManagedSubscriptionRuntimeQuoteClientError(
            'SUBSCRIPTION_RUNTIME_REQUEST_FAILED',
            401,
          );
        }
        usedJti.add(payload.jti);
        return quote;
      },
    ),
  };
  return { keys, issuer, contextRepository, quoteClient };
}

describe('subscription runtime public WARN boundary', () => {
  it('derives actor context server-side and returns only a non-binding verified advisory', async () => {
    const { issuer, contextRepository, quoteClient } = await fixture();
    const issue = vi.spyOn(issuer, 'issue');
    const app = createApp({
      mode: 'WARN',
      actorContextRepository: contextRepository,
      delegationIssuer: issuer,
      quoteClient,
      commandHandlers: [actorPreHandler],
    });

    const response = await inject(app);

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      contractVersion: 1,
      mode: 'WARN',
      verdict: 'warning',
      nonBinding: true,
      requiresReservationRecheck: true,
      actor: { userId: actor.userId, tenantId: actor.tenantId, tenantKey: actor.tenantKey },
      request: {
        correlationId: 'warn-correlation-0001',
        idempotencyKeyDigest: subscriptionRuntimeIdempotencyKeySha256(opaqueOperationHeader),
      },
      delegation: {
        provider: 'VIVA',
        scope: 'subscription-runtime.quote',
        recipient: 'ph-admin',
        singleUse: true,
        verified: true,
      },
      advisory: { outcome: 'FULL_PRICE_ONLY' },
    });
    expect(response.body).not.toContain(actor.providerClientId);
    expect(response.body).not.toContain(actor.providerMappingId);
    expect(contextRepository.resolve).toHaveBeenCalledWith({
      tenantId: actor.tenantId,
      userId: actor.userId,
      sessionId: actor.sessionId,
    });
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: actor.userId,
        tenantId: actor.tenantId,
        tenantKey: actor.tenantKey,
        request: quoteRequest,
        idempotencyKey: opaqueOperationHeader,
      }),
    );
    expect(quoteClient.quote).toHaveBeenCalledOnce();
  });

  it.each([
    ['invalid signature', { signingKey: 'other' }],
    ['expired delegation', { expiresAt: Math.floor(Date.now() / 1000) - 1 }],
    ['wrong tenant', { tenant_id: '55555555-5555-4555-8555-555555555555' }],
    ['wrong request binding', { request_sha256: `sha256:${'0'.repeat(64)}` }],
    ['wrong idempotency binding', { idempotency_key_sha256: `sha256:${'1'.repeat(64)}` }],
    ['missing delegation fields', { scope: undefined }],
  ] as const)('rejects %s at the recipient verifier', async (_name, mutation) => {
    const { keys, contextRepository, quoteClient } = await fixture();
    const otherKeys = await generateKeyPair('RS256');
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      contract_version: 1,
      scope: 'subscription-runtime.quote',
      tenant_id: actor.tenantId,
      tenant_key: actor.tenantKey,
      sid: actor.sessionId,
      provider: 'VIVA',
      provider_client_id: actor.providerClientId,
      provider_mapping_id: actor.providerMappingId,
      action: quoteRequest.action,
      correlation_id: 'warn-correlation-0001',
      request_sha256: subscriptionRuntimeRequestSha256(quoteRequest),
      idempotency_key_sha256: subscriptionRuntimeIdempotencyKeySha256(opaqueOperationHeader),
      ...mutation,
    };
    delete (claims as { signingKey?: unknown }).signingKey;
    const token = await new SignJWT(claims)
      .setProtectedHeader({
        alg: 'RS256',
        typ: 'phub-subscription-runtime-actor-delegation+jwt',
        kid: 'lk2-test-key',
      })
      .setIssuer('https://api.padlhub.test')
      .setAudience('ph-admin-subscription-runtime')
      .setSubject(actor.userId)
      .setIssuedAt(now - 2)
      .setNotBefore(now - 2)
      .setExpirationTime('expiresAt' in mutation ? mutation.expiresAt : now + 30)
      .setJti('66666666-6666-4666-8666-666666666666')
      .sign('signingKey' in mutation ? otherKeys.privateKey : keys.privateKey);
    const app = createApp({
      mode: 'WARN',
      actorContextRepository: contextRepository,
      delegationIssuer: { issue: vi.fn().mockResolvedValue(token) },
      quoteClient,
      commandHandlers: [actorPreHandler],
    });

    const response = await inject(app);

    expect(response.statusCode).toBe(_name === 'wrong tenant' ? 403 : 401);
    expect(errorCode(response)).toMatch(/^SUBSCRIPTION_RUNTIME_DELEGATION_/);
  });

  it('rejects a replayed single-use delegation', async () => {
    const { issuer, contextRepository, quoteClient } = await fixture();
    const token = await issuer.issue({
      ...actor,
      action: quoteRequest.action,
      correlationId: 'warn-correlation-0001',
      request: quoteRequest,
      idempotencyKey: opaqueOperationHeader,
    });
    const app = createApp({
      mode: 'WARN',
      actorContextRepository: contextRepository,
      delegationIssuer: { issue: vi.fn().mockResolvedValue(token) },
      quoteClient,
      commandHandlers: [actorPreHandler],
    });

    expect((await inject(app)).statusCode).toBe(200);
    const replay = await inject(app);
    expect(replay.statusCode).toBe(401);
    expect(errorCode(replay)).toBe('SUBSCRIPTION_RUNTIME_DELEGATION_REJECTED');
  });

  it('rejects actor/delegation/credential tampering before context or verifier calls', async () => {
    const { issuer, contextRepository, quoteClient } = await fixture();
    const issue = vi.spyOn(issuer, 'issue');
    const app = createApp({
      mode: 'WARN',
      actorContextRepository: contextRepository,
      delegationIssuer: issuer,
      quoteClient,
      commandHandlers: [actorPreHandler],
    });

    const response = await inject(app, {
      ...quoteRequest,
      actor: { userId: 'attacker' },
      tenantId: 'attacker-tenant',
      providerClientId: 'attacker-provider',
      actorDelegation: 'attacker-token',
      credentials: 'attacker-secret',
    });

    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('SUBSCRIPTION_RUNTIME_QUOTE_REQUEST_INVALID');
    expect(contextRepository.resolve).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
    expect(quoteClient.quote).not.toHaveBeenCalled();
  });

  it.each([
    [401, 401, 'SUBSCRIPTION_RUNTIME_DELEGATION_REJECTED'],
    [403, 403, 'SUBSCRIPTION_RUNTIME_DELEGATION_FORBIDDEN'],
    [409, 409, 'SUBSCRIPTION_RUNTIME_DELEGATION_CONFLICT'],
    [500, 503, 'SUBSCRIPTION_RUNTIME_UNAVAILABLE'],
  ] as const)(
    'maps a redacted recipient %s response to public %s',
    async (recipientStatus, publicStatus, publicCode) => {
      const app = createApp({
        mode: 'WARN',
        actorContextRepository: {
          resolve: vi.fn().mockResolvedValue({
            outcome: 'ok',
            providerClientId: actor.providerClientId,
            providerMappingId: actor.providerMappingId,
          }),
        },
        delegationIssuer: { issue: vi.fn().mockResolvedValue('header.payload.signature') },
        quoteClient: {
          quote: vi
            .fn()
            .mockRejectedValue(
              new ManagedSubscriptionRuntimeQuoteClientError(
                'SUBSCRIPTION_RUNTIME_REQUEST_FAILED',
                recipientStatus,
              ),
            ),
        },
        commandHandlers: [actorPreHandler],
      });

      const response = await inject(app);

      expect(response.statusCode).toBe(publicStatus);
      expect(errorCode(response)).toBe(publicCode);
      expect(response.body).not.toContain('SUBSCRIPTION_RUNTIME_REQUEST_FAILED');
    },
  );

  it('fails closed for inactive sessions, missing mappings and disabled mode', async () => {
    for (const scenario of [
      { mode: 'OFF' as const, outcome: 'ok', expected: 503 },
      { mode: 'WARN' as const, outcome: 'session_inactive', expected: 401 },
      { mode: 'WARN' as const, outcome: 'provider_mapping_unavailable', expected: 503 },
    ]) {
      const quoteClient = { quote: vi.fn() };
      const issuer = { issue: vi.fn() };
      const app = createApp({
        mode: scenario.mode,
        actorContextRepository: {
          resolve: vi.fn().mockResolvedValue({ outcome: scenario.outcome }),
        },
        delegationIssuer: issuer,
        quoteClient,
        commandHandlers: [actorPreHandler],
      });
      expect((await inject(app)).statusCode).toBe(scenario.expected);
      expect(issuer.issue).not.toHaveBeenCalled();
      expect(quoteClient.quote).not.toHaveBeenCalled();
    }
  });

  it('has no provider or mutation dependency and performs exactly one quote read', async () => {
    const { issuer, contextRepository, quoteClient } = await fixture();
    const providerCall = vi.fn();
    const paymentMutation = vi.fn();
    const subscriptionMutation = vi.fn();
    const app = createApp({
      mode: 'WARN',
      actorContextRepository: contextRepository,
      delegationIssuer: issuer,
      quoteClient,
      commandHandlers: [actorPreHandler],
    });

    expect((await inject(app)).statusCode).toBe(200);
    expect(quoteClient.quote).toHaveBeenCalledOnce();
    expect(providerCall).not.toHaveBeenCalled();
    expect(paymentMutation).not.toHaveBeenCalled();
    expect(subscriptionMutation).not.toHaveBeenCalled();
  });
});
