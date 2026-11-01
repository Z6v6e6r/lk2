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
describe('local tournament activation guard', () => {
  it('defaults off without requiring owner credentials', () => {
    expect(loadConfig(env).TOURNAMENT_LOCAL_COMMANDS_ENABLED).toBe(false);
  });
  it('cannot enable without actor, discovery and trusted verifier prerequisites', () => {
    expect(() => loadConfig({ ...env, TOURNAMENT_LOCAL_COMMANDS_ENABLED: 'true' })).toThrow(
      'requires discovery and trusted actor',
    );
  });
});
