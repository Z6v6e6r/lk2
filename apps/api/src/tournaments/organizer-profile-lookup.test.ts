import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  registerOrganizerProfileLookup,
  type OrganizerLookupOptions,
} from './organizer-profile-lookup.js';
import {
  organizerLookupHash,
  organizerLookupPath,
  organizerLookupType,
  organizerLookupScope,
} from './organizer-profile-lookup-contract.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const tenantId = randomUUID(),
  userId = randomUUID(),
  correlation = randomUUID(),
  now = 1800000000;
const body = {
  contractVersion: 1 as const,
  requestId: randomUUID(),
  assignmentOperationId: randomUUID(),
  tournamentId: randomUUID(),
  selectedUserId: userId,
  expectedAssignmentRevision: 0,
};
const path = organizerLookupPath('synthetic');
function jwt(overrides = {}, headerOverrides = {}) {
  const header = Buffer.from(
    JSON.stringify({
      alg: 'RS256',
      typ: organizerLookupType,
      kid: 'synthetic',
      ...headerOverrides,
    }),
  ).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      contract_version: 1,
      iss: 'synthetic-cup',
      aud: 'synthetic-lk2-organizer',
      sub: 'cup-organizer-service',
      scope: organizerLookupScope,
      tenant_id: tenantId,
      tenant_key: 'synthetic',
      method: 'POST',
      path,
      request_sha256: organizerLookupHash(body),
      correlation_id: correlation,
      jti: randomUUID(),
      iat: now,
      nbf: now,
      exp: now + 30,
      ...overrides,
    }),
  ).toString('base64url');
  return `${header}.${claims}.${sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), privateKey).toString('base64url')}`;
}
function fixture(overrides: Partial<OrganizerLookupOptions> = {}) {
  const claimNonce = vi.fn((key: string, ttl: number) =>
      Promise.resolve(key.length > 0 && ttl > 0),
    ),
    findProfile = vi.fn(() =>
      Promise.resolve({
        userId,
        displayName: 'Synthetic organizer',
        ownerTenantKey: 'provider-synthetic',
      }),
    );
  const app = Fastify();
  registerOrganizerProfileLookup(app, {
    issuer: 'synthetic-cup',
    audience: 'synthetic-lk2-organizer',
    subject: 'cup-organizer-service',
    tenantId,
    tenantKey: 'synthetic',
    publicKeys: new Map([['synthetic', publicKey]]),
    claimNonce,
    findProfile,
    now: () => now * 1000,
    ...overrides,
  });
  const send = (token = jwt(), payload: unknown = body, url = path, correlationId = correlation) =>
    app.inject({
      method: 'POST',
      url,
      headers: {
        authorization: `Bearer ${token}`,
        'x-correlation-id': correlationId,
        'content-type': 'application/json',
      },
      payload: JSON.stringify(payload),
    });
  return { app, send, claimNonce, findProfile };
}
describe('dedicated readonly organizer lookup', () => {
  it('returns only canonical UUID and minimal name with exact original binding and expiry', async () => {
    const f = fixture();
    try {
      const r = await f.send();
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({
        ...body,
        tenantId,
        tenantKey: 'synthetic',
        profile: { userId, displayName: 'Synthetic organizer' },
        ownerTenantKey: 'provider-synthetic',
        checkedAt: new Date(now * 1000).toISOString(),
        expiresAt: new Date((now + 30) * 1000).toISOString(),
      });
      expect(f.findProfile).toHaveBeenCalledWith(tenantId, 'synthetic', userId);
      expect(f.claimNonce.mock.calls[0]?.[0]).toContain('tournament-organizer-lookup:v1:');
    } finally {
      await f.app.close();
    }
  });
  it.each([
    { aud: 'client' },
    { scope: 'subscription-runtime.quote' },
    { sub: userId },
    { tenant_id: randomUUID() },
    { tenant_key: 'other' },
    { method: 'GET' },
    { path: path + '/other' },
    { request_sha256: 'a'.repeat(64) },
    { correlation_id: randomUUID() },
    { exp: now },
    { exp: now + 31 },
    { iat: now + 1, nbf: now + 1 },
    { sid: randomUUID() },
  ])('denies wrong claims before Redis or profile read: %j', async (overrides) => {
    const f = fixture();
    try {
      expect((await f.send(jwt(overrides))).statusCode).toBe(403);
      expect(f.claimNonce).not.toHaveBeenCalled();
      expect(f.findProfile).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });
  it.each([
    { typ: 'JWT' },
    { typ: 'phub-subscription-runtime-actor-delegation+jwt' },
    { alg: 'HS256' },
    { kid: 'unknown' },
    { jku: 'https://invalid.example' },
  ])('denies user/subscription/unknown-key tokens: %j', async (header) => {
    const f = fixture();
    try {
      expect((await f.send(jwt({}, header))).statusCode).toBe(403);
      expect(f.findProfile).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });
  it('denies body extras, foreign tenant/query and correlation mismatch without profile effects', async () => {
    const f = fixture();
    try {
      expect((await f.send(jwt(), { ...body, phone: 'forbidden' })).statusCode).toBe(400);
      expect((await f.send(jwt(), body, organizerLookupPath('other'))).statusCode).toBe(403);
      expect((await f.send(jwt(), body, path + '?extra=true')).statusCode).toBe(403);
      expect((await f.send(jwt(), body, path, randomUUID())).statusCode).toBe(403);
      expect(f.findProfile).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });
  it('replay and nonce failure fail closed; disabled/ambiguous profile returns no card', async () => {
    for (const claimNonce of [() => Promise.resolve(false), () => Promise.reject(Error('redis'))]) {
      const f = fixture({ claimNonce });
      try {
        expect((await f.send()).statusCode).not.toBe(200);
        expect(f.findProfile).not.toHaveBeenCalled();
      } finally {
        await f.app.close();
      }
    }
    const f = fixture({ findProfile: () => Promise.resolve(null) });
    try {
      const r = await f.send();
      expect(r.statusCode).toBe(409);
      expect(r.json<{ profile?: unknown }>().profile).toBeUndefined();
    } finally {
      await f.app.close();
    }
  });
  it('does not return a profile if the proof expires during its read', async () => {
    let clock = now;
    const f = fixture({
      now: () => clock * 1000,
      findProfile: () => {
        clock += 30;
        return Promise.resolve({
          userId,
          displayName: 'Synthetic',
          ownerTenantKey: 'provider-synthetic',
        });
      },
    });
    try {
      expect((await f.send()).statusCode).toBe(503);
    } finally {
      await f.app.close();
    }
  });
  it('claims an exact nonce once across concurrent replay and denies a tampered signature', async () => {
    const claimed = new Set<string>();
    const f = fixture({
      claimNonce: (key) => {
        if (claimed.has(key)) return Promise.resolve(false);
        claimed.add(key);
        return Promise.resolve(true);
      },
    });
    try {
      const token = jwt();
      const replies = await Promise.all([f.send(token), f.send(token)]);
      expect(replies.map((r) => r.statusCode).sort()).toEqual([200, 403]);
      expect(f.findProfile).toHaveBeenCalledTimes(1);
      const parts = jwt().split('.');
      parts[2] = Buffer.alloc(256).toString('base64url');
      expect((await f.send(parts.join('.'))).statusCode).toBe(403);
      expect(f.findProfile).toHaveBeenCalledTimes(1);
    } finally {
      await f.app.close();
    }
  });
  it('is disabled without its dedicated config', async () => {
    const app = Fastify();
    registerOrganizerProfileLookup(app);
    try {
      expect((await app.inject({ method: 'POST', url: path, payload: body })).statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});
