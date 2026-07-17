import { describe, expect, it, vi } from 'vitest';

import {
  GAMES_CARD_PROJECTOR_QUEUE,
  registerGamesCardProjectorConsumer,
} from './games-card-projector-consumer.js';

describe('Games card projector consumer', () => {
  it('uses a durable bounded quorum queue for Games facts only', async () => {
    const channel = {
      assertQueue: vi.fn().mockResolvedValue({}),
      bindQueue: vi.fn().mockResolvedValue({}),
      prefetch: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn().mockResolvedValue({ consumerTag: 'games-card-projector-test' }),
    };

    await expect(
      registerGamesCardProjectorConsumer({
        channel: channel as never,
        repository: { projectCardEvent: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      }),
    ).resolves.toBe('games-card-projector-test');
    expect(channel.assertQueue).toHaveBeenCalledWith(GAMES_CARD_PROJECTOR_QUEUE, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-delivery-limit': 5,
        'x-dead-letter-exchange': 'phub.dead-letter',
      },
    });
    expect(channel.bindQueue).toHaveBeenCalledWith(
      GAMES_CARD_PROJECTOR_QUEUE,
      'phub.events',
      'game.#',
    );
    expect(channel.prefetch).toHaveBeenCalledWith(1);
  });
});
