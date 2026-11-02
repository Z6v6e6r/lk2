import { describe, expect, it, vi } from 'vitest';
import type { Channel, ConsumeMessage } from 'amqplib';
import {
  handleStationMembershipMessage,
  registerStationMembershipConsumer,
  STATION_MEMBERSHIP_QUEUE,
} from './station-membership-consumer.js';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const event = {
  id: id(1),
  type: 'game.participation.confirmed.v1',
  tenantId: id(2),
  aggregateId: id(3),
  occurredAt: '2026-10-31T10:00:00.000Z',
  correlationId: 'synthetic-correlation',
  payload: {
    gameId: id(3),
    aggregateRevision: '3',
    causationId: id(9),
    actorUserId: id(4),
    userId: id(4),
    participationId: id(5),
  },
};
function fixture() {
  const channel = {
    ack: vi.fn(),
    nack: vi.fn(),
    reject: vi.fn(),
    assertQueue: vi.fn(),
    bindQueue: vi.fn(),
    prefetch: vi.fn(),
    consume: vi.fn(() => Promise.resolve({ consumerTag: 'test' })),
  };
  const fact = {
    actor: {
      tenantId: id(2),
      canonicalUserId: id(4),
      playerId: 'synthetic',
      providerMappingId: id(6),
    },
    correlationId: 'original-correlation',
    request: {
      contractVersion: 1 as const,
      operationId: id(7),
      admissionId: id(8),
      admissionBindingSha256: 'sha256:' + 'a'.repeat(64),
      confirmation: { kind: 'GAME_PARTICIPATION' as const, generationId: id(5), activityId: id(3) },
    },
  };
  const repository = {
    loadConfirmedFact: vi.fn(() => Promise.resolve(fact as typeof fact | null)),
  };
  const signer = { issue: vi.fn(() => 'synthetic.delegation.only') };
  const client = {
    confirm: vi.fn(() =>
      Promise.resolve({ outcome: 'ENROLLED' as const, reason: 'CONFIRMED_MEMBERSHIP' }),
    ),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    channel,
    repository,
    signer,
    client,
    logger,
    fact,
    options: { channel: channel as unknown as Channel, repository, signer, client, logger },
  };
}
const message = (data: unknown = event) =>
  ({
    content: Buffer.from(JSON.stringify(data)),
    properties: { messageId: event.id },
  }) as ConsumeMessage;
describe('station delivery from persisted confirmation', () => {
  it('uses original operation/generation and database correlation, never confirmation command ID', async () => {
    const f = fixture(),
      m = message();
    await handleStationMembershipMessage(f.options, m);
    expect(f.repository.loadConfirmedFact).toHaveBeenCalledWith({
      tenantId: id(2),
      eventId: id(1),
      gameId: id(3),
      userId: id(4),
      participationId: id(5),
    });
    expect(f.signer.issue).toHaveBeenCalledWith({
      mode: 'confirmation',
      caller: 'lk2-worker',
      ...f.fact,
    });
    expect(f.client.confirm).toHaveBeenCalledWith(f.fact.request, {
      delegation: 'synthetic.delegation.only',
      correlationId: 'original-correlation',
    });
    expect(f.channel.ack).toHaveBeenCalledWith(m);
    expect(f.channel.reject).not.toHaveBeenCalled();
  });
  it('unadopted history does not sign or send an enrollment', async () => {
    const f = fixture();
    f.repository.loadConfirmedFact.mockResolvedValue(null);
    await handleStationMembershipMessage(f.options, message());
    expect(f.signer.issue).not.toHaveBeenCalled();
    expect(f.client.confirm).not.toHaveBeenCalled();
    expect(f.channel.ack).toHaveBeenCalledOnce();
  });
  it('lost ACK redelivery reloads exactly the same fact and never substitutes a new generation', async () => {
    const f = fixture(),
      m = message();
    f.client.confirm.mockRejectedValueOnce(new Error('ack lost'));
    await handleStationMembershipMessage(f.options, m);
    expect(f.channel.reject).toHaveBeenCalledWith(m, true);
    expect(f.channel.ack).not.toHaveBeenCalled();
    await handleStationMembershipMessage(f.options, m);
    expect(f.repository.loadConfirmedFact).toHaveBeenCalledTimes(2);
    expect(f.client.confirm.mock.calls[0]).toEqual(f.client.confirm.mock.calls[1]);
    expect(f.channel.ack).toHaveBeenCalledOnce();
  });
  it('a durable owner refusal for old epoch or ban is terminal, not a booking retry', async () => {
    const f = fixture();
    f.client.confirm.mockResolvedValue({
      outcome: 'NOT_ENROLLED',
      reason: 'MEMBERSHIP_BLOCKED',
    } as never);
    await handleStationMembershipMessage(f.options, message());
    expect(f.channel.ack).toHaveBeenCalledOnce();
    expect(f.channel.reject).not.toHaveBeenCalled();
  });
  it.each([
    { ...event, id: id(88) },
    { ...event, type: 'game.participation.left.v1' },
    { ...event, payload: { ...event.payload, participationId: 'bad' } },
  ])('rejects wrong event identity/type/generation before storage or signer', async (data) => {
    const f = fixture();
    await handleStationMembershipMessage(f.options, message(data));
    expect(f.repository.loadConfirmedFact).not.toHaveBeenCalled();
    expect(f.signer.issue).not.toHaveBeenCalled();
    expect(f.channel.nack).toHaveBeenCalledOnce();
  });
  it('declares a durable bounded-retry queue for the three explicit confirmed events', async () => {
    const f = fixture();
    await registerStationMembershipConsumer(f.options);
    expect(f.channel.assertQueue).toHaveBeenCalledWith(STATION_MEMBERSHIP_QUEUE, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-delivery-limit': 5,
        'x-dead-letter-exchange': 'phub.dead-letter',
      },
    });
    expect(f.channel.bindQueue).toHaveBeenCalledTimes(3);
    expect(f.channel.bindQueue).toHaveBeenCalledWith(
      STATION_MEMBERSHIP_QUEUE,
      'phub.events',
      event.type,
    );
  });
});

it('training event uses only original receipt-backed fact; wrong status and kind are rejected', async () => {
  const f = fixture(),
    trainingEvent = {
      ...event,
      type: 'training.registration.confirmed.v1',
      payload: { operationId: id(7), trainingId: id(3), userId: id(4), status: 'CONFIRMED' },
    };
  const fact = {
    ...f.fact,
    request: {
      ...f.fact.request,
      confirmation: {
        kind: 'TRAINING_REGISTRATION' as const,
        generationId: id(15),
        activityId: id(3),
      },
    },
  };
  const trainingRepository = { loadTrainingConfirmedFact: vi.fn(() => Promise.resolve(fact)) };
  await handleStationMembershipMessage(
    { ...f.options, trainingRepository },
    message(trainingEvent),
  );
  expect(trainingRepository.loadTrainingConfirmedFact).toHaveBeenCalledWith({
    tenantId: id(2),
    eventId: id(1),
    trainingId: id(3),
    userId: id(4),
    operationId: id(7),
  });
  expect(f.repository.loadConfirmedFact).not.toHaveBeenCalled();
  expect(f.client.confirm).toHaveBeenCalledWith(fact.request, expect.anything());
  await handleStationMembershipMessage(
    { ...f.options, trainingRepository },
    message({ ...trainingEvent, payload: { ...trainingEvent.payload, status: 'PENDING' } }),
  );
  expect(trainingRepository.loadTrainingConfirmedFact).toHaveBeenCalledOnce();
  expect(f.channel.nack).toHaveBeenCalledOnce();
});

describe('explicit CREATE organizer confirmation event', () => {
  const created = {
    id: id(1),
    type: 'game.quarter-create.organizer-confirmed.v1',
    tenantId: id(2),
    aggregateId: id(7),
    occurredAt: '2026-11-01T10:00:00.000Z',
    correlationId: 'synthetic-create',
    payload: {
      operationId: id(7),
      draftId: id(3),
      userId: id(4),
      generationId: id(5),
      status: 'CONFIRMED',
    },
  };
  it('loads original durable CREATE fact, signs exact explicit kind and retries same generation after ACK loss', async () => {
    const f = fixture(),
      fact = {
        ...f.fact,
        request: {
          ...f.fact.request,
          confirmation: {
            kind: 'GAME_CREATE_ORGANIZER' as const,
            generationId: id(5),
            activityId: id(3),
          },
        },
      },
      quarterRepository = { loadQuarterConfirmedFact: vi.fn(() => Promise.resolve(fact)) },
      options = { ...f.options, quarterRepository };
    f.client.confirm.mockRejectedValueOnce(new Error('lost ack'));
    const m = message(created);
    await handleStationMembershipMessage(options, m);
    expect(f.channel.reject).toHaveBeenCalledWith(m, true);
    await handleStationMembershipMessage(options, m);
    expect(f.channel.ack).toHaveBeenCalledOnce();
    expect(f.repository.loadConfirmedFact).not.toHaveBeenCalled();
    expect(quarterRepository.loadQuarterConfirmedFact).toHaveBeenCalledWith({
      tenantId: id(2),
      eventId: id(1),
      operationId: id(7),
      draftId: id(3),
      userId: id(4),
      generationId: id(5),
    });
    expect(f.signer.issue).toHaveBeenCalledWith({
      mode: 'confirmation',
      caller: 'lk2-worker',
      ...fact,
    });
    expect(f.client.confirm.mock.calls[0]).toEqual(f.client.confirm.mock.calls[1]);
    expect(JSON.stringify(f.logger.info.mock.calls)).not.toContain('synthetic.delegation');
  });
  it('missing or corrupt CREATE journal retries without signing; malformed/foreign payload is rejected', async () => {
    const f = fixture(),
      m = message(created);
    await handleStationMembershipMessage(f.options, m);
    expect(f.channel.reject).toHaveBeenCalledWith(m, true);
    const options = {
      ...f.options,
      quarterRepository: {
        loadQuarterConfirmedFact: vi.fn(() => Promise.reject(new Error('corrupt receipt'))),
      },
    };
    await handleStationMembershipMessage(options, m);
    expect(f.signer.issue).not.toHaveBeenCalled();
    await handleStationMembershipMessage(
      options,
      message({ ...created, payload: { ...created.payload, providerExerciseId: 'private' } }),
    );
    expect(f.channel.nack).toHaveBeenCalled();
  });
  it('binds exact CREATE event on existing durable bounded queue', async () => {
    const f = fixture();
    await registerStationMembershipConsumer(f.options);
    expect(f.channel.bindQueue).toHaveBeenCalledWith(
      STATION_MEMBERSHIP_QUEUE,
      'phub.events',
      'game.quarter-create.organizer-confirmed.v1',
    );
  });
});
