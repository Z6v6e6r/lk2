import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';

import type { WholeCourtCheckoutReceipt } from '@phub/database';
import { decodeJwt } from 'jose';
import { expect, it, vi } from 'vitest';

import {
  SubscriptionRuntimeActorDelegationIssuer,
  subscriptionRuntimeIdempotencyKeySha256,
} from '../subscriptions/subscription-runtime-actor-delegation-issuer.js';
import {
  commercialCreateDraftGameId,
  commercialCreateOperationId,
  type CommercialCreateCommandEnvelope,
} from './game-create-commercial.js';
import { createWholeCourtRuntime, parseWholeCourtPilot } from './game-whole-court-create.js';
import { createWholeCourtOwner, type WholeCourtOwnerBody } from './game-whole-court-owner.js';

const actor = {
  tenantId: randomUUID(),
  userId: randomUUID(),
  tenantKey: 'iSkq6G',
  sessionId: randomUUID(),
  correlationId: 'checkout-fixture',
};
const idempotencyKey = randomUUID();
const keySha = subscriptionRuntimeIdempotencyKeySha256(idempotencyKey);
const identity = { ...actor, idempotencyKeySha256: keySha };
const operationId = commercialCreateOperationId(identity);
const draftId = commercialCreateDraftGameId(identity);
const at = new Date(Date.now() + 86400000);
at.setUTCHours(12, 0, 0, 0);
const pilot = {
  tenantId: actor.tenantId,
  userId: actor.userId,
  stationId: randomUUID(),
  courtId: randomUUID(),
  startsAt: at.toISOString(),
  endsAt: new Date(at.getTime() + 3600000).toISOString(),
  amountMinor: 120000,
};
const checkout = 'https://pay.vivacrm.ru/fixture-checkout';
const token = {
  token: 'synthetic-fixture-bearer',
  expiresAt: new Date(Date.now() + 600000).toISOString(),
};
const binding = {
  providerClientId: 'fixture-client',
  providerStationId: 'fixture-station',
  providerRoomId: 'fixture-room',
  amountMinor: pilot.amountMinor,
};
const wire: WholeCourtOwnerBody = {
  contractVersion: 1,
  action: 'CREATE_GAME',
  operationId,
  draftId,
  stationId: binding.providerStationId,
  roomId: binding.providerRoomId,
  startsAt: pilot.startsAt,
  endsAt: pilot.endsAt,
  amountMinor: pilot.amountMinor,
  currency: 'RUB',
};
const claim = { operationId, draftId };
const acknowledgedPayment: WholeCourtCheckoutReceipt = {
  provider: 'VIVA',
  bookingId: 'fixture-booking',
  transactionId: 'fixture-transaction',
  exerciseId: 'fixture-exercise',
  amountMinor: pilot.amountMinor,
  currency: 'RUB',
  confirmedAt: new Date().toISOString(),
};

it('signs exactly the #485 claim set and dispatches the same canonical body', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issuer = new SubscriptionRuntimeActorDelegationIssuer({
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    keyId: 'fixture-key',
    issuer: 'fixture-issuer',
    audience: 'fixture-audience',
    ttlSeconds: 30,
  });
  const delegation = await issuer.issueWholeCourtCheckout({
    ...actor,
    mode: 'reserve',
    body: wire,
    providerClientId: binding.providerClientId,
    actorToken: token,
    idempotencyKeySha256: keySha,
  });
  const decoded = decodeJwt(delegation);
  expect(Object.keys(decoded).sort()).toEqual(
    'iss,aud,sub,iat,nbf,exp,jti,sid,contract_version,caller,scope,method,path,tenant_id,tenant_key,provider,provider_client_id,operation_id,request_sha256,correlation_id,idempotency_key_sha256,actor_token_sha256,actor_token_expires_at'
      .split(',')
      .sort(),
  );
  const raw = JSON.stringify(wire);
  expect(decoded.request_sha256).toBe(
    'sha256:' +
      createHash('sha256')
        .update('whole-court:reserve:v1\0' + raw)
        .digest('hex'),
  );
  expect(decoded.scope).toBe('game-create.whole-court.reserve');
  const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      ...claim,
      status: 'AWAITING_PAYMENT',
      paymentUrl: checkout,
      expiresAt: token.expiresAt,
      amountMinor: pilot.amountMinor,
      currency: 'RUB',
    }),
  );
  const owner = createWholeCourtOwner({
    baseUrl: 'https://padlhub.su',
    timeoutMs: 500,
    fetchImplementation,
  });
  expect(
    (
      await owner({
        mode: 'reserve',
        body: wire,
        delegation,
        token: token.token,
        correlationId: actor.correlationId,
      })
    ).status,
  ).toBe('AWAITING_PAYMENT');
  expect(fetchImplementation).toHaveBeenCalledExactlyOnceWith(
    'https://padlhub.su/lk/integrations/v1/whole-court-checkout/reserve',
    expect.objectContaining({ method: 'POST', redirect: 'error', body: raw }),
  );
});

it('keeps malformed checkout and receipts unresolved without retrying', async () => {
  for (const response of [
    {
      ...claim,
      status: 'AWAITING_PAYMENT',
      paymentUrl: 'https://outside.invalid/',
      expiresAt: token.expiresAt,
      currency: 'RUB',
      amountMinor: pilot.amountMinor,
    },
    { ...claim, status: 'CONFIRMED', receipt: { ...acknowledgedPayment, amountMinor: 1 } },
    { ...claim, draftId: randomUUID(), status: 'CONFIRMED', receipt: acknowledgedPayment },
  ]) {
    const fn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
    const call = createWholeCourtOwner({
      baseUrl: 'https://padlhub.su',
      timeoutMs: 500,
      fetchImplementation: fn,
    });
    await expect(
      call({
        mode: 'reserve',
        body: wire,
        delegation: 'fixture',
        token: token.token,
        correlationId: actor.correlationId,
      }),
    ).resolves.toEqual({ status: 'UNKNOWN' });
    expect(fn).toHaveBeenCalledOnce();
  }
});

it('opens only the stored checkout, confirms the original operation, and does not expose provider IDs', async () => {
  const original = {
    gameId: draftId,
    startsAt: pilot.startsAt,
    endsAt: pilot.endsAt,
    state: 'PENDING',
    revision: 1,
    binding,
    receipt: null,
    projectionEventId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const event = randomUUID();
  const read = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue(original);
  const finalize = vi.fn().mockImplementation(() => {
    read.mockResolvedValue({
      ...original,
      revision: 2,
      state: 'SUCCEEDED',
      receipt: acknowledgedPayment,
      projectionEventId: event,
    });
    return Promise.resolve();
  });
  const create = vi.fn().mockResolvedValue({
    outcome: 'applied',
    gameId: draftId,
    operationId,
    revision: 1,
    committedAt: original.createdAt,
    replayed: false,
  });
  const owner = vi
    .fn<ReturnType<typeof createWholeCourtOwner>>()
    .mockResolvedValueOnce({
      status: 'AWAITING_PAYMENT',
      url: checkout,
      expiresAt: token.expiresAt,
    })
    .mockResolvedValueOnce({ status: 'CONFIRMED', receipt: acknowledgedPayment });
  const projectCardEvent = vi.fn().mockResolvedValue('applied');
  const mapping = {
    outcome: 'ok' as const,
    providerMappingId: randomUUID(),
    providerClientId: binding.providerClientId,
  };
  const resolve = vi.fn().mockResolvedValue(mapping);
  const onMetric = vi.fn<(outcome: string) => void>();
  const runtime = createWholeCourtRuntime({
    pilot: parseWholeCourtPilot(JSON.stringify(pilot)),
    repository: { read, finalize },
    owner,
    context: { resolve },
    onMetric,
    games: {
      create,
      projectCardEvent,
      getCardProjection: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue({ aggregateRevision: 2 }),
    },
    issuer: { issueWholeCourtCheckout: vi.fn().mockResolvedValue('fixture-delegation') },
    token: vi.fn().mockResolvedValue(token),
    location: vi.fn().mockResolvedValue({
      providerStationId: binding.providerStationId,
      providerRoomId: binding.providerRoomId,
    }),
  });
  const request: CommercialCreateCommandEnvelope = {
    ...identity,
    idempotencyKey,
    priceConsent: { amountMinor: pilot.amountMinor, currency: 'RUB' },
    payload: {
      stationId: pilot.stationId,
      courtId: pilot.courtId,
      startsAt: pilot.startsAt,
      endsAt: pilot.endsAt,
      paymentMode: 'ORGANIZER_PAYS',
      timezone: 'Europe/Moscow',
      kind: 'FRIENDLY',
      visibility: 'PRIVATE',
      capacity: 4,
      waitlistEnabled: false,
      title: 'Checkout fixture',
    },
  };
  await expect(
    runtime.start({ ...request, priceConsent: { currency: 'RUB', amountMinor: 1 } }),
  ).rejects.toThrow('GAME_PRICE_CONFIRMATION_REQUIRED');
  expect(create).not.toHaveBeenCalled();
  expect(owner).not.toHaveBeenCalled();
  const started = await runtime.start(request);
  expect(started.operation).toMatchObject({
    gameId: draftId,
    id: operationId,
    status: 'PROCESSING',
    nextAction: { type: 'OPEN_PAYMENT', url: checkout },
  });
  await expect(
    runtime.resume(
      { ...actor, userId: randomUUID() },
      { operationId, idempotencyKey, mode: 'confirm' },
    ),
  ).rejects.toThrow('GAME_OPERATION_NOT_FOUND');
  resolve
    .mockResolvedValueOnce(mapping)
    .mockResolvedValueOnce({ ...mapping, providerMappingId: randomUUID() });
  expect(
    (await runtime.resume(actor, { operationId, idempotencyKey, mode: 'confirm' })).operation
      .status,
  ).toBe('UNKNOWN');
  expect(owner).toHaveBeenCalledOnce();
  expect(onMetric).toHaveBeenCalledWith('ACTOR_MAPPING_CHANGED');
  const settled = await runtime.resume(actor, { operationId, idempotencyKey, mode: 'confirm' });
  expect(settled.operation).toMatchObject({
    gameId: draftId,
    status: 'SUCCEEDED',
    commercial: {
      attemptState: 'OWNER_CONFIRMED',
      receipt: {
        provider: 'VIVA',
        status: 'CONFIRMED',
        confirmedAt: acknowledgedPayment.confirmedAt,
      },
    },
  });
  expect(JSON.stringify(settled)).not.toContain(acknowledgedPayment.transactionId);
  expect(await runtime.resume(actor, { operationId, idempotencyKey, mode: 'confirm' })).toEqual(
    settled,
  );
  expect(owner.mock.calls.map(([input]) => input)).toMatchObject([
    { mode: 'reserve', body: wire },
    { mode: 'confirm', body: wire },
  ]);
  expect(create).toHaveBeenCalledOnce();
  expect(finalize).toHaveBeenCalledOnce();
  expect(projectCardEvent).toHaveBeenCalledExactlyOnceWith({
    eventId: event,
    tenantId: actor.tenantId,
    gameId: draftId,
  });
});
