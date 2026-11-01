import { describe, it, expect } from 'vitest';
import { loadWorkerConfig } from './index.js';
const base = {
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
};
describe('station worker concrete activation gate', () => {
  it('defaults off without reading signer/provider credentials', () =>
    expect(loadWorkerConfig(base).STATION_NOTIFICATIONS_ENABLED).toBe(false));
  it('fails closed if explicitly enabled without dedicated references', () =>
    expect(() => loadWorkerConfig({ ...base, STATION_NOTIFICATIONS_ENABLED: 'true' })).toThrow(
      'STATION_NOTIFICATION_CONFIGURATION_REQUIRED',
    ));
  it.each([
    'http://owner.example.test',
    'https://owner.example.test/path',
    'https://u:p@owner.example.test',
  ])('rejects unsafe fixed origin %s', (origin) =>
    expect(() =>
      loadWorkerConfig({
        ...base,
        STATION_NOTIFICATIONS_ENABLED: 'true',
        STATION_NOTIFICATION_OWNER_ORIGIN: origin,
        STATION_NOTIFICATION_TENANT_ID: '11111111-1111-4111-8111-111111111111',
        STATION_NOTIFICATION_ISSUER: 'issuer',
        STATION_NOTIFICATION_AUDIENCE: 'audience',
        STATION_NOTIFICATION_KEY_ID: 'key',
        STATION_NOTIFICATION_PRIVATE_KEY_FILE: '/synthetic/station-key.json',
      }),
    ).toThrow('STATION_NOTIFICATION_ORIGIN_INVALID'),
  );
});
