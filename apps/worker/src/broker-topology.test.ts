import { describe, expect, it, vi } from 'vitest';

import {
  DEAD_LETTER_EXCHANGE,
  DEAD_LETTER_QUEUE,
  EVENT_EXCHANGE,
  registerCoreBrokerTopology,
} from './broker-topology.js';

describe('core RabbitMQ topology', () => {
  it('retains rejected events in a durable quorum dead-letter queue', async () => {
    const channel = {
      assertExchange: vi.fn().mockResolvedValue({}),
      assertQueue: vi.fn().mockResolvedValue({}),
      bindQueue: vi.fn().mockResolvedValue({}),
    };

    await expect(registerCoreBrokerTopology(channel as never)).resolves.toBeUndefined();

    expect(channel.assertExchange).toHaveBeenCalledWith(EVENT_EXCHANGE, 'topic', {
      durable: true,
    });
    expect(channel.assertExchange).toHaveBeenCalledWith(DEAD_LETTER_EXCHANGE, 'topic', {
      durable: true,
    });
    expect(channel.assertQueue).toHaveBeenCalledWith(DEAD_LETTER_QUEUE, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
      },
    });
    expect(channel.bindQueue).toHaveBeenCalledWith(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, '#');
  });
});
