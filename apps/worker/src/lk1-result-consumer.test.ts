import type { ConfirmedGameResultProjection, Lk1ResultHandoff } from '@phub/database';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { registerLk1ResultBridgeConsumer } from './lk1-result-consumer.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const gameId = '6fe9dc1f-87b5-4efd-83a2-5cf9d8070b76';
const resultId = '8ef58c73-f94c-4e04-97e8-f6057afc0ec1';

const EVENT = {
  id: '3f7a1e0c-4a1e-4a0e-9a6e-1a2b3c4d5e6f',
  aggregateId: gameId,
  tenantId,
  occurredAt: '2026-11-09T09:05:00.000Z',
  correlationId: 'correlation-0001',
  type: 'game.result.confirmed.v1',
  payload: {
    gameId,
    aggregateRevision: '5',
    causationId: '2b0e1a0c-1111-4222-8333-444455556666',
    actorUserId: null,
    resultId,
    participantUserIds: [
      'f75b4e2a-9c98-4b26-85b6-ae58e0edca24',
      'a9c106f7-0db8-4e27-b1e0-298829f94730',
    ],
  },
};

const HANDOFF: Lk1ResultHandoff = {
  tenantId,
  gameId,
  resultId,
  resultRevision: 2,
  lk1GameId: '6641ab8f9c2e1d0001a2b3c4',
  submitterPhoneE164: '+79990001122',
  confirmedAt: '2026-11-09T09:05:00.000Z',
};

const PROJECTION: ConfirmedGameResultProjection = {
  tenantId,
  gameId,
  resultId,
  resultRevision: 2,
  kind: 'RATING',
  title: 'Рейтинговая игра',
  startsAt: '2026-11-09T07:00:00.000Z',
  endsAt: '2026-11-09T08:30:00.000Z',
  venueName: 'Нагатинская',
  participantUserIds: [
    'f75b4e2a-9c98-4b26-85b6-ae58e0edca24',
    'a9c106f7-0db8-4e27-b1e0-298829f94730',
  ],
  sets: [
    {
      setNumber: 1,
      teamAUserIds: [
        'f75b4e2a-9c98-4b26-85b6-ae58e0edca24',
        'a9c106f7-0db8-4e27-b1e0-298829f94730',
      ],
      teamBUserIds: [
        '6a758cce-23ab-4ffd-9c57-a1bc5d4aab70',
        'c68f263e-4a54-4472-9254-103e3b332538',
      ],
      teamA: 6,
      teamB: 4,
    },
  ],
};

function silentLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

async function deliver(options: {
  readonly handoff: Lk1ResultHandoff | undefined;
  readonly projection?: ConfirmedGameResultProjection;
  readonly importConfirmedResult?: () => Promise<'applied' | 'duplicate' | 'rejected'>;
}) {
  const captured: { handler?: (message: ConsumeMessage) => void } = {};
  const ack = vi.fn();
  const nack = vi.fn();
  const channel = {
    assertQueue: vi.fn(() => Promise.resolve({ queue: 'q' })),
    bindQueue: vi.fn(() => Promise.resolve({})),
    consume: vi.fn((_queue: string, handler: (message: ConsumeMessage) => void) => {
      captured.handler = handler;
      return Promise.resolve({ consumerTag: 'tag' });
    }),
    ack,
    nack,
  } as unknown as Channel;
  const importConfirmedResult =
    options.importConfirmedResult ?? vi.fn(() => Promise.resolve('applied' as const));
  await registerLk1ResultBridgeConsumer({
    channel,
    bridge: { loadHandoff: () => Promise.resolve(options.handoff) },
    repository: {
      loadConfirmedResult: () => Promise.resolve(options.projection ?? PROJECTION),
    },
    client: { importConfirmedResult },
    logger: silentLogger(),
  });
  captured.handler?.({ content: Buffer.from(JSON.stringify(EVENT)) } as ConsumeMessage);
  await vi.waitFor(() => {
    expect(ack.mock.calls.length + nack.mock.calls.length).toBeGreaterThan(0);
  });
  return { ack, nack, importConfirmedResult };
}

describe('LK1 result bridge consumer', () => {
  it('delivers a confirmed result of an imported game to LK1 and acknowledges it', async () => {
    const { ack, nack, importConfirmedResult } = await deliver({ handoff: HANDOFF });

    expect(importConfirmedResult).toHaveBeenCalledWith({
      handoff: HANDOFF,
      score: { scoreA: 6, scoreB: 4 },
      correlationId: 'correlation-0001',
    });
    expect(ack).toHaveBeenCalledOnce();
    expect(nack).not.toHaveBeenCalled();
  });

  it('acknowledges a game that exists only in LK2 without calling LK1', async () => {
    const { ack, nack, importConfirmedResult } = await deliver({
      handoff: { ...HANDOFF, lk1GameId: null },
    });

    expect(importConfirmedResult).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    expect(nack).not.toHaveBeenCalled();
  });

  it('acknowledges an unmapped submitter phone for reconciliation instead of retrying', async () => {
    const { ack, nack, importConfirmedResult } = await deliver({
      handoff: { ...HANDOFF, submitterPhoneE164: null },
    });

    expect(importConfirmedResult).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    expect(nack).not.toHaveBeenCalled();
  });

  it('requeues the event when the LK1 delivery fails', async () => {
    const { ack, nack } = await deliver({
      handoff: HANDOFF,
      importConfirmedResult: () => Promise.reject(new Error('LK1_RESULT_HTTP_503')),
    });

    expect(nack).toHaveBeenCalledWith(expect.anything(), false, true);
    expect(ack).not.toHaveBeenCalled();
  });
});
