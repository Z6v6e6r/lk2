import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  SubscriptionRuntimeActorDelegationIssuer,
  subscriptionRuntimeIdempotencyKeySha256,
  subscriptionRuntimeRequestSha256,
} from './subscription-runtime-actor-delegation-issuer.js';

describe('SubscriptionRuntimeActorDelegationIssuer', () => {
  it('mints a recipient-bound RS256 delegation with deterministic request bindings', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const request = {
      action: 'JOIN_GAME',
      target: { kind: 'GAME', id: 'game-001', expectedRevision: 2 },
      paymentIntent: 'AUTO_BEST_PRICE',
    } as const;
    const idempotencyHeader = ['quote', 'idempotency', '0001'].join(':');
    const issuer = new SubscriptionRuntimeActorDelegationIssuer({
      privateKeyPem: await exportPKCS8(keys.privateKey),
      keyId: 'lk2-runtime-20260824',
      issuer: 'https://api.example.test',
      audience: 'ph-admin-subscription-runtime',
      ttlSeconds: 30,
    });
    const token = await issuer.issue({
      userId: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      tenantKey: 'padlhub',
      sessionId: '33333333-3333-4333-8333-333333333333',
      providerClientId: 'viva-client-opaque',
      providerMappingId: '44444444-4444-4444-8444-444444444444',
      action: 'JOIN_GAME',
      correlationId: 'quote-test-0001',
      request,
      idempotencyKey: idempotencyHeader,
    });
    const verified = await jwtVerify(token, keys.publicKey, {
      algorithms: ['RS256'],
      issuer: 'https://api.example.test',
      audience: 'ph-admin-subscription-runtime',
    });
    expect(verified.protectedHeader).toMatchObject({
      alg: 'RS256',
      typ: 'phub-subscription-runtime-actor-delegation+jwt',
      kid: 'lk2-runtime-20260824',
    });
    expect(verified.payload).toMatchObject({
      contract_version: 1,
      scope: 'subscription-runtime.quote',
      action: 'JOIN_GAME',
      request_sha256: subscriptionRuntimeRequestSha256(request),
      idempotency_key_sha256: subscriptionRuntimeIdempotencyKeySha256(idempotencyHeader),
    });
    expect(token).not.toContain('Bearer');
  });

  it('rejects invalid TTL and unsupported action', async () => {
    expect(
      () =>
        new SubscriptionRuntimeActorDelegationIssuer({
          privateKeyPem: 'not-a-key',
          keyId: 'valid-key',
          issuer: 'issuer',
          audience: 'audience',
          ttlSeconds: 9,
        }),
    ).toThrow('SUBSCRIPTION_RUNTIME_DELEGATION_CONFIGURATION_INVALID');
    const keys = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(keys.privateKey);
    const issuer = new SubscriptionRuntimeActorDelegationIssuer({
      privateKeyPem,
      keyId: 'valid-key',
      issuer: 'issuer',
      audience: 'audience',
      ttlSeconds: 30,
    });
    await expect(
      issuer.issue({
        userId: 'u',
        tenantId: 't',
        tenantKey: 'tenant',
        sessionId: 's',
        providerClientId: 'p',
        providerMappingId: 'm',
        action: 'JOIN_GAME',
        correlationId: 'short',
        request: {} as never,
        idempotencyKey: 'key',
      }),
    ).rejects.toThrow('SUBSCRIPTION_RUNTIME_DELEGATION_INPUT_INVALID');
    expect(
      () =>
        new SubscriptionRuntimeActorDelegationIssuer({
          privateKeyPem,
          keyId: 'valid-key',
          issuer: `issuer-${'x'.repeat(506)}`,
          audience: 'audience',
          ttlSeconds: 30,
        }),
    ).toThrow('SUBSCRIPTION_RUNTIME_DELEGATION_CONFIGURATION_INVALID');
  });
});
