import { describe, it, expect } from 'vitest';
import { loadConfig, loadWorkerConfig, loadRealtimeConfig } from './index.js';
const base = {
  APP_ENV: 'ci',
  DATABASE_URL: 'postgres://legacy:synthetic@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
  JWT_ISSUER: 'phub',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'synthetic-access-at-least-32-characters',
  JWT_REFRESH_SECRET: 'synthetic-refresh-at-least-32-characters',
};
const support = 'postgres://support_runtime:synthetic@localhost:5432/phub';
describe('support database capability config', () => {
  it('is absent by default and supported only with a separate principal over same target', () => {
    expect(loadConfig(base).SUPPORT_DATABASE_URL).toBeUndefined();
    expect(loadConfig({ ...base, SUPPORT_DATABASE_URL: support }).SUPPORT_DATABASE_URL).toBe(
      support,
    );
    expect(loadWorkerConfig({ ...base, SUPPORT_DATABASE_URL: support }).SUPPORT_DATABASE_URL).toBe(
      support,
    );
  });
  it.each([
    base.DATABASE_URL,
    'postgres://%6cegacy:synthetic@localhost:5432/phub',
    support + '?options=x',
    support + '#x',
    support.replace('/phub', '/other'),
    support.replace('localhost', 'other'),
    support.replace(':synthetic@', '@'),
    support.replace('postgres:', 'https:'),
  ])('rejects foreign or privileged target without echoing credential: %s', (value) => {
    expect(() => loadConfig({ ...base, SUPPORT_DATABASE_URL: value })).toThrow(
      'SUPPORT_DATABASE_URL requires',
    );
  });
  it('never hands the support credential to Realtime', () =>
    expect(() =>
      loadRealtimeConfig({
        ...base,
        JWT_REALTIME_SECRET: 'synthetic-realtime-at-least-32-characters',
        SUPPORT_DATABASE_URL: support,
      }),
    ).toThrow('Realtime runtime must not receive SUPPORT_DATABASE_URL'));
});
