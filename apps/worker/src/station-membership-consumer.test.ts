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
  it('declares a durable bounded-retry queue for only the existing confirmed event', async () => {
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
    expect(f.channel.bindQueue).toHaveBeenCalledOnce();
    expect(f.channel.bindQueue).toHaveBeenCalledWith(
      STATION_MEMBERSHIP_QUEUE,
      'phub.events',
      event.type,
    );
  });
});
