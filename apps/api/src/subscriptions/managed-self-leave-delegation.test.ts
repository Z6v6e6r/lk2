import { managedSelfLeaveFixture as f } from '../../../../packages/subscription-runtime-adapter/src/managed-self-leave.test-fixture.js';
import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { describe, it, expect } from 'vitest';
import { managedSelfLeaveOperationId } from '@phub/domain';
import {
  SubscriptionRuntimeActorDelegationIssuer,
  subscriptionRuntimeIdempotencyKeySha256,
} from './subscription-runtime-actor-delegation-issuer.js';
describe('SELF leave delegation', () => {
  it('binds exact actor/original request/mappings and restrictive recovery; rejects false and token expiry', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const issuer = new SubscriptionRuntimeActorDelegationIssuer({
      privateKeyPem: await exportPKCS8(keys.privateKey),
      keyId: 'synthetic-self-v1',
      issuer: 'https://issuer.example.test',
      audience: 'owner',
      ttlSeconds: 30,
    });
    const key = 'synthetic-self-leave-key';
    const operationId = await managedSelfLeaveOperationId({
      ...f.identity,
      idempotencyKeySha256: subscriptionRuntimeIdempotencyKeySha256(key),
    });
    const input = {
      userId: f.identity.userId,
      tenantId: f.identity.tenantId,
      tenantKey: 'iSkq6G',
      sessionId: '77777777-7777-4777-8777-777777777777',
      providerClientId: '7',
      providerMappingId: f.originalJoinReceipt.providerMappingId,
      operationId,
      correlationId: 'synthetic-correlation',
      idempotencyKey: key,
      request: f.request,
      legacyGameId: f.confirmed.receipt.legacyGameId,
      legacyGameMappingId: f.confirmed.receipt.legacyGameMappingId,
      legacyGameMappingVersion: f.confirmed.receipt.legacyGameMappingVersion,
      actorToken: {
        token: 'synthetic-actor-token',
        expiresAt: new Date(Date.now() + 30000).toISOString(),
      },
    };
    const normal = (
      await jwtVerify(await issuer.issueManagedSelfLeaveAdmission(input), keys.publicKey)
    ).payload;
    const recovery = (
      await jwtVerify(
        await issuer.issueManagedSelfLeaveAdmission({ ...input, recoveryOnly: true }),
        keys.publicKey,
      )
    ).payload;
    expect(normal).toMatchObject({
      contract_version: 1,
      scope: 'subscription-runtime.managed-self-leave.admit',
      path: f.paths.admission,
      method: 'POST',
      request_sha256: f.requestSha256,
      provider_client_id: '7',
      legacy_game_mapping_id: input.legacyGameMappingId,
    });
    expect(normal.recovery_only).toBeUndefined();
    expect(recovery.recovery_only).toBe(true);
    expect(recovery.request_sha256).toBe(normal.request_sha256);
    await expect(
      issuer.issueManagedSelfLeaveAdmission({ ...input, recoveryOnly: false } as never),
    ).rejects.toThrow();
    await expect(
      issuer.issueManagedSelfLeaveAdmission({
        ...input,
        actorToken: { ...input.actorToken, expiresAt: '2020-01-01T00:00:00.000Z' },
      }),
    ).rejects.toThrow();
    await expect(
      issuer.issueManagedSelfLeaveAdmission({ ...input, operationId: f.identity.userId }),
    ).rejects.toThrow();
    const read = (await jwtVerify(await issuer.issueManagedSelfLeaveRead(input), keys.publicKey))
      .payload;
    expect(read).toMatchObject({
      scope: 'subscription-runtime.managed-self-leave.read',
      receipt_version: 1,
      method: 'GET',
      path: '/lk/integrations/v1/managed-self-leaves/' + operationId,
    });
    expect(read.actor_token_sha256).toBeUndefined();
    for (const providerClientId of ['7\n', '7\r'])
      await expect(
        issuer.issueManagedSelfLeaveRead({ ...input, providerClientId }),
      ).rejects.toThrow();
  });
});
