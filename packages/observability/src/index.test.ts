import { describe, expect, it } from 'vitest';

import { levelEligibilityMetricAttributes, shouldIgnoreUndiciRequestPath } from './index.js';

describe('telemetry URL privacy', () => {
  it.each([
    '/sms/authentication-code?phoneNumber=79990000000',
    '/lk/communities?view=summary&phone=79990000000',
    '/lk/communities/community-id/rating?clientId=legacy-client-id',
  ])('suppresses an auto-instrumented URL carrying legacy identity: %s', (path) => {
    expect(shouldIgnoreUndiciRequestPath(path)).toBe(true);
  });

  it.each([
    '/lk/communities?view=summary',
    '/user/api/v1/local-padel/communities/mine?limit=20',
    '/health/ready',
  ])('keeps safe request paths observable: %s', (path) => {
    expect(shouldIgnoreUndiciRequestPath(path)).toBe(false);
  });
});

describe('level eligibility metric privacy', () => {
  it('uses only bounded allowlisted dimensions', () => {
    expect(
      levelEligibilityMetricAttributes({
        activityType: 'GAME',
        action: 'JOIN',
        mode: 'WARN',
        outcome: 'WARN',
        reasonCode: 'LEVEL_TOO_LOW',
      }),
    ).toEqual({
      activity_type: 'GAME',
      action: 'JOIN',
      mode: 'WARN',
      reason_code: 'LEVEL_TOO_LOW',
    });
  });
});
