import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { jwtVerify, importSPKI } from 'jose';
import { SubscriptionRuntimeActorDelegationIssuer } from './subscription-runtime-actor-delegation-issuer.js';
import { quarterFixture } from '../../../../packages/subscription-runtime-adapter/src/quarter-create.test-fixture.js';
import { qcAdmissionHash, qcReadBody, qcReadHash } from '@phub/domain/quarter-create';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }),
  pem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  pub = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const issuer = new SubscriptionRuntimeActorDelegationIssuer({
  privateKeyPem: pem,
  keyId: 'synthetic-key',
  issuer: 'synthetic-issuer',
  audience: 'synthetic-owner',
  ttlSeconds: 30,
});
describe('exact quarter delegation', () => {
  it.each(['prepare', 'admit', 'read'] as const)(
    'signs distinct %s scope/path/body with original actor tuple',
    async (mode) => {
      const f = await quarterFixture(),
        input = {
          ...f.scope,
          sessionId: '11111111-1111-4111-8111-000000000099',
          mode,
          operationId: f.receipt.operationId,
          request: mode === 'prepare' ? f.request : f.admission,
          context: f.context,
          correlationId: 'synthetic-correlation',
          actorToken: {
            token: 'synthetic-actor-not-real',
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
        },
        token = await issuer.issueQuarterCreate(input),
        { payload, protectedHeader } = await jwtVerify(token, await importSPKI(pub, 'RS256'), {
          issuer: 'synthetic-issuer',
          audience: 'synthetic-owner',
        });
      expect(protectedHeader.typ).toBe('phub-subscription-runtime-actor-delegation+jwt');
      expect(payload.scope).toBe('subscription-runtime.game-create.' + mode);
      expect(payload.method).toBe('POST');
      expect(payload.operation_id).toBe(f.receipt.operationId);
      expect(payload.provider_room_id).toBe(f.context.providerRoomId);
      expect(payload).not.toHaveProperty('recovery_only');
      if (mode === 'read')
        expect(payload.request_sha256).toBe(
          await qcReadHash(qcReadBody(f.receipt.operationId, await qcAdmissionHash(f.admission))),
        );
    },
  );
  it('refuses downgraded actor and recovery flag on READ', async () => {
    const f = await quarterFixture(),
      input = {
        ...f.scope,
        sessionId: '11111111-1111-4111-8111-000000000099',
        mode: 'read' as const,
        operationId: f.receipt.operationId,
        request: f.admission,
        context: f.context,
        correlationId: 'synthetic-correlation',
        actorToken: {
          token: 'synthetic-actor-not-real',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      };
    await expect(issuer.issueQuarterCreate({ ...input, recoveryOnly: true })).rejects.toThrow();
    await expect(
      issuer.issueQuarterCreate({
        ...input,
        context: { ...f.context, providerClientId: 'foreign-client' },
      }),
    ).rejects.toThrow();
  });
});
