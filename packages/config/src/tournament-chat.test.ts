import { describe, it, expect } from 'vitest';
import { loadConfig } from './index.js';
const env = {
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'synthetic-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'synthetic-refresh-secret-at-least-32-characters',
};
describe('dedicated tournament chat deployment namespace', () => {
  it('defaults disabled and cannot borrow user/organizer/subscription credentials', () => {
    expect(loadConfig(env).TOURNAMENT_CHAT_ENABLED).toBe(false);
    expect(() => loadConfig({ ...env, TOURNAMENT_CHAT_ENABLED: 'true' })).toThrow();
  });
  it('requires all dedicated references but creates/reads no key at config parse', () => {
    const configured = {
      ...env,
      TOURNAMENT_CHAT_ENABLED: 'true',
      TOURNAMENT_CHAT_OWNER_BASE_URL: 'https://cup.invalid',
      TOURNAMENT_CHAT_TENANT_ID: '10000000-0000-4000-8000-000000000001',
      TOURNAMENT_CHAT_TENANT_KEY: 'synthetic',
      TOURNAMENT_CHAT_ACTOR_ISSUER: 'synthetic-lk2',
      TOURNAMENT_CHAT_ACTOR_KEY_ID: 'synthetic-purpose',
      TOURNAMENT_CHAT_ACTOR_PRIVATE_KEY_FILE: '/synthetic/not-installed.pem',
    };
    expect(loadConfig(configured).TOURNAMENT_CHAT_ENABLED).toBe(true);
    for (const name of Object.keys(configured).filter(
      (k) => k.startsWith('TOURNAMENT_CHAT_') && k !== 'TOURNAMENT_CHAT_ENABLED',
    )) {
      const missing = { ...configured } as Record<string, string>;
      delete missing[name];
      expect(() => loadConfig(missing)).toThrow();
    }
  });
});
