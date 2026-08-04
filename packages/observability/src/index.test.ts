import { describe, expect, it } from 'vitest';

import { shouldIgnoreUndiciRequestPath } from './index.js';

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
