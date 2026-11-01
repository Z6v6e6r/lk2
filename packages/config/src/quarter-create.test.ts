import { describe, it, expect } from 'vitest';
import { loadConfig } from './index.js';
const env = {
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://synthetic:synthetic@localhost/phub',
  REDIS_URL: 'redis://localhost',
  RABBITMQ_URL: 'amqp://localhost',
  JWT_ISSUER: 'fixture',
  JWT_AUDIENCE: 'fixture',
  JWT_ACCESS_SECRET: 'synthetic-access-not-a-secret-123456789',
  JWT_REFRESH_SECRET: 'synthetic-refresh-not-a-secret-123456789',
};
describe('quarter CREATE opt-in compatibility', () => {
  it('preserves default off and original advisory selector', () => {
    const c = loadConfig(env);
    expect(c.GAME_COMMERCIAL_CREATE_ENABLED).toBe(false);
    expect(c.GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT).toBe('ADVISORY');
  });
  it('explicit quarter selector cannot fall through missing existing gates/credentials', () => {
    expect(() =>
      loadConfig({ ...env, GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT: 'QUARTER_OWNER' }),
    ).toThrow('complete owner and actor');
    expect(() =>
      loadConfig({
        ...env,
        GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT: 'QUARTER_OWNER',
        GAME_COMMERCIAL_CREATE_ENABLED: 'true',
      }),
    ).toThrow();
  });
  it('keeps booked-operation unavailable and production commercial-create prohibition', () => {
    expect(() =>
      loadConfig({ ...env, GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT: 'BOOKED_OPERATION' }),
    ).toThrow('BOOKED_OPERATION');
    expect(() =>
      loadConfig({
        ...env,
        APP_ENV: 'production',
        GAME_COMMERCIAL_CREATE_ENABLED: 'true',
        GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT: 'QUARTER_OWNER',
      }),
    ).toThrow();
  });
});
