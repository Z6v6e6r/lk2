import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  bookedOperationAdmissionId,
  parseManagedJoinAdmissionRequest,
  parseManagedJoinPreflightRequest,
} from '@phub/subscription-runtime-adapter';
import {
  SubscriptionRuntimeActorDelegationIssuer,
  subscriptionRuntimeIdempotencyKeySha256,
} from './subscription-runtime-actor-delegation-issuer.js';
import fixture from '../../../../packages/subscription-runtime-adapter/src/fixtures/managed-join-v2.json';

describe('managed JOIN delegations', () => {
  it('binds v2 preflight/admit/read to actor token, target and original operation identity', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const issuer = new SubscriptionRuntimeActorDelegationIssuer({
      privateKeyPem: await exportPKCS8(keys.privateKey),
      keyId: 'fixture-key',
      issuer: 'https://api.example.test',
      audience: 'owner',
      ttlSeconds: 30,
    });
    const idempotencyKey = ['fixture', 'managed', 'join', 'key'].join('-');
    const base = {
      ...fixture.identity,
      ...fixture.confirmed.receipt,
      tenantKey: 'synthetic',
      sessionId: fixture.confirmed.receipt.gameId,
      operationId: bookedOperationAdmissionId(
        fixture.identity.tenantId,
        fixture.identity.userId,
        subscriptionRuntimeIdempotencyKeySha256(idempotencyKey),
      ),
      idempotencyKey,
      correlationId: 'fixture-correlation',
      startsAt: '2099-10-31T12:00:00.000Z',
      durationMinutes: 90,
      capacity: 4,
      admissible: true,
      actorToken: {
        token: ['synthetic', 'actor', 'credential'].join('-'),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      },
    };
    const { reservationId, ...preflightBase } = base;
    const preflight = await issuer.issueManagedJoinPreflight({
      ...preflightBase,
      request: parseManagedJoinPreflightRequest(fixture.preflight.request),
    });
    const admit = await issuer.issueManagedJoinAdmission({
      ...base,
      reservationId,
      request: parseManagedJoinAdmissionRequest(fixture.admission.request),
    });
    const read = await issuer.issueManagedJoinRead(base);
    const shortId = await issuer.issueManagedJoinRead({ ...base, providerClientId: '7' });
    expect((await jwtVerify(shortId, keys.publicKey)).payload.provider_client_id).toBe('7');
    for (const providerClientId of ['7\n', '7\r'])
      await expect(issuer.issueManagedJoinRead({ ...base, providerClientId })).rejects.toThrow();

    const recovered = await issuer.issueManagedJoinAdmission({
      ...base,
      recoveryOnly: true,
      request: parseManagedJoinAdmissionRequest(fixture.admission.request),
    });
    const originalClaims = (await jwtVerify(admit, keys.publicKey)).payload;
    const recoveryClaims = (await jwtVerify(recovered, keys.publicKey)).payload;
    expect(recoveryClaims).toMatchObject({
      recovery_only: true,
      request_sha256: originalClaims.request_sha256,
      operation_id: originalClaims.operation_id,
    });
    expect(originalClaims).not.toHaveProperty('recovery_only');
    await expect(
      issuer.issueManagedJoinAdmission({
        ...base,
        recoveryOnly: false as never,
        request: parseManagedJoinAdmissionRequest(fixture.admission.request),
      }),
    ).rejects.toThrow();

    for (const [token, path, scope] of [
      [preflight, fixture.paths.preflight, 'subscription-runtime.booked-operation.preflight'],
      [admit, fixture.paths.admission, 'subscription-runtime.booked-operation.admit'],
      [
        read,
        `/lk/integrations/v2/booked-operations/${base.operationId}`,
        'subscription-runtime.booked-operation.read',
      ],
    ] as const) {
      const { payload } = await jwtVerify(token, keys.publicKey);
      expect(payload).toMatchObject({
        contract_version: 2,
        path,
        scope,
        operation_id: base.operationId,
        sub: base.userId,
      });
      if (token === read) expect(payload.receipt_version).toBe(2);
      else
        expect(payload).toMatchObject({
          actor_token_expires_at: base.actorToken.expiresAt,
          provider_client_subscription_id: base.providerClientSubscriptionId,
        });
      if (token === preflight) expect(payload).not.toHaveProperty('reservation_id');
      if (token === admit) expect(payload.reservation_id).toBe(reservationId);
    }
    await expect(
      issuer.issueManagedJoinPreflight({
        ...base,
        request: parseManagedJoinPreflightRequest(fixture.preflight.request),
      }),
    ).rejects.toThrow();
    await expect(
      issuer.issueManagedJoinAdmission({
        ...base,
        actorToken: { ...base.actorToken, expiresAt: '2000-01-01T00:00:00.000Z' },
        request: parseManagedJoinAdmissionRequest(fixture.admission.request),
      }),
    ).rejects.toThrow();
  });
});
