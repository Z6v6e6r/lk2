import { randomUUID } from 'node:crypto';

import { loadConfig } from '@phub/config';
import type { SubscriptionSelfPage } from '@phub/api-sdk';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { SubscriptionSelfReadError, type SubscriptionSelfReadSource } from './self-read-routes.js';

const tenantId = randomUUID();
const userId = randomUUID();
const sessionId = randomUUID();
const snapshotId = randomUUID();
const tenantKey = 'synthetic-self';
const route = `/user/api/v1/${tenantKey}/subscriptions`;
const secret = 'synthetic-self-read-secret-at-least-32-characters';
const configFor = (key = secret) =>
  loadConfig({
    APP_ENV: 'ci',
    DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
    REDIS_URL: 'redis://localhost:6379',
    RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
    JWT_ISSUER: 'phub-identity',
    JWT_AUDIENCE: 'phub-api',
    JWT_ACCESS_SECRET: key,
    JWT_REFRESH_SECRET: 'synthetic-refresh-secret-at-least-32-characters',
  });
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function headers(
  input: {
    user?: string;
    session?: string;
    tenants?: string[];
    permissions?: string[];
    key?: string;
    expired?: boolean;
  } = {},
) {
  const config = configFor(input.key);
  const token = await new SignJWT({
    sid: input.session ?? sessionId,
    tenants: input.tenants ?? [tenantId],
    roles: ['client'],
    permissions: input.permissions ?? ['profile.read'],
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject(input.user ?? userId)
    .setExpirationTime(input.expired ? '0s' : '5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
  return { authorization: `Bearer ${token}`, 'x-correlation-id': 'self-read-synthetic-123' };
}

function item(index: number) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    title: `Synthetic ${index}`,
    kind: 'GROUP' as const,
    status: 'ACTIVE' as const,
    remaining: { amount: index, unit: 'VISITS' as const },
    validUntil: null,
  };
}

async function fixture(
  input: {
    disabled?: boolean;
    active?: boolean;
    key?: string;
    total?: number;
    secondTenantId?: string;
  } = {},
) {
  const snapshot = {
    id: snapshotId,
    asOf: new Date(Date.now() - 60_000).toISOString(),
    staleAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const total = input.total ?? 7;
  const readPage = vi.fn<SubscriptionSelfReadSource['readPage']>((request) =>
    Promise.resolve({
      tenantId,
      userId,
      sessionId,
      coverage: 'COMPLETE',
      snapshot,
      offset: request.offset,
      total,
      items: Array.from({ length: total }, (_, index) => item(index + 1)).slice(
        request.offset,
        request.offset + request.limit,
      ),
    }),
  );
  const query = vi.fn((sql: string, parameters?: readonly unknown[]) => {
    if (sql.includes('identity.tenants'))
      return Promise.resolve({
        rows: [{ id: parameters?.[0] === 'synthetic-second' ? input.secondTenantId : tenantId }],
      });
    return Promise.reject(new Error('Unexpected database access'));
  });
  const app = await buildApp({
    config: configFor(input.key),
    pool: { query } as unknown as Pool,
    logger: createLogger('self-read-test', 'silent'),
    accessSessionChecker: () => Promise.resolve(input.active ?? true),
    ...(input.disabled ? {} : { subscriptionSelfReadSource: { readPage } }),
  });
  apps.push(app);
  return { app, readPage, snapshot, query };
}

describe('canonical self-only subscriptions', () => {
  it('reads all seven products through one pinned page chain without the Home max6 limit', async () => {
    const f = await fixture();
    const auth = await headers();
    let cursor: string | null = null;
    const ids: string[] = [];
    for (const offset of [0, 3, 6]) {
      const response = await f.app.inject({
        method: 'GET',
        url: `${route}?limit=3${cursor ? `&cursor=${cursor}` : ''}`,
        headers: auth,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      const body: SubscriptionSelfPage = response.json<SubscriptionSelfPage>();
      expect(body).toMatchObject({
        scope: 'CURRENT',
        coverage: 'COMPLETE',
        snapshot: f.snapshot,
        freshness: 'FRESH',
        page: { offset, total: 7, limit: 3, hasMore: offset !== 6 },
      });
      ids.push(...body.items.map((value: { id: string }) => value.id));
      cursor = body.page.nextCursor;
    }
    expect(ids).toEqual(Array.from({ length: 7 }, (_, i) => item(i + 1).id));
    expect(cursor).toBeNull();
    expect(f.readPage).toHaveBeenNthCalledWith(2, {
      tenantId,
      userId,
      sessionId,
      correlationId: 'self-read-synthetic-123',
      offset: 3,
      limit: 3,
      snapshotId,
      afterId: item(3).id,
    });
  });

  it('distinguishes a proven empty source from a missing source', async () => {
    const f = await fixture({ total: 0 });
    const response = await f.app.inject({ method: 'GET', url: route, headers: await headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      coverage: 'COMPLETE',
      items: [],
      page: { total: 0, hasMore: false, nextCursor: null },
    });
    const disabled = await fixture({ disabled: true });
    const unavailable = await disabled.app.inject({
      method: 'GET',
      url: route,
      headers: await headers(),
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json<{ code: string }>().code).toBe('SUBSCRIPTIONS_READ_UNAVAILABLE');
    expect(disabled.readPage).not.toHaveBeenCalled();
  });

  it('keeps unknown, true zero and source staleness explicit', async () => {
    const f = await fixture({ total: 1 });
    const sourcePage = await f.readPage({
      tenantId,
      userId,
      sessionId,
      correlationId: 'synthetic',
      offset: 0,
      limit: 20,
    });
    f.readPage.mockClear();
    const unknown = {
      ...item(1),
      title: null,
      kind: 'UNKNOWN' as const,
      status: 'UNKNOWN' as const,
      remaining: { amount: null, unit: 'UNKNOWN' as const },
      validUntil: null,
    };
    f.readPage.mockResolvedValue({
      ...sourcePage,
      items: [unknown],
      snapshot: { ...f.snapshot, staleAt: new Date(Date.now() - 1).toISOString() },
    });
    const response = await f.app.inject({ method: 'GET', url: route, headers: await headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ freshness: 'STALE', items: [unknown] });
    f.readPage.mockResolvedValue({
      ...sourcePage,
      items: [{ ...item(1), remaining: { amount: 0, unit: 'VISITS' } }],
    });
    expect(
      (
        await f.app.inject({ method: 'GET', url: route, headers: await headers() })
      ).json<SubscriptionSelfPage>().items[0]?.remaining.amount,
    ).toBe(0);
  });

  it('denies anonymous, expired, revoked, foreign tenant and missing profile.read before source access', async () => {
    const f = await fixture();
    for (const auth of [
      undefined,
      await headers({ expired: true }),
      await headers({ tenants: [randomUUID()] }),
      await headers({ permissions: ['games.play'] }),
    ]) {
      expect(
        (await f.app.inject({ method: 'GET', url: route, ...(auth ? { headers: auth } : {}) }))
          .statusCode,
      ).not.toBe(200);
    }
    expect(f.readPage).not.toHaveBeenCalled();
    const revoked = await fixture({ active: false });
    expect(
      (await revoked.app.inject({ method: 'GET', url: route, headers: await headers() }))
        .statusCode,
    ).toBe(401);
    expect(revoked.readPage).not.toHaveBeenCalled();
  });

  it.each([
    'userId=guessed',
    'tenantId=guessed',
    'providerId=guessed',
    'source=VIVA',
    'page=2',
    'includeFinished=true',
    'limit=0',
    'limit=51',
    'limit=1.5',
    'limit=01',
    'cursor=forged',
  ])('rejects caller selector/query %s before source access', async (query) => {
    const f = await fixture();
    expect(
      (await f.app.inject({ method: 'GET', url: `${route}?${query}`, headers: await headers() }))
        .statusCode,
    ).toBe(400);
    expect(f.readPage).not.toHaveBeenCalled();
  });

  it('binds signed cursors to tenant/user/session, limit, expiration and signing key', async () => {
    let currentTime = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
    const f = await fixture();
    const first = await f.app.inject({
      method: 'GET',
      url: `${route}?limit=2`,
      headers: await headers(),
    });
    const cursor = first.json<SubscriptionSelfPage>().page.nextCursor as string;
    f.readPage.mockClear();
    for (const [auth, suffix] of [
      [await headers({ user: randomUUID() }), ''],
      [await headers({ session: randomUUID() }), ''],
      [await headers(), '&limit=3'],
    ] as const) {
      expect(
        (
          await f.app.inject({
            method: 'GET',
            url: `${route}?cursor=${cursor}${suffix}`,
            headers: auth,
          })
        ).statusCode,
      ).toBe(400);
    }
    const tampered = cursor.split('.');
    tampered[0] = Buffer.from('{}').toString('base64url');
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: `${route}?cursor=${tampered.join('.')}`,
          headers: await headers(),
        })
      ).statusCode,
    ).toBe(400);
    const rotated = await fixture({ key: `${secret}-rotated` });
    expect(
      (
        await rotated.app.inject({
          method: 'GET',
          url: `${route}?cursor=${cursor}`,
          headers: await headers({ key: `${secret}-rotated` }),
        })
      ).statusCode,
    ).toBe(400);
    expect(rotated.readPage).not.toHaveBeenCalled();
    currentTime += 16 * 60_000;
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: `${route}?cursor=${cursor}`,
          headers: await headers(),
        })
      ).statusCode,
    ).toBe(400);
    expect(f.readPage).not.toHaveBeenCalled();
  });

  it('rejects tenant-A cursor replay by the same principal authorized in tenant B', async () => {
    const secondTenantId = randomUUID();
    const f = await fixture({ secondTenantId });
    const auth = await headers({ tenants: [tenantId, secondTenantId] });
    const first = await f.app.inject({ method: 'GET', url: `${route}?limit=2`, headers: auth });
    expect(first.statusCode).toBe(200);
    const cursor = first.json<SubscriptionSelfPage>().page.nextCursor;
    f.readPage.mockClear();
    const replay = await f.app.inject({
      method: 'GET',
      url: `/user/api/v1/synthetic-second/subscriptions?cursor=${cursor}`,
      headers: auth,
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json<{ code: string }>().code).toBe('SUBSCRIPTIONS_REQUEST_INVALID');
    expect(f.readPage).not.toHaveBeenCalled();
  });

  it('returns a restart conflict for source-detected or returned snapshot drift', async () => {
    const f = await fixture();
    const first = await f.app.inject({
      method: 'GET',
      url: `${route}?limit=2`,
      headers: await headers(),
    });
    const cursor = first.json<SubscriptionSelfPage>().page.nextCursor as string;
    f.snapshot.id = randomUUID();
    const changed = await f.app.inject({
      method: 'GET',
      url: `${route}?cursor=${cursor}`,
      headers: await headers(),
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json<{ code: string }>().code).toBe('SUBSCRIPTIONS_SNAPSHOT_CHANGED');
    f.readPage.mockRejectedValue(new SubscriptionSelfReadError('SNAPSHOT_CHANGED'));
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: `${route}?cursor=${cursor}`,
          headers: await headers(),
        })
      ).statusCode,
    ).toBe(409);
  });

  it.each([
    'foreignUser',
    'foreignTenant',
    'foreignSession',
    'partial',
    'missingItem',
    'duplicate',
    'unmapped',
    'providerId',
    'unknownUnitZero',
    'future',
    'backwardsStaleAt',
  ])('fails closed on invalid source %s', async (kind) => {
    const f = await fixture({ total: 2 });
    const value: Record<string, unknown> = {
      tenantId,
      userId,
      sessionId,
      coverage: 'COMPLETE',
      snapshot: f.snapshot,
      offset: 0,
      total: 2,
      items: [item(1), item(2)],
    };
    if (kind === 'foreignUser') value.userId = randomUUID();
    if (kind === 'foreignTenant') value.tenantId = randomUUID();
    if (kind === 'foreignSession') value.sessionId = randomUUID();
    if (kind === 'partial') value.coverage = 'PARTIAL';
    if (kind === 'missingItem') value.items = [item(1)];
    if (kind === 'duplicate') value.items = [item(1), item(1)];
    if (kind === 'unmapped') value.items = [{ ...item(1), id: 'provider-external-id' }, item(2)];
    if (kind === 'providerId') value.items = [{ ...item(1), providerId: randomUUID() }, item(2)];
    if (kind === 'unknownUnitZero')
      value.items = [{ ...item(1), remaining: { amount: 0, unit: 'UNKNOWN' } }, item(2)];
    if (kind === 'future')
      value.snapshot = { ...f.snapshot, asOf: new Date(Date.now() + 120_000).toISOString() };
    if (kind === 'backwardsStaleAt')
      value.snapshot = { ...f.snapshot, staleAt: new Date(Date.now() - 120_000).toISOString() };
    f.readPage.mockResolvedValue(
      value as unknown as Awaited<ReturnType<SubscriptionSelfReadSource['readPage']>>,
    );
    const response = await f.app.inject({ method: 'GET', url: route, headers: await headers() });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toMatch(/provider-external-id|providerId|items/);
  });

  it('rejects a repeated previous-page UUID and redacts thrown source failures', async () => {
    const f = await fixture();
    const first = await f.app.inject({
      method: 'GET',
      url: `${route}?limit=2`,
      headers: await headers(),
    });
    f.readPage.mockResolvedValue({
      tenantId,
      userId,
      sessionId,
      coverage: 'COMPLETE',
      snapshot: f.snapshot,
      offset: 2,
      total: 7,
      items: [item(2), item(3)],
    });
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: `${route}?cursor=${first.json<SubscriptionSelfPage>().page.nextCursor}`,
          headers: await headers(),
        })
      ).statusCode,
    ).toBe(503);
    f.readPage.mockRejectedValue(new Error('provider-token-private-source-detail'));
    const failure = await f.app.inject({ method: 'GET', url: route, headers: await headers() });
    expect(failure.statusCode).toBe(503);
    expect(failure.body).not.toMatch(/provider-token|private-source-detail/);
  });
});
