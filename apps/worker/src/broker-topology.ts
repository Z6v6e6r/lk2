import type { Channel } from 'amqplib';

export const EVENT_EXCHANGE = 'phub.events';
export const DEAD_LETTER_EXCHANGE = 'phub.dead-letter';
export const DEAD_LETTER_QUEUE = 'phub.dead-letter.v1';

type BrokerTopologyChannel = Pick<Channel, 'assertExchange' | 'assertQueue' | 'bindQueue'>;

export async function registerCoreBrokerTopology(channel: BrokerTopologyChannel): Promise<void> {
  await channel.assertExchange(EVENT_EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'topic', { durable: true });
  await channel.assertQueue(DEAD_LETTER_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
    },
  });
  await channel.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, '#');
}
