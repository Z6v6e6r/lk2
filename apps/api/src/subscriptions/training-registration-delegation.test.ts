import { generateKeyPairSync } from 'node:crypto';
import { afterEach, it, expect, vi } from 'vitest';
import { jwtVerify, importSPKI } from 'jose';
import { SubscriptionRuntimeActorDelegationIssuer } from './subscription-runtime-actor-delegation-issuer.js';
import {
  trainingFixture as f,
  trainingAuthorityFixture,
} from '../../../../packages/subscription-runtime-adapter/src/training-registration.test-fixture.js';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
afterEach(() => vi.useRealTimers());
it('signs exact training purpose claims including separate read intent and original opaque subscription', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2035-04-01T10:00:00.000Z'));
  const a = await trainingAuthorityFixture(),
    issuer = new SubscriptionRuntimeActorDelegationIssuer({
      privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      keyId: 'fixture-key',
      issuer: a.issuer,
      audience: a.audience,
      ttlSeconds: 30,
    });
  for (const mode of ['prepare', 'admit', 'read'] as const) {
    const token = await issuer.issueTrainingRegistration({
      mode,
      tenantId: f.ids.tenantId,
      userId: f.ids.userId,
      sessionId: f.ids.sessionId,
      providerClientId: f.ids.providerClientId,
      providerMappingId: f.ids.providerMappingId,
      providerClientSubscriptionId: f.ids.providerClientSubscriptionId,
      keySha256: a.keySha256,
      operationId: f.ids.operationId,
      request: mode === 'prepare' ? (f.requests.prepare as never) : a.request,
      correlationId: 'fixture-correlation',
      actorToken: { token: 'synthetic-actor-token', expiresAt: '2035-04-01T10:05:00.000Z' },
      ...(mode === 'admit' ? { recoveryOnly: true as const } : {}),
    });
    const { payload } = await jwtVerify(
      token,
      await importSPKI(keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'RS256'),
      { issuer: a.issuer, audience: a.audience },
    );
    expect(payload.scope).toBe(f.scopes[mode]);
    expect(payload.path).toBe(f.paths[mode]);
    expect(payload.request_sha256).toBe(f.requestHashes[mode]);
    expect(payload.provider_client_subscription_id).toBe(f.ids.providerClientSubscriptionId);
    expect(payload.recovery_only).toBe(mode === 'admit' ? true : undefined);
    expect(Object.keys(payload).sort()).toEqual(
      [...Object.keys(f.claims[mode]), ...(mode === 'admit' ? ['recovery_only'] : [])].sort(),
    );
  }
});
it('rejects false recovery, foreign canonical actor, expired token and wrong operation before signing', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2035-04-01T10:00:00.000Z'));
  const a = await trainingAuthorityFixture(),
    issuer = new SubscriptionRuntimeActorDelegationIssuer({
      privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      keyId: 'fixture-key',
      issuer: a.issuer,
      audience: a.audience,
      ttlSeconds: 30,
    });
  const input = {
    mode: 'admit' as const,
    tenantId: f.ids.tenantId,
    userId: f.ids.userId,
    sessionId: f.ids.sessionId,
    providerClientId: f.ids.providerClientId,
    providerMappingId: f.ids.providerMappingId,
    providerClientSubscriptionId: f.ids.providerClientSubscriptionId,
    keySha256: a.keySha256,
    operationId: f.ids.operationId,
    request: a.request,
    correlationId: 'fixture-correlation',
    actorToken: { token: 'synthetic-actor-token', expiresAt: '2035-04-01T10:05:00.000Z' },
  };
  for (const change of [
    { recoveryOnly: false },
    { providerClientId: 'foreign-client' },
    { operationId: f.ids.targetId },
    { actorToken: { token: 'synthetic-actor-token', expiresAt: '2035-03-01T10:00:00.000Z' } },
  ])
    await expect(
      issuer.issueTrainingRegistration({ ...input, ...change } as never),
    ).rejects.toThrow();
});
