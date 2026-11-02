import { afterEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  parseTrainingAuthority,
  parseTrainingCapsule,
  parseTrainingReceipt,
  parseTrainingRequest,
  trainingRequestHash,
  trainingHash,
} from '@phub/domain/training-registration';
import {
  TrainingRegistrationOwnerClient,
  TrainingPreparationRefused,
} from './training-registration.js';
import {
  trainingFixture as f,
  trainingAuthorityFixture,
} from './training-registration.test-fixture.js';
afterEach(() => vi.useRealTimers());
const now = () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2035-04-01T10:00:30.000Z'));
};
describe('frozen training owner wire and transport', () => {
  it('retains immutable bytes and exact canonical hash domains', async () => {
    expect(
      createHash('sha256')
        .update(
          readFileSync(
            new URL('./fixtures/training-registration-v1-contract.json', import.meta.url),
          ),
        )
        .digest('hex'),
    ).toBe('ad6b0447943617233fd4677dc61205fef054e22d1b1d19a3fcf12ede3b7e88b8');
    const a = await trainingAuthorityFixture();
    expect(a.request).toEqual(f.requests.admit);
    expect(await trainingRequestHash(parseTrainingRequest(f.requests.prepare))).toBe(
      f.requestHashes.prepare,
    );
    expect(a.requestSha256).toBe(f.requestHashes.admit);
    expect(a.bindingSha256).toBe(await trainingHash(f.preimages.binding));
    expect(await parseTrainingReceipt(f.responses.confirmed.receipt, a)).toEqual(
      f.responses.confirmed.receipt,
    );
  });
  it('refuses corrupted capsule, authority, opaque IDs and receipt bindings', async () => {
    const a = await trainingAuthorityFixture();
    for (const change of [
      { target: { ...a.request.preparation.target, capacity: 9 } },
      { selection: { ...a.request.preparation.selection, lk1Selection: 'MATCHED' } },
      { actor: { ...a.request.preparation.actor, providerClientId: 'bad\n' } },
    ])
      await expect(parseTrainingCapsule({ ...a.request.preparation, ...change })).rejects.toThrow();
    await expect(
      parseTrainingAuthority({ ...a, requestSha256: 'sha256:' + '1'.repeat(64) }),
    ).rejects.toThrow();
    for (const change of [
      { trainingId: f.ids.subscriptionId },
      { providerBookingId: 'new-booking' },
      { providerClientId: 'foreign-client' },
      { extra: true },
    ])
      await expect(
        parseTrainingReceipt({ ...f.responses.confirmed.receipt, ...change }, a),
      ).rejects.toThrow();
  });
  it('accepts a later observation of the original confirmation and carries fresh actor header on GET', async () => {
    now();
    const a = await trainingAuthorityFixture();
    const transport = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ...f.responses.confirmed, asOf: '2035-04-01T10:00:30.000Z' }),
        ),
      ),
    );
    const c = new TrainingRegistrationOwnerClient({
      baseUrl: 'https://padlhub.su',
      environment: 'production',
      timeoutMs: 1000,
      fetchImplementation: transport,
    });
    const result = await c.read(a, {
      operationId: f.ids.operationId,
      actorDelegation: 'synthetic-signed-claim',
      correlationId: 'synthetic-correlation',
      actorToken: { token: 'synthetic-actor-token', expiresAt: '2035-04-01T10:01:00.000Z' },
    });
    expect(result.status).toBe('CONFIRMED');
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { 'X-Subscription-Actor-Token': 'synthetic-actor-token' },
    });
  });
  it('never retries rejected/oversized/malformed/foreign-origin responses', async () => {
    now();
    const a = await trainingAuthorityFixture();
    const foreign = new Response(JSON.stringify(f.responses.confirmed));
    Object.defineProperty(foreign, 'url', { value: 'https://foreign.invalid/receipt' });
    for (const response of [
      new Response('{}', { status: 503 }),
      new Response('x'.repeat(33000)),
      new Response(JSON.stringify({ ...f.responses.confirmed, extra: 1 })),
      foreign,
    ]) {
      const transport = vi.fn(() => Promise.resolve(response)),
        c = new TrainingRegistrationOwnerClient({
          baseUrl: 'https://padlhub.su',
          environment: 'production',
          timeoutMs: 1000,
          fetchImplementation: transport,
        });
      await expect(
        c.read(a, {
          operationId: f.ids.operationId,
          actorDelegation: 'synthetic-signed-claim',
          correlationId: 'synthetic-correlation',
          actorToken: { token: 'synthetic-actor-token', expiresAt: '2035-04-01T10:01:00.000Z' },
        }),
      ).rejects.toThrow();
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });
  it('recognizes only exact prepare 409 refusal, never admission/read or foreign errors', async () => {
    now();
    const a = await trainingAuthorityFixture(),
      envelope = {
        operationId: f.ids.operationId,
        actorDelegation: 'synthetic-signed-claim',
        correlationId: 'synthetic-correlation',
        actorToken: { token: 'synthetic-actor-token', expiresAt: '2035-04-01T10:01:00.000Z' },
      };
    for (const mode of ['prepare', 'admit', 'read'] as const) {
      const c = new TrainingRegistrationOwnerClient({
        baseUrl: 'https://padlhub.su',
        environment: 'production',
        timeoutMs: 1000,
        fetchImplementation: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                code: 'TRAINING_REGISTRATION_UNSUPPORTED',
                error: 'TRAINING_REGISTRATION_UNSUPPORTED',
              }),
              { status: 409 },
            ),
          ),
      });
      try {
        if (mode === 'prepare') await c.prepare(parseTrainingRequest(f.requests.prepare), envelope);
        else if (mode === 'admit') await c.admit(a.request, a, envelope);
        else await c.read(a, envelope);
        expect.fail('must refuse');
      } catch (error) {
        expect(error instanceof TrainingPreparationRefused).toBe(mode === 'prepare');
      }
    }
    for (const value of [
      { code: 'TRAINING_REGISTRATION_UNSUPPORTED' },
      { code: 'OTHER', error: 'OTHER' },
      {
        code: 'TRAINING_REGISTRATION_UNSUPPORTED',
        error: 'TRAINING_REGISTRATION_UNSUPPORTED',
        extra: true,
      },
    ]) {
      const c = new TrainingRegistrationOwnerClient({
        baseUrl: 'https://padlhub.su',
        environment: 'production',
        timeoutMs: 1000,
        fetchImplementation: () =>
          Promise.resolve(new Response(JSON.stringify(value), { status: 409 })),
      });
      await expect(
        c.prepare(parseTrainingRequest(f.requests.prepare), envelope),
      ).rejects.not.toBeInstanceOf(TrainingPreparationRefused);
    }
  });
});
