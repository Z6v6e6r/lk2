import { describe, expect, it } from 'vitest';

import { resolveNotificationIntentState, webPushRetryDelayMs } from './web-push-delivery.js';

describe('Web Push delivery state machine', () => {
  it('uses bounded exponential retry delays', () => {
    expect(webPushRetryDelayMs(1, 5_000)).toBe(5_000);
    expect(webPushRetryDelayMs(3, 5_000)).toBe(20_000);
    expect(webPushRetryDelayMs(20, 5_000)).toBe(3_600_000);
  });

  it('keeps the intent processing until every channel reaches a terminal state', () => {
    expect(resolveNotificationIntentState(['DELIVERED', 'PENDING'])).toEqual({
      state: 'PROCESSING',
      completed: false,
    });
    expect(resolveNotificationIntentState(['DELIVERED', 'DEAD'])).toEqual({
      state: 'PARTIAL',
      completed: true,
    });
    expect(resolveNotificationIntentState(['DEAD'])).toEqual({
      state: 'FAILED',
      completed: true,
    });
  });
});
