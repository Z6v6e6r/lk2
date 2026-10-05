import { symbols } from 'pino';
import { describe, expect, it } from 'vitest';

import { createLogger, shouldIgnoreUndiciRequestPath } from './index.js';

describe('telemetry URL privacy', () => {
  it.each([
    '/sms/authentication-code?phoneNumber=79990000000',
    '/lk/communities?view=summary&phone=79990000000',
    '/lk/communities/community-id/rating?clientId=legacy-client-id',
    '/lk/support/dialogs?phone=79990000000&channel=WEB&includeClosed=1',
  ])('suppresses an auto-instrumented URL carrying legacy identity: %s', (path) => {
    expect(shouldIgnoreUndiciRequestPath(path)).toBe(true);
  });

  it.each([
    '/lk/communities?view=summary',
    '/lk/support/dialogs/dialog-id/messages?limit=50&beforeTs=1',
    '/user/api/v1/local-padel/communities/mine?limit=20',
    '/health/ready',
  ])('keeps safe request paths observable: %s', (path) => {
    expect(shouldIgnoreUndiciRequestPath(path)).toBe(false);
  });
});

describe('password recovery log privacy', () => {
  it('redacts the actual reset command and transport fields at their supported paths', () => {
    const output: string[] = [];
    const logger = createLogger('synthetic-reset', 'info');
    (logger as unknown as Record<symbol, unknown>)[symbols.streamSym] = {
      write: (line: string) => output.push(line),
    };
    const payload = {
      newPassword: 'synthetic-private-password',
      resetToken: 'synthetic-private-token',
      tokenHash: 'synthetic-private-hash',
      passwordHash: 'synthetic-private-kdf',
      emailKey: 'synthetic-private@example.test',
    };
    logger.info({
      ...payload,
      delivery: payload,
      body: { newPassword: payload.newPassword, resetToken: payload.resetToken },
      req: { body: { newPassword: payload.newPassword, resetToken: payload.resetToken } },
    });
    expect(output).toHaveLength(1);
    for (const value of Object.values(payload)) expect(output[0]).not.toContain(value);
    expect(output[0]).toContain('[REDACTED]');
  });
});
