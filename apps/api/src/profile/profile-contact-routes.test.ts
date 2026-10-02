import { loadConfig } from '@phub/config';
import type { ContactReader } from '@phub/database/contacts';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthService, AuthUser } from '../auth/auth-service.js';
import { buildApp } from '../app.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const otherTenantId = '11111111-1111-4111-8111-111111111111';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const otherUserId = '22222222-2222-4222-8222-222222222222';
const config = loadConfig({
  APP_ENV: 'ci',
  VIVA_MODE: 'mock',
  DATABASE_URL: 'postgresql://synthetic:synthetic@localhost:5432/synthetic',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://localhost:5672',
  JWT_ISSUER: 'contact-test',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'synthetic-contact-access-secret-32-characters',
  JWT_REFRESH_SECRET: 'synthetic-contact-refresh-secret-32-characters',
});
const contact = {
  id: '33333333-3333-4333-8333-333333333333',
  userId,
  type: 'EMAIL' as const,
  normalizedValue: 'own@example.test',
  sourceKind: 'LOCAL' as const,
  sourceUpdatedAt: null,
  version: 1,
  createdAt: new Date('2026-09-30T10:00:00Z'),
  updatedAt: new Date('2026-09-30T10:00:00Z'),
  createdByActorId: 'must-not-be-serialized',
  verifiedAt: 'must-not-be-serialized',
};
const path = '/user/api/v1/local-padel/profile/contacts';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function token(
  options: {
    sub?: string;
    tenants?: string[];
    permissions?: string[];
    audience?: string;
    expiry?: string;
  } = {},
) {
  return new SignJWT({
    tenants: options.tenants ?? [tenantId],
    roles: ['client'],
    permissions: options.permissions ?? ['profile.read'],
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(options.audience ?? config.JWT_AUDIENCE)
    .setSubject(options.sub ?? userId)
    .setExpirationTime(options.expiry ?? '5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}
async function setup(
  reader?: ContactReader,
  getUserContext: (tenant: string, subject: string) => Promise<AuthUser | undefined> = (
    tenant,
    subject,
  ) =>
    Promise.resolve({
      id: subject,
      tenantId: tenant,
      displayName: 'Synthetic contact user',
    }),
) {
  const pool = {
    query: vi.fn((_sql: string, args: string[]) =>
      Promise.resolve({
        rows: [{ id: args[0] === 'other-padel' ? otherTenantId : tenantId }],
      }),
    ),
  } as unknown as Pool;
  const app = await buildApp({
    config,
    pool,
    authService: { getUserContext } as unknown as AuthService,
    logger: createLogger('contacts-test', 'silent'),
    ...(reader ? { profileContactReader: reader } : {}),
  });
  apps.push(app);
  return app;
}

describe('self-only contact read API', () => {
  it('uses verified subject/tenant and serializes only contact/provenance fields', async () => {
    const listForUser = vi.fn<ContactReader['listForUser']>().mockResolvedValue([
      contact,
      {
        ...contact,
        id: '44444444-4444-4444-8444-444444444444',
        type: 'PHONE',
        normalizedValue: '+79990000001',
        sourceKind: 'VIVA',
        sourceUpdatedAt: new Date('2026-09-30T09:00:00Z'),
      },
    ]);
    const app = await setup({ listForUser });
    const response = await app.inject({
      url: path,
      headers: {
        authorization: `Bearer ${await token()}`,
        'x-correlation-id': 'contacts-read-test',
        'x-user-id': otherUserId,
        'x-tenant-id': otherTenantId,
        'x-app-platform': 'cup-admin',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(listForUser).toHaveBeenCalledExactlyOnceWith(tenantId, userId);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-correlation-id']).toBe('contacts-read-test');
    expect(response.json()).toEqual({
      contacts: [
        {
          id: contact.id,
          type: 'EMAIL',
          normalizedValue: 'own@example.test',
          provenance: { sourceKind: 'LOCAL', sourceUpdatedAt: null },
        },
        {
          id: '44444444-4444-4444-8444-444444444444',
          type: 'PHONE',
          normalizedValue: '+79990000001',
          provenance: { sourceKind: 'VIVA', sourceUpdatedAt: '2026-09-30T09:00:00.000Z' },
        },
      ],
    });
  });

  it('returns an empty list without fabricating a contact from the legacy profile', async () => {
    const reader = { listForUser: vi.fn<ContactReader['listForUser']>().mockResolvedValue([]) };
    const app = await setup(reader);
    const response = await app.inject({
      url: path,
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ contacts: [] });
    const oldProfile = await app.inject({
      url: '/user/api/v1/local-padel/profile',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(oldProfile.statusCode).toBe(200);
    expect(oldProfile.json()).toHaveProperty('userId', userId);
    expect(oldProfile.json()).not.toHaveProperty('contacts');
    expect(reader.listForUser).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing', undefined],
    ['invalid', 'invalid'],
    ['expired', { expiry: '-1s' }],
    ['admin audience', { audience: config.JWT_ADMIN_AUDIENCE }],
    ['malformed subject', { sub: 'not-a-uuid' }],
  ] as const)('rejects %s authentication before reading PII', async (_name, input) => {
    const reader = {
      listForUser: vi.fn<ContactReader['listForUser']>().mockResolvedValue([contact]),
    };
    const app = await setup(reader);
    const bearer =
      input === undefined ? undefined : typeof input === 'string' ? input : await token(input);
    const response = await app.inject({
      url: path,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(reader.listForUser).not.toHaveBeenCalled();
    expect(response.body).not.toContain(contact.normalizedValue);
  });

  it('denies a tenant absent from verified claims', async () => {
    const reader = {
      listForUser: vi.fn<ContactReader['listForUser']>().mockResolvedValue([contact]),
    };
    const app = await setup(reader);
    const response = await app.inject({
      url: path.replace('local-padel', 'other-padel'),
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
    expect(reader.listForUser).not.toHaveBeenCalled();
  });

  it('denies a session without profile.read', async () => {
    const reader = {
      listForUser: vi.fn<ContactReader['listForUser']>().mockResolvedValue([contact]),
    };
    const app = await setup(reader);
    const response = await app.inject({
      url: path,
      headers: { authorization: `Bearer ${await token({ permissions: [] })}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'PROFILE_CONTACTS_PERMISSION_REQUIRED' });
    expect(reader.listForUser).not.toHaveBeenCalled();
  });

  it.each(['userId', 'tenantId', 'type', 'normalizedValue', 'limit'])(
    'rejects query selector %s',
    async (field) => {
      const reader = {
        listForUser: vi.fn<ContactReader['listForUser']>().mockResolvedValue([contact]),
      };
      const app = await setup(reader);
      const response = await app.inject({
        url: `${path}?${field}=${otherUserId}`,
        headers: { authorization: `Bearer ${await token()}` },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'PROFILE_CONTACTS_QUERY_INVALID' });
      expect(reader.listForUser).not.toHaveBeenCalled();
    },
  );

  it('separates two session subjects even inside the same tenant', async () => {
    const listForUser = vi
      .fn<ContactReader['listForUser']>()
      .mockImplementation((_tenant, subject) =>
        Promise.resolve(subject === userId ? [contact] : []),
      );
    const app = await setup({ listForUser });
    const response = await app.inject({
      url: path,
      headers: { authorization: `Bearer ${await token({ sub: otherUserId })}` },
    });
    expect(response.json()).toEqual({ contacts: [] });
    expect(listForUser).toHaveBeenCalledExactlyOnceWith(tenantId, otherUserId);
  });

  it('fails closed when the reader returns another user contact', async () => {
    const app = await setup({
      listForUser: () => Promise.resolve([{ ...contact, userId: otherUserId }]),
    });
    const response = await app.inject({
      url: path,
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain(contact.normalizedValue);
  });

  it.each(['absent', 'database failure', 'invalid timestamp'])(
    'reports %s as unavailable without PII',
    async (failure) => {
      const reader =
        failure === 'absent'
          ? undefined
          : {
              listForUser: () =>
                failure === 'database failure'
                  ? Promise.reject(new Error('permission denied own@example.test +79990000001'))
                  : Promise.resolve([{ ...contact, sourceUpdatedAt: new Date('invalid') }]),
            };
      const app = await setup(reader);
      const response = await app.inject({
        url: path,
        headers: { authorization: `Bearer ${await token()}` },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'PROFILE_CONTACTS_UNAVAILABLE' });
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body).not.toContain(contact.normalizedValue);
      expect(response.body).not.toContain('+79990000001');
    },
  );

  it.each(['missing', 'wrong user', 'wrong tenant'])(
    'denies %s current account before PII read',
    async (kind) => {
      const listForUser = vi.fn<ContactReader['listForUser']>().mockResolvedValue([contact]);
      const getUserContext = vi.fn<AuthService['getUserContext']>().mockResolvedValue(
        kind === 'missing'
          ? undefined
          : {
              id: kind === 'wrong user' ? otherUserId : userId,
              tenantId: kind === 'wrong tenant' ? otherTenantId : tenantId,
              displayName: 'Synthetic',
            },
      );
      const app = await setup({ listForUser }, getUserContext);
      const response = await app.inject({
        url: path,
        headers: { authorization: `Bearer ${await token()}` },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: 'AUTH_SESSION_REVOKED' });
      expect(getUserContext).toHaveBeenCalledExactlyOnceWith(tenantId, userId);
      expect(listForUser).not.toHaveBeenCalled();
      expect(response.headers['cache-control']).toBe('private, no-store');
    },
  );

  it('fails closed without the runtime account checker', async () => {
    const listForUser = vi.fn<ContactReader['listForUser']>().mockResolvedValue([contact]);
    const pool = { query: () => Promise.resolve({ rows: [{ id: tenantId }] }) } as unknown as Pool;
    const app = await buildApp({
      config,
      pool,
      profileContactReader: { listForUser },
      logger: createLogger('contacts-test', 'silent'),
    });
    apps.push(app);
    const response = await app.inject({
      url: path,
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'PROFILE_CONTACTS_UNAVAILABLE' });
    expect(listForUser).not.toHaveBeenCalled();
  });

  it('redacts account checker failures and skips the contact reader', async () => {
    const listForUser = vi.fn<ContactReader['listForUser']>().mockResolvedValue([contact]);
    const app = await setup({ listForUser }, () =>
      Promise.reject(new Error('private own@example.test')),
    );
    const response = await app.inject({
      url: path,
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain(contact.normalizedValue);
    expect(listForUser).not.toHaveBeenCalled();
  });

  it('keeps error details and rejected selector values out of logs', async () => {
    const lines: string[] = [];
    const logger = pino(
      { level: 'warn' },
      {
        write: (line) => {
          lines.push(line);
        },
      },
    );
    const pool = { query: () => Promise.resolve({ rows: [{ id: tenantId }] }) } as unknown as Pool;
    const app = await buildApp({
      config,
      pool,
      logger,
      authService: {
        getUserContext: () => Promise.resolve({ id: userId, tenantId, displayName: 'Synthetic' }),
      } as unknown as AuthService,
      profileContactReader: {
        listForUser: () => Promise.reject(new Error('private own@example.test +79990000001 SQL')),
      },
    });
    apps.push(app);
    const authorization = `Bearer ${await token()}`;
    const failed = await app.inject({
      url: path,
      headers: { authorization, 'x-correlation-id': 'contacts-log-test' },
    });
    expect(failed.statusCode).toBe(503);
    const rejected = await app.inject({
      url: `${path}?normalizedValue=own%40example.test`,
      headers: { authorization },
    });
    expect(rejected.statusCode).toBe(400);
    expect(lines.join('')).toContain('profile contacts read failed');
    expect(lines.join('')).toContain('contacts-log-test');
    expect(lines.join('')).not.toContain('own@example.test');
    expect(lines.join('')).not.toContain('+79990000001');
    expect(lines.join('')).not.toContain(authorization);
    expect(lines.join('')).not.toContain('SQL');
  });

  it('applies the existing rate limit before contacts are read and keeps errors private', async () => {
    const reader = { listForUser: vi.fn<ContactReader['listForUser']>().mockResolvedValue([]) };
    const app = await setup(reader);
    const headers = { authorization: `Bearer ${await token()}` };
    for (let i = 0; i < 120; i += 1) {
      const response = await app.inject({ url: path, headers });
      expect(response.statusCode).toBe(200);
    }
    const response = await app.inject({ url: path, headers });
    expect(response.statusCode).toBe(429);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(reader.listForUser).toHaveBeenCalledTimes(120);
  });

  it('exposes no contact write method or other-user contact route', async () => {
    const reader = {
      listForUser: vi.fn<ContactReader['listForUser']>().mockResolvedValue([contact]),
    };
    const app = await setup(reader);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: path,
        headers: { authorization: `Bearer ${await token()}` },
        payload: { userId: otherUserId },
      });
      expect(response.statusCode).toBe(404);
    }
    const response = await app.inject({
      url: `/user/api/v1/local-padel/profiles/${otherUserId}/contacts`,
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(response.statusCode).toBe(404);
    expect(reader.listForUser).not.toHaveBeenCalled();
  });
});
