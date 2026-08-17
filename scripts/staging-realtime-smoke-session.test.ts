import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runStagingRealtimeSmokeSession } from '../deploy/jetson/staging-realtime-smoke-session.mjs';

const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const stableUuid = '44444444-4444-4444-8444-444444444444';
const oldRefresh = 'o'.repeat(43);
const nextRefresh = 'n'.repeat(43);
const roots: string[] = [];

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function accessToken(now: number): string {
  return [
    encode({ alg: 'HS256', typ: 'JWT' }),
    encode({
      iss: 'phub-identity',
      aud: 'phub-api',
      sub: userId,
      sid: sessionId,
      tenants: [tenantId],
      roles: ['client'],
      permissions: ['chat.direct.create'],
      exp: Math.floor((now + 10 * 60_000) / 1000),
    }),
    's'.repeat(43),
  ].join('.');
}

function requestHref(url: URL | RequestInfo): string {
  if (url instanceof URL) return url.href;
  if (typeof url === 'string') return url;
  return url.url;
}

function statePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'phub-staging-realtime-smoke-'));
  roots.push(directory);
  chmodSync(directory, 0o700);
  const path = join(directory, 'session.json');
  writeFileSync(
    path,
    `${JSON.stringify({
      expectedPermissions: ['chat.direct.create'],
      expectedPhoneLast4: '0001',
      expectedRoles: ['client'],
      expectedTenantId: tenantId,
      expectedUserId: userId,
      generation: 0,
      lastRotatedAt: null,
      pendingIdempotencyKey: null,
      refreshExpiresAt: null,
      refreshToken: oldRefresh,
      tenantKey: 'local-padel',
      version: 1,
    })}\n`,
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
  return path;
}

function sessionResponse(now: number, refreshToken = nextRefresh): Response {
  return new Response(
    JSON.stringify({
      accessToken: accessToken(now),
      tokenType: 'Bearer',
      expiresAt: new Date(now + 10 * 60_000).toISOString(),
      user: { id: userId, displayName: 'Staging Realtime Smoke' },
      context: {
        tenantId,
        userId,
        displayName: 'Staging Realtime Smoke',
        phoneLast4: '0001',
        roles: ['client'],
        permissions: ['chat.direct.create'],
        runtimeCapabilities: {},
      },
    }),
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
        'Set-Cookie': `phub_refresh=${refreshToken}; Max-Age=2592000; Path=/user/api/v1/local-padel/auth; HttpOnly; Secure; SameSite=Lax`,
      },
    },
  );
}

function ticketResponse(): Response {
  return new Response(
    JSON.stringify({
      ticket: 't'.repeat(64),
      expiresAt: '2026-08-17T12:00:30.000Z',
    }),
    {
      status: 200,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
    },
  );
}

class FakeSocket {
  readonly listeners = new Map<string, Array<(event: { data?: unknown; code?: number }) => void>>();
  readonly sent: string[] = [];

  addEventListener(
    type: string,
    listener: (event: { data?: unknown; code?: number }) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: { data?: unknown; code?: number } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {}
}

function readySocketFactory(socket: FakeSocket) {
  return (url: URL) => {
    expect(url.href).toBe('wss://lk.nano.padlhub.su/realtime/v1/local-padel');
    queueMicrotask(() => socket.emit('open'));
    queueMicrotask(() => socket.emit('message', { data: '{"type":"connection.ready"}' }));
    return socket;
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('durable staging realtime smoke session', () => {
  it('rotates the refresh credential before proving the ticket and WebSocket path', async () => {
    const path = statePath();
    const now = Date.parse('2026-08-17T12:00:00.000Z');
    const socket = new FakeSocket();
    const fetchImpl = vi.fn((url: URL | RequestInfo, init?: RequestInit) => {
      const href = requestHref(url);
      if (href.endsWith('/auth/session/refresh')) {
        expect(init?.redirect).toBe('error');
        expect((init?.headers as Record<string, string>).Cookie).toBe(`phub_refresh=${oldRefresh}`);
        expect((init?.headers as Record<string, string>).Origin).toBe('https://lk.nano.padlhub.su');
        return Promise.resolve(sessionResponse(now));
      }
      expect(href).toBe(
        'https://lk.nano.padlhub.su/user/api/v1/local-padel/messaging/realtime-ticket',
      );
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${accessToken(now)}`,
      );
      return Promise.resolve(ticketResponse());
    });

    await expect(
      runStagingRealtimeSmokeSession({
        statePath: path,
        fetchImpl,
        socketFactory: readySocketFactory(socket),
        randomUuid: () => stableUuid,
        now: () => now,
      }),
    ).resolves.toEqual({ status: 'passed', generation: 1 });

    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      generation: 1,
      lastRotatedAt: new Date(now).toISOString(),
      pendingIdempotencyKey: null,
      refreshExpiresAt: new Date(now + 30 * 24 * 60 * 60_000).toISOString(),
      refreshToken: nextRefresh,
    });
    expect(JSON.parse(socket.sent[0] ?? '{}')).toEqual({
      type: 'authenticate',
      ticket: 't'.repeat(64),
    });
  });

  it('durably reuses one idempotency key after an ambiguous refresh failure', async () => {
    const path = statePath();
    const now = Date.parse('2026-08-17T12:00:00.000Z');
    const observedKeys: string[] = [];
    const failedFetch = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => {
      observedKeys.push(
        (init?.headers as Record<string, string> | undefined)?.['Idempotency-Key'] ?? '',
      );
      return Promise.reject(new TypeError('sentinel secret must not be surfaced'));
    });
    await expect(
      runStagingRealtimeSmokeSession({
        statePath: path,
        fetchImpl: failedFetch,
        randomUuid: () => stableUuid,
        now: () => now,
      }),
    ).rejects.toThrow('SMOKE_REFRESH_NETWORK_FAILED');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      pendingIdempotencyKey: stableUuid,
      refreshToken: oldRefresh,
    });

    const socket = new FakeSocket();
    const replayFetch = vi.fn((url: URL | RequestInfo, init?: RequestInit) => {
      const href = requestHref(url);
      if (href.endsWith('/auth/session/refresh')) {
        observedKeys.push(
          (init?.headers as Record<string, string> | undefined)?.['Idempotency-Key'] ?? '',
        );
        return Promise.resolve(sessionResponse(now));
      }
      return Promise.resolve(ticketResponse());
    });
    await runStagingRealtimeSmokeSession({
      statePath: path,
      fetchImpl: replayFetch,
      socketFactory: readySocketFactory(socket),
      randomUuid: () => stableUuid,
      now: () => now,
    });
    expect(observedKeys).toEqual([stableUuid, stableUuid]);
  });

  it('replays the same rotation after losing a successful refresh response', async () => {
    const path = statePath();
    const now = Date.parse('2026-08-17T12:00:00.000Z');
    const observedKeys: string[] = [];
    const refresh = (url: URL | RequestInfo, init?: RequestInit) => {
      const href = requestHref(url);
      if (href.endsWith('/auth/session/refresh')) {
        observedKeys.push(
          (init?.headers as Record<string, string> | undefined)?.['Idempotency-Key'] ?? '',
        );
        return Promise.resolve(sessionResponse(now));
      }
      return Promise.resolve(ticketResponse());
    };
    await expect(
      runStagingRealtimeSmokeSession({
        statePath: path,
        fetchImpl: vi.fn(refresh),
        randomUuid: () => stableUuid,
        now: () => now,
        failAfter: 'refresh-response',
      }),
    ).rejects.toThrow('SMOKE_FAILPOINT_REFRESH_RESPONSE');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      pendingIdempotencyKey: stableUuid,
      refreshToken: oldRefresh,
    });

    const socket = new FakeSocket();
    await runStagingRealtimeSmokeSession({
      statePath: path,
      fetchImpl: vi.fn(refresh),
      socketFactory: readySocketFactory(socket),
      randomUuid: () => stableUuid,
      now: () => now,
    });
    expect(observedKeys).toEqual([stableUuid, stableUuid]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      generation: 1,
      pendingIdempotencyKey: null,
      refreshToken: nextRefresh,
    });
  });

  it('replays a pending rotation even after the previous credential expiry elapsed', async () => {
    const path = statePath();
    const now = Date.parse('2026-08-17T12:00:00.000Z');
    const state = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      path,
      `${JSON.stringify({
        ...state,
        generation: 4,
        lastRotatedAt: new Date(now - 31 * 24 * 60 * 60_000).toISOString(),
        pendingIdempotencyKey: stableUuid,
        refreshExpiresAt: new Date(now - 60_000).toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    const observedKeys: string[] = [];
    const socket = new FakeSocket();
    const fetchImpl = vi.fn((url: URL | RequestInfo, init?: RequestInit) => {
      if (requestHref(url).endsWith('/auth/session/refresh')) {
        observedKeys.push(
          (init?.headers as Record<string, string> | undefined)?.['Idempotency-Key'] ?? '',
        );
        return Promise.resolve(sessionResponse(now));
      }
      return Promise.resolve(ticketResponse());
    });

    await expect(
      runStagingRealtimeSmokeSession({
        statePath: path,
        fetchImpl,
        socketFactory: readySocketFactory(socket),
        randomUuid: () => stableUuid,
        now: () => now,
      }),
    ).resolves.toEqual({ status: 'passed', generation: 5 });
    expect(observedKeys).toEqual([stableUuid]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      generation: 5,
      pendingIdempotencyKey: null,
      refreshToken: nextRefresh,
    });
  });

  it('keeps the rotated credential when the post-refresh handshake fails', async () => {
    const path = statePath();
    const now = Date.parse('2026-08-17T12:00:00.000Z');
    const socket = new FakeSocket();
    const fetchImpl = vi.fn((url: URL | RequestInfo) =>
      Promise.resolve(
        requestHref(url).endsWith('/auth/session/refresh')
          ? sessionResponse(now)
          : ticketResponse(),
      ),
    );
    await expect(
      runStagingRealtimeSmokeSession({
        statePath: path,
        fetchImpl,
        socketFactory: () => {
          queueMicrotask(() => socket.emit('error'));
          return socket;
        },
        randomUuid: () => stableUuid,
        now: () => now,
      }),
    ).rejects.toThrow('SMOKE_WEBSOCKET_ERROR');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      generation: 1,
      pendingIdempotencyKey: null,
      refreshToken: nextRefresh,
    });
  });

  it('rejects a broadened principal before persisting the successor credential', async () => {
    const path = statePath();
    const now = Date.parse('2026-08-17T12:00:00.000Z');
    const response = sessionResponse(now);
    const body = (await response.json()) as {
      context: { permissions: string[] };
    };
    body.context.permissions.push('games.play');
    const broadened = new Response(JSON.stringify(body), {
      status: 200,
      headers: response.headers,
    });
    await expect(
      runStagingRealtimeSmokeSession({
        statePath: path,
        fetchImpl: vi.fn(() => Promise.resolve(broadened)),
        randomUuid: () => stableUuid,
        now: () => now,
      }),
    ).rejects.toThrow('SMOKE_SESSION_PERMISSIONS_INVALID');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      pendingIdempotencyKey: stableUuid,
      refreshToken: oldRefresh,
    });
  });

  it('rejects a hard-linked credential file before making any network request', async () => {
    const path = statePath();
    linkSync(path, `${path}.next-${stableUuid}`);
    const fetchImpl = vi.fn();
    await expect(runStagingRealtimeSmokeSession({ statePath: path, fetchImpl })).rejects.toThrow(
      'SMOKE_STATE_ORPHAN_UNSAFE',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('removes a safe orphaned atomic-write file before replaying the durable state', async () => {
    const path = statePath();
    const orphan = `${path}.next-${stableUuid}`;
    writeFileSync(orphan, '{"redacted":"incomplete"}\n', { mode: 0o600 });
    chmodSync(orphan, 0o600);
    const now = Date.parse('2026-08-17T12:00:00.000Z');
    const socket = new FakeSocket();
    const fetchImpl = vi.fn((url: URL | RequestInfo) =>
      Promise.resolve(
        requestHref(url).endsWith('/auth/session/refresh')
          ? sessionResponse(now)
          : ticketResponse(),
      ),
    );
    await expect(
      runStagingRealtimeSmokeSession({
        statePath: path,
        fetchImpl,
        socketFactory: readySocketFactory(socket),
        randomUuid: () => stableUuid,
        now: () => now,
      }),
    ).resolves.toMatchObject({ status: 'passed' });
    expect(() => readFileSync(orphan)).toThrow();
  });
});
