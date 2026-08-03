import { describe, expect, it } from 'vitest';

import { rabbitReconnectDelayMs } from './rabbit-reconnect-policy.js';

describe('Rabbit reconnect policy', () => {
  it('uses bounded exponential backoff', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(rabbitReconnectDelayMs)).toEqual([
      250, 500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000,
    ]);
  });
});
