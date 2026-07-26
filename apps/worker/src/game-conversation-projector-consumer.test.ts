import { describe, expect, it, vi } from 'vitest';

import {
  GAME_CONVERSATION_PROJECTOR_QUEUE,
  registerGameConversationProjectorConsumer,
} from './game-conversation-projector-consumer.js';

describe('Game conversation projector consumer', () => {
  it('uses a durable bounded quorum queue for canonical Games facts', async () => {
    const channel = {
      assertQueue: vi.fn().mockResolvedValue({}),
      bindQueue: vi.fn().mockResolvedValue({}),
      prefetch: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn().mockResolvedValue({ consumerTag: 'game-conversation-projector-test' }),
    };

    await expect(
      registerGameConversationProjectorConsumer({
        channel: channel as never,
        repository: { projectGameConversation: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      }),
    ).resolves.toBe('game-conversation-projector-test');
    expect(channel.assertQueue).toHaveBeenCalledWith(GAME_CONVERSATION_PROJECTOR_QUEUE, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-delivery-limit': 5,
        'x-dead-letter-exchange': 'phub.dead-letter',
      },
    });
    expect(channel.bindQueue).toHaveBeenCalledWith(
      GAME_CONVERSATION_PROJECTOR_QUEUE,
      'phub.events',
      'game.#',
    );
    expect(channel.prefetch).toHaveBeenCalledWith(1);
  });
});
