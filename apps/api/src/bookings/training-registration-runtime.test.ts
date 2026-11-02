import { afterEach, it, expect, vi } from 'vitest';
import {
  trainingAuthorityFixture,
  trainingReceiptFixture,
  trainingFixture as f,
} from '../../../../packages/subscription-runtime-adapter/src/training-registration.test-fixture.js';
import {
  trainingHash,
  trainingOperationId,
  type TrainingAuthority,
  type TrainingReceipt,
} from '@phub/domain/training-registration';
import type {
  TrainingAttempt,
  TrainingRegistrationRepository,
} from '@phub/database/training-registration';
import {
  stationAdmissionId,
  type TrainingStationMarker,
  TrainingPreparationRefused,
} from '@phub/subscription-runtime-adapter';
import { createTrainingRegistrationRuntime } from './training-registration-runtime.js';
const actor = {
  tenantId: f.ids.tenantId,
  tenantKey: 'fixture',
  userId: f.ids.userId,
  sessionId: f.ids.sessionId,
  correlationId: 'fixture-correlation',
};
const input = {
  trainingId: f.ids.targetId,
  subscriptionId: f.ids.subscriptionId,
  dateHint: '2035-04-02',
  idempotencyKey: f.ids.idempotencyKey,
};
afterEach(() => vi.useRealTimers());
async function setup(stationEnabled = false) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2035-04-01T10:00:20.000Z'));
  const authority = await trainingAuthorityFixture(),
    receipt = await trainingReceiptFixture(authority);
  let row: TrainingAttempt | null = null;
  const sequence: string[] = [];
  const repository = {
    ready: vi.fn(() => Promise.resolve(true)),
    context: vi.fn(() =>
      Promise.resolve({
        providerClientId: f.ids.providerClientId,
        providerMappingId: f.ids.providerMappingId,
        providerClientSubscriptionId: f.ids.providerClientSubscriptionId,
      }),
    ),
    read: vi.fn(() => Promise.resolve(row)),
    begin: vi.fn(
      async (
        s: { tenantId: string; userId: string; keySha256: string },
        request: TrainingAttempt['request'],
        _correlationId: string,
        adoptStation = false,
      ) => {
        sequence.push('persist');
        row ??= {
          id: await trainingOperationId(s.tenantId, s.userId, s.keySha256),
          state: 'PREPARING',
          stationMembership: adoptStation ? { version: 1, outcome: 'PENDING_ADMISSION' } : null,
          request,
          authority: null,
          authoritySha256: null,
          receipt: null,
          leaseToken: null,
          leaseUntil: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        return row;
      },
    ),
    claimPreparation: vi.fn(async () => {
      await Promise.resolve();
      if (!row) return null;
      if (row.state !== 'PREPARING' || (row.leaseUntil && Date.parse(row.leaseUntil) > Date.now()))
        return { attempt: row, token: null };
      row.leaseToken = crypto.randomUUID();
      row.leaseUntil = new Date(Date.now() + 120000).toISOString();
      sequence.push('prepare-claim');
      return { attempt: row, token: row.leaseToken };
    }),
    pinStationPreparation: vi.fn(
      async (_s: unknown, token: string, authority: TrainingAuthority) => {
        await Promise.resolve();
        if (
          !row ||
          row.leaseToken !== token ||
          row.stationMembership?.outcome !== 'PENDING_ADMISSION'
        )
          return null;
        row.stationMembership = { version: 1, outcome: 'INTENT', authority };
        sequence.push('station-pin');
        return row;
      },
    ),
    settlePreparation: vi.fn(
      async (
        _s: unknown,
        token: string,
        a: TrainingAuthority | null,
        _correlationId: string,
        marker?: TrainingStationMarker,
      ) => {
        if (
          !row ||
          row.state !== 'PREPARING' ||
          row.leaseToken !== token ||
          !row.leaseUntil ||
          Date.parse(row.leaseUntil) <= Date.now()
        )
          return null;
        row.authority = a;
        if (marker) row.stationMembership = marker;
        row.authoritySha256 = a ? await trainingHash(JSON.stringify(a)) : null;
        row.state = a ? 'PREPARED' : 'REJECTED_NOT_DISPATCHED';
        row.leaseToken = null;
        row.leaseUntil = null;
        sequence.push(a ? 'prepared' : 'refused');
        return row;
      },
    ),
    claim: vi.fn(async () => {
      await Promise.resolve();
      if (!row) return null;
      if (row.state === 'CONFIRMED' || row.state === 'EXPIRED_NOT_DISPATCHED')
        return { attempt: row, token: null, recovery: false };
      if (
        row.state === 'PREPARED' &&
        Date.parse(row.authority!.request.preparation.expiresAt) <= Date.now()
      ) {
        row.state = 'EXPIRED_NOT_DISPATCHED';
        return { attempt: row, token: null, recovery: false };
      }
      if (row.leaseUntil && Date.parse(row.leaseUntil) > Date.now())
        return { attempt: row, token: null, recovery: true };
      const recovery = row.state === 'DISPATCH_STARTED';
      row.state = 'DISPATCH_STARTED';
      row.leaseToken = crypto.randomUUID();
      row.leaseUntil = new Date(Date.now() + 120000).toISOString();
      sequence.push('claim');
      return { attempt: row, token: row.leaseToken, recovery };
    }),
    complete: vi.fn(async (_s: unknown, token: string, _hash: string, r: TrainingReceipt) => {
      await Promise.resolve();
      if (!row || row.leaseToken !== token) return null;
      sequence.push('complete');
      row.state = 'CONFIRMED';
      row.receipt = r;
      row.leaseToken = null;
      row.leaseUntil = null;
      return row;
    }),
  } satisfies TrainingRegistrationRepository;
  const unknown = { status: 'UNKNOWN' as const, asOf: new Date().toISOString() },
    confirmed = { status: 'CONFIRMED' as const, asOf: new Date().toISOString(), receipt };
  const client = {
    prepare: vi.fn(() => Promise.resolve(authority.request.preparation)),
    read: vi.fn(() => Promise.resolve(unknown as typeof unknown | typeof confirmed)),
    admit: vi.fn<() => Promise<typeof unknown | typeof confirmed>>(async () => {
      await Promise.resolve();
      sequence.push('admit');
      return confirmed;
    }),
  };
  const issuer = {
      trainingSigningIdentity: () => ({ issuer: authority.issuer, audience: authority.audience }),
      issueTrainingRegistration: vi.fn(() => Promise.resolve('synthetic-signed-delegation')),
    },
    token = vi.fn(() =>
      Promise.resolve({
        token: 'synthetic-actor-token',
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      }),
    );
  const station = {
    signer: { issue: vi.fn(() => 'synthetic.station.delegation') },
    client: {
      admit: vi.fn(async () => {
        await Promise.resolve();
        sequence.push('station-admit');
        return {
          contractVersion: 1 as const,
          operationId: authority.request.preparation.operationId,
          replayed: false,
          admission: {
            outcome: 'ADMITTED' as const,
            admissionId: stationAdmissionId(
              actor.tenantId,
              authority.request.preparation.operationId,
            ),
            communityId: 'fixture-station',
            membershipEpoch: 0,
            reason: 'ELIGIBLE',
            bindingSha256: 'sha256:' + 'a'.repeat(64),
          },
        };
      }),
    },
  };
  const runtime = createTrainingRegistrationRuntime({
    enabled: true,
    stationMembership: stationEnabled ? station : undefined,
    repository,
    client,
    issuer,
    token,
  });
  return {
    station,
    runtime,
    repository,
    client,
    issuer,
    token,
    sequence,
    authority,
    receipt,
    confirmed,
    unknown,
    seedPrepared: async () => {
      row = {
        id: authority.request.preparation.operationId,
        state: 'PREPARED',
        request: {
          trainingId: input.trainingId,
          subscriptionId: input.subscriptionId,
          dateHint: input.dateHint,
        },
        authority,
        authoritySha256: await trainingHash(JSON.stringify(authority)),
        receipt: null,
        leaseToken: null,
        leaseUntil: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },
    row: () => row,
    setRow: (a: TrainingAttempt | null) => {
      row = a;
    },
  };
}
it('persists original capsule before claim/admit; fresh observation is separate from historical result', async () => {
  const h = await setup();
  const r = await h.runtime.execute(actor, input);
  expect(r.operation.status).toBe('CONFIRMED');
  expect(r.registration.status).toBe('CONFIRMED');
  expect(h.sequence).toEqual([
    'persist',
    'prepare-claim',
    'prepared',
    'claim',
    'admit',
    'complete',
  ]);
  h.client.read.mockResolvedValue(h.unknown);
  const read = await h.runtime.read(actor, input);
  expect(read.operation.status).toBe('CONFIRMED');
  expect(read.registration.status).toBe('UNKNOWN');
  expect(h.repository.claim).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(read)).not.toMatch(/provider|receipt|preparation/);
});
it('missing schema and disabled gate stop before token/provider', async () => {
  const h = await setup();
  h.repository.ready.mockResolvedValue(false);
  await expect(h.runtime.execute(actor, input)).rejects.toThrow();
  expect(h.token).not.toHaveBeenCalled();
  expect(h.client.prepare).not.toHaveBeenCalled();
  h.repository.ready.mockResolvedValue(true);
  const off = createTrainingRegistrationRuntime({
    enabled: false,
    repository: h.repository,
    client: h.client,
    issuer: h.issuer,
    token: h.token,
  });
  await expect(off.execute(actor, input)).rejects.toThrow();
  expect(h.client.prepare).not.toHaveBeenCalled();
});
it('same key changed selection conflicts before new mapping and wrong capsule never persists', async () => {
  const h = await setup();
  h.client.prepare.mockResolvedValue({
    ...h.authority.request.preparation,
    actor: { ...h.authority.request.preparation.actor, userId: f.ids.subscriptionId },
  });
  expect((await h.runtime.execute(actor, input)).operation.status).toBe('PENDING');
  expect(h.row()?.authority).toBeNull();
  expect(h.repository.settlePreparation).not.toHaveBeenCalled();
  h.client.prepare.mockResolvedValue(h.authority.request.preparation);
  vi.advanceTimersByTime(121000);
  await h.runtime.execute(actor, input);
  h.repository.context.mockClear();
  await expect(
    h.runtime.execute(actor, { ...input, subscriptionId: f.ids.userId }),
  ).rejects.toMatchObject({ status: 409 });
  expect(h.repository.context).not.toHaveBeenCalled();
});
it('lost owner response retries only original recovery after expired lease, never prepares again', async () => {
  const h = await setup();
  h.client.admit.mockRejectedValueOnce(new Error('synthetic lost response'));
  expect((await h.runtime.execute(actor, input)).operation.status).toBe('UNKNOWN');
  vi.advanceTimersByTime(121000);
  expect((await h.runtime.execute(actor, input)).operation.status).toBe('CONFIRMED');
  expect(h.client.prepare).toHaveBeenCalledTimes(1);
  expect(h.issuer.issueTrainingRegistration).toHaveBeenLastCalledWith(
    expect.objectContaining({ mode: 'admit', recoveryOnly: true, request: h.authority.request }),
  );
});
it('concurrent exact retries have one local dispatch lease and retain unknown on token failure', async () => {
  const h = await setup();
  h.client.admit.mockResolvedValue(h.unknown);
  await Promise.all([h.runtime.execute(actor, input), h.runtime.execute(actor, input)]);
  expect(h.client.admit).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(121000);
  h.token.mockRejectedValue(new Error('no actor'));
  expect((await h.runtime.execute(actor, input)).operation.status).toBe('UNKNOWN');
  expect(h.client.admit).toHaveBeenCalledTimes(1);
});
it('GET observes but never expires PREPARED; explicit POST returns exact no-dispatch expiry', async () => {
  const h = await setup();
  await h.seedPrepared();
  vi.advanceTimersByTime(61000);
  const before = JSON.stringify(h.row());
  await h.runtime.read(actor, input);
  expect(JSON.stringify(h.row())).toBe(before);
  expect(h.repository.claim).not.toHaveBeenCalled();
  const result = await h.runtime.execute(actor, input);
  expect(result.operation.status).toBe('EXPIRED_NOT_DISPATCHED');
  expect(result.registration).toEqual({ status: 'UNKNOWN', asOf: null });
  expect(h.client.admit).not.toHaveBeenCalled();
  expect(await h.runtime.execute(actor, input)).toEqual(result);
});
it('original mapping drift and changed observed booking never become fresh confirmation', async () => {
  const h = await setup();
  await h.runtime.execute(actor, input);
  h.repository.context.mockResolvedValue({
    ...(await h.repository.context()),
    providerClientId: 'foreign-client',
  });
  expect((await h.runtime.read(actor, input)).registration.status).toBe('UNKNOWN');
  expect(h.client.read).not.toHaveBeenCalled();
});

it('GET fresh confirmation does not mutate or promote unfinished local operation', async () => {
  const h = await setup();
  h.client.admit.mockResolvedValue(h.unknown);
  await h.runtime.execute(actor, input);
  h.client.read.mockResolvedValue(h.confirmed);
  h.repository.claim.mockClear();
  h.repository.complete.mockClear();
  const result = await h.runtime.read(actor, input);
  expect(result.operation.status).toBe('UNKNOWN');
  expect(result.registration.status).toBe('CONFIRMED');
  expect(h.repository.claim).not.toHaveBeenCalled();
  expect(h.repository.complete).not.toHaveBeenCalled();
  expect(h.row()?.state).toBe('DISPATCH_STARTED');
});
it('only explicit prepare refusal settles durable no-dispatch terminal; same-key remains immutable', async () => {
  const h = await setup();
  h.client.prepare.mockRejectedValue(new TrainingPreparationRefused());
  const result = await h.runtime.execute(actor, input);
  expect(result.operation.status).toBe('REJECTED_NOT_DISPATCHED');
  expect(result.registration).toEqual({ status: 'UNKNOWN', asOf: null });
  expect(h.sequence).toEqual(['persist', 'prepare-claim', 'refused']);
  expect(h.client.admit).not.toHaveBeenCalled();
  expect(await h.runtime.execute(actor, input)).toEqual(result);
  expect(h.client.prepare).toHaveBeenCalledTimes(1);
  await expect(
    h.runtime.execute(actor, { ...input, subscriptionId: f.ids.userId }),
  ).rejects.toMatchObject({ status: 409 });
});
it('timeout before capsule keeps PREPARING; active preparation lease blocks competing request', async () => {
  const h = await setup();
  let release!: (value: typeof h.authority.request.preparation) => void;
  h.client.prepare.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = h.runtime.execute(actor, input);
  await vi.waitFor(() => expect(h.client.prepare).toHaveBeenCalledTimes(1));
  expect((await h.runtime.execute(actor, input)).operation.status).toBe('PENDING');
  expect(h.client.prepare).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(121000);
  h.client.prepare.mockRejectedValueOnce(new TrainingPreparationRefused());
  expect((await h.runtime.execute(actor, input)).operation.status).toBe('REJECTED_NOT_DISPATCHED');
  release(h.authority.request.preparation);
  expect((await first).operation.status).toBe('REJECTED_NOT_DISPATCHED');
  expect(h.row()?.authority).toBeNull();
  expect(h.client.admit).not.toHaveBeenCalled();
});
it('stale refusal cannot replace newer valid capsule and dispatch', async () => {
  const h = await setup();
  let reject!: (error: Error) => void;
  h.client.prepare.mockImplementationOnce(
    () =>
      new Promise((_resolve, no) => {
        reject = no;
      }),
  );
  const first = h.runtime.execute(actor, input);
  await vi.waitFor(() => expect(h.client.prepare).toHaveBeenCalledTimes(1));
  vi.advanceTimersByTime(121000);
  const fresh = await trainingAuthorityFixture({ observedAt: new Date().toISOString() });
  h.client.prepare.mockResolvedValueOnce(fresh.request.preparation);
  h.client.admit.mockResolvedValueOnce({
    ...h.confirmed,
    receipt: await trainingReceiptFixture(fresh, new Date().toISOString()),
  });
  expect((await h.runtime.execute(actor, input)).operation.status).toBe('CONFIRMED');
  reject(new TrainingPreparationRefused());
  expect((await first).operation.status).toBe('CONFIRMED');
  expect(h.row()?.authority?.request.preparation).toEqual(fresh.request.preparation);
  expect(h.client.admit).toHaveBeenCalledTimes(1);
});

it('station admission pins the verified training capsule before POST and settles before provider booking', async () => {
  const t = await setup(true);
  expect((await t.runtime.execute(actor, input)).operation.status).toBe('CONFIRMED');
  expect(t.sequence).toEqual([
    'persist',
    'prepare-claim',
    'station-pin',
    'station-admit',
    'prepared',
    'claim',
    'admit',
    'complete',
  ]);
  expect(t.row()?.stationMembership?.outcome).toBe('OWNER_ADMISSION');
  expect(t.station.client.admit).toHaveBeenCalledOnce();
  await t.runtime.execute(actor, input);
  expect(t.station.client.admit).toHaveBeenCalledOnce();
});
it('station timeout is terminal no-enrollment and never prevents confirmed training booking', async () => {
  const t = await setup(true);
  t.station.client.admit.mockRejectedValueOnce(new Error('synthetic ACK loss'));
  expect((await t.runtime.execute(actor, input)).operation.status).toBe('CONFIRMED');
  expect(t.row()?.stationMembership).toEqual({
    version: 1,
    outcome: 'NO_ENROLLMENT',
    reason: 'OWNER_UNAVAILABLE',
  });
  await t.runtime.execute(actor, input);
  expect(t.station.client.admit).toHaveBeenCalledOnce();
});
it('lost pin ACK reuses the original intent and never prepares a replacement capsule', async () => {
  const t = await setup(true),
    pin = t.repository.pinStationPreparation.getMockImplementation()!;
  t.repository.pinStationPreparation.mockImplementationOnce(async (...args) => {
    await pin(...args);
    throw new Error('lost pin ACK');
  });
  expect((await t.runtime.execute(actor, input)).operation.status).toBe('PENDING');
  expect(t.row()?.stationMembership?.outcome).toBe('INTENT');
  expect(t.station.client.admit).not.toHaveBeenCalled();
  // Reclaim lease before the original capsule expiry: simulate crash recovery lease release.
  t.row()!.leaseUntil = new Date(Date.now() - 1).toISOString();
  expect((await t.runtime.execute(actor, input)).operation.status).toBe('CONFIRMED');
  expect(t.client.prepare).toHaveBeenCalledOnce();
  expect(t.row()?.authority).toEqual(t.authority);
});
it('intent recovery refuses changed provider mapping before any new preparation or station POST', async () => {
  const t = await setup(true),
    pin = t.repository.pinStationPreparation.getMockImplementation()!;
  t.repository.pinStationPreparation.mockImplementationOnce(async (...args) => {
    await pin(...args);
    throw new Error('lost ACK');
  });
  await t.runtime.execute(actor, input);
  t.row()!.leaseUntil = new Date(Date.now() - 1).toISOString();
  t.repository.context.mockResolvedValue({
    ...(await t.repository.context()),
    providerMappingId: crypto.randomUUID(),
  });
  await t.runtime.execute(actor, input);
  expect(t.client.prepare).toHaveBeenCalledOnce();
  expect(t.station.client.admit).not.toHaveBeenCalled();
  expect(t.client.admit).not.toHaveBeenCalled();
});
it('expired intent is never re-prepared or enrolled and follows the original expiry path', async () => {
  const t = await setup(true),
    pin = t.repository.pinStationPreparation.getMockImplementation()!;
  t.repository.pinStationPreparation.mockImplementationOnce(async (...args) => {
    await pin(...args);
    throw new Error('lost ACK');
  });
  await t.runtime.execute(actor, input);
  vi.advanceTimersByTime(121000);
  expect((await t.runtime.execute(actor, input)).operation.status).toBe('EXPIRED_NOT_DISPATCHED');
  expect(t.client.prepare).toHaveBeenCalledOnce();
  expect(t.station.client.admit).not.toHaveBeenCalled();
  expect(t.client.admit).not.toHaveBeenCalled();
});
it('pre-adoption PREPARING row remains unadopted when producer is later enabled', async () => {
  const t = await setup(true);
  await t.repository.begin(
    {
      tenantId: actor.tenantId,
      userId: actor.userId,
      keySha256: await trainingHash(input.idempotencyKey),
    },
    input,
    actor.correlationId,
    false,
  );
  await t.runtime.execute(actor, input);
  expect(t.row()?.stationMembership).toBeNull();
  expect(t.repository.pinStationPreparation).not.toHaveBeenCalled();
  expect(t.station.client.admit).not.toHaveBeenCalled();
});

it('claim-time INTENT identity is rechecked when another lease pins after the initial read', async () => {
  const t = await setup(true),
    claim = t.repository.claimPreparation.getMockImplementation()!;
  t.repository.claimPreparation.mockImplementationOnce(async () => {
    const claimed = await claim();
    if (!claimed) throw new Error('fixture');
    const authority = structuredClone(t.authority);
    authority.request.preparation.actor.providerMappingId = crypto.randomUUID();
    claimed.attempt.stationMembership = { version: 1, outcome: 'INTENT', authority };
    return claimed;
  });
  await t.runtime.execute(actor, input);
  expect(t.station.client.admit).not.toHaveBeenCalled();
  expect(t.client.prepare).not.toHaveBeenCalled();
  expect(t.client.admit).not.toHaveBeenCalled();
  expect(t.repository.settlePreparation).not.toHaveBeenCalled();
});
