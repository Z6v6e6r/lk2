import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestJson, requireJsonField } from './smoke-http.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deployment smoke HTTP assertions', () => {
  it('accepts only the expected status and JSON object body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'ready' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }),
    );

    const body = await requestJson('https://staging.padlhub.test', '/health/ready', 200);
    expect(body).toEqual({ status: 'ready' });
    expect(() => requireJsonField('/health/ready', body, 'status', 'ready')).not.toThrow();
  });

  it('rejects an SPA fallback even when it returns HTTP 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<!doctype html><div id="phub-app"></div>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    await expect(
      requestJson('https://staging.padlhub.test', '/public/api/v1/tenant/games', 200),
    ).rejects.toThrow('instead of application/json');
  });

  it('rejects a JSON response with the wrong status or semantic code', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'ROUTE_NOT_FOUND' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      requestJson('https://staging.padlhub.test', '/admin/api/v1/tenant/locations', 401),
    ).rejects.toThrow('expected 401');
    expect(() =>
      requireJsonField(
        '/admin/api/v1/tenant/locations',
        { code: 'ROUTE_NOT_FOUND' },
        'code',
        'AUTH_REQUIRED',
      ),
    ).toThrow('unexpected code');
  });
});
