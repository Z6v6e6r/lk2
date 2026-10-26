import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';

import { bookedOperationAdmissionId } from '@phub/subscription-runtime-adapter';

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

  it('binds the actor token and the provider subscription into the admission delegation', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const issuer = new SubscriptionRuntimeActorDelegationIssuer({
      privateKeyPem: await exportPKCS8(keys.privateKey),
      keyId: 'lk2-runtime-20260824',
      issuer: 'https://api.example.test',
      audience: 'ph-admin-subscription-runtime',
      ttlSeconds: 30,
    });
    const userId = '11111111-1111-4111-8111-111111111111';
    const tenantId = '22222222-2222-4222-8222-222222222222';
    const sessionId = '33333333-3333-4333-8333-333333333333';
    const providerClientSubscriptionId = '55555555-5555-4555-8555-555555555555';
    const idempotencyKey = ['booked', 'operation', 'token', '0001'].join('-');
    const keyHash = subscriptionRuntimeIdempotencyKeySha256(idempotencyKey);
    const request = {
      action: 'JOIN_GAME',
      target: { id: '66666666-6666-4666-8666-666666666666', expectedRevision: 3 },
      paymentIntent: 'USE_SUBSCRIPTION',
    } as const;
    const actorToken = {
      token: ['synthetic', 'actor', 'token', 'value'].join('-'),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const token = await issuer.issueBookedOperationAdmission({
      userId,
      tenantId,
      tenantKey: 'padlhub',
      sessionId,
      providerClientId: 'viva-client-opaque',
      providerMappingId: '77777777-7777-4777-8777-777777777777',
      providerExerciseId: 'viva-exercise-opaque',
      targetMappingId: '88888888-8888-4888-8888-888888888888',
      targetVersion: '7',
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      durationMinutes: 90,
      capacity: 4,
      admissible: true,
      operationId: bookedOperationAdmissionId(tenantId, userId, keyHash),
      correlationId: 'booked-operation-token-0001',
      idempotencyKey,
      request,
      actorToken,
      providerClientSubscriptionId,
    });
    const verified = await jwtVerify(token, keys.publicKey, {
      algorithms: ['RS256'],
      issuer: 'https://api.example.test',
      audience: 'ph-admin-subscription-runtime',
    });
    const { createHash } = await import('node:crypto');
    expect(verified.payload).toMatchObject({
      scope: 'subscription-runtime.booked-operation.admit',
      actor_token_sha256: `sha256:${createHash('sha256')
        .update(actorToken.token, 'utf8')
        .digest('hex')}`,
      actor_token_expires_at: actorToken.expiresAt,
      provider_client_subscription_id: providerClientSubscriptionId,
    });
  });

  it('refuses a token without a provider subscription binding', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const issuer = new SubscriptionRuntimeActorDelegationIssuer({
      privateKeyPem: await exportPKCS8(keys.privateKey),
      keyId: 'lk2-runtime-20260824',
      issuer: 'https://api.example.test',
      audience: 'ph-admin-subscription-runtime',
      ttlSeconds: 30,
    });
    const userId = '11111111-1111-4111-8111-111111111111';
    const tenantId = '22222222-2222-4222-8222-222222222222';
    const idempotencyKey = ['booked', 'operation', 'token', '0002'].join('-');
    const keyHash = subscriptionRuntimeIdempotencyKeySha256(idempotencyKey);
    const request = {
      action: 'JOIN_GAME',
      target: { id: '66666666-6666-4666-8666-666666666666', expectedRevision: 3 },
      paymentIntent: 'USE_SUBSCRIPTION',
    } as const;
    await expect(
      issuer.issueBookedOperationAdmission({
        userId,
        tenantId,
        tenantKey: 'padlhub',
        sessionId: '33333333-3333-4333-8333-333333333333',
        providerClientId: 'viva-client-opaque',
        providerMappingId: '77777777-7777-4777-8777-777777777777',
        providerExerciseId: 'viva-exercise-opaque',
        targetMappingId: '88888888-8888-4888-8888-888888888888',
        targetVersion: '7',
        startsAt: new Date(Date.now() + 3_600_000).toISOString(),
        durationMinutes: 90,
        capacity: 4,
        admissible: true,
        operationId: bookedOperationAdmissionId(tenantId, userId, keyHash),
        correlationId: 'booked-operation-token-0002',
        idempotencyKey,
        request,
        actorToken: {
          token: ['synthetic', 'actor', 'token', 'value'].join('-'),
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        },
      }),
    ).rejects.toThrow('SUBSCRIPTION_RUNTIME_DELEGATION_INPUT_INVALID');
  });
});
