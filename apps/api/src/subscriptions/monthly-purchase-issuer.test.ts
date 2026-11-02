import { generateKeyPairSync, verify } from 'node:crypto';
import { it, expect } from 'vitest';
import { SubscriptionRuntimeActorDelegationIssuer } from './subscription-runtime-actor-delegation-issuer.js';
import { mpStable, mpHash, mpRequestHash, mpBody } from '@phub/domain/subscription-purchase';
import {
  monthlyActor,
  monthlyIdentity,
  monthlyQuote,
  monthlyKey,
} from '../../../../packages/domain/src/subscription-purchase.test-fixture.js';
it('dedicated monthly signature uses exact canonical private-owner claim bytes and token hash', async () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }),
    issuer = new SubscriptionRuntimeActorDelegationIssuer({
      privateKeyPem: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      keyId: 'fixture-monthly',
      issuer: 'https://fixture.invalid',
      audience: 'monthly-owner',
      ttlSeconds: 60,
    });
  const input = {
    ...monthlyActor,
    ...monthlyIdentity,
    keySha256: mpHash(monthlyKey),
    operationId: monthlyQuote().operationId,
    mode: 'quote' as const,
    actorToken: {
      token: 'fixture-actor-token-never-live',
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    },
  };
  const token = await issuer.issueMonthlyPurchase(input),
    [header, payload, signature] = token.split('.'),
    claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<string, unknown>;
  expect(
    verify(
      'RSA-SHA256',
      Buffer.from(header + '.' + payload),
      keys.publicKey,
      Buffer.from(signature!, 'base64url'),
    ),
  ).toBe(true);
  expect(Buffer.from(payload!, 'base64url').toString()).toBe(mpStable(claims));
  expect(Buffer.from(header!, 'base64url').toString()).toBe(
    mpStable({ alg: 'RS256', kid: 'fixture-monthly', typ: 'phub-monthly-friendship-actor+jwt' }),
  );
  expect(claims.actor_token_sha256).toBe(mpHash(input.actorToken.token));
  expect(claims.scope).toBe('subscription-runtime.monthly-friendship.quote');
  expect(claims.request_sha256).toBe(mpRequestHash('quote', mpBody('quote')));
  expect((claims.exp as number) - Number(claims.iat)).toBe(60);
  for (const patch of [
    { tenantKey: 'other' },
    { operationId: monthlyActor.userId },
    { actorToken: { ...input.actorToken, token: 'short' } },
    { mode: 'prepare' },
  ])
    await expect(
      issuer.issueMonthlyPurchase({ ...input, ...patch } as typeof input),
    ).rejects.toThrow();
});
