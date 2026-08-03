import { describe, expect, it, vi } from 'vitest';

import { runMessagingTwoPlayerPreflight } from './preflight-messaging-two-player.js';

const conversationId = '11111111-1111-4111-8111-111111111111';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

describe('read-only two-player messaging preflight', () => {
  it('accepts an immutable HTTP M1 surface for two existing conversation members', async () => {
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      const url = requestUrl(input);
      if (url.endsWith('/manifest.json')) return Promise.resolve(json({ release: 'abc123' }));
      if (url.endsWith('/health/ready')) return Promise.resolve(json({ status: 'ready' }));
      if (url.includes('/messages?')) {
        return Promise.resolve(json({ messages: [] }, 200, { 'Cache-Control': 'no-store' }));
      }
      const authorization = new Headers(init?.headers).get('authorization');
      if (!authorization) return Promise.resolve(json({ code: 'AUTH_REQUIRED' }, 401));
      return Promise.resolve(json({ items: [] }, 200, { 'Cache-Control': 'no-store' }));
    });

    const report = await runMessagingTwoPlayerPreflight({
      baseUrl: 'https://staging.padlhub.test',
      tenantKey: 'local-padel',
      expectedRelease: 'abc123',
      playerAToken: 'player-a-secret',
      playerBToken: 'player-b-secret',
      conversationId,
      fetchImpl,
    });

    expect(report).toMatchObject({ result: 'HTTP_M1_PREFLIGHT_PASS', mutationCount: 0 });
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: 'realtime', status: 'NOT_CHECKED' }),
    );
    expect(JSON.stringify(report)).not.toContain('player-a-secret');
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  it('blocks the current integration shape when the M1 route is absent', async () => {
    const fetchImpl = vi.fn((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.endsWith('/manifest.json')) return Promise.resolve(json({ release: 'd730259' }));
      if (url.endsWith('/health/ready')) return Promise.resolve(json({ status: 'ready' }));
      return Promise.resolve(json({ code: 'ROUTE_NOT_FOUND' }, 404));
    });

    const report = await runMessagingTwoPlayerPreflight({
      baseUrl: 'https://staging.padlhub.test',
      tenantKey: 'local-padel',
      expectedRelease: 'd730259',
      fetchImpl,
    });

    expect(report.result).toBe('BLOCKED');
    expect(report.checks).toContainEqual({
      name: 'messaging-route-mounted',
      status: 'BLOCKED',
      detail: 'M1 route is not mounted',
    });
    expect(report.mutationCount).toBe(0);
  });

  it('requires owner-provided identities, release and existing conversation without mutating', async () => {
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      const url = requestUrl(input);
      if (url.endsWith('/manifest.json')) return Promise.resolve(json({ release: 'unknown' }));
      if (url.endsWith('/health/ready')) return Promise.resolve(json({ status: 'ready' }));
      return Promise.resolve(json({ code: 'AUTH_REQUIRED' }, 401));
    });

    const report = await runMessagingTwoPlayerPreflight({
      baseUrl: 'https://staging.padlhub.test',
      tenantKey: 'local-padel',
      fetchImpl,
    });

    expect(report.result).toBe('BLOCKED');
    expect(
      report.checks.filter((check) => check.status === 'BLOCKED').map((check) => check.name),
    ).toEqual([
      'immutable-release',
      'player-a-conversations',
      'player-b-conversations',
      'shared-conversation-history',
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(report.mutationCount).toBe(0);
  });
});
