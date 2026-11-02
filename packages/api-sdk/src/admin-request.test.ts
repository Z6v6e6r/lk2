import { expect, it, vi } from 'vitest';
import { PadlHubApiClient } from './index.js';

it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
  'admin %s cannot opt into unauthenticated or automatic mutation replay',
  async (method) => {
    const transport = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 401 })),
    );
    const client = new PadlHubApiClient({
      baseUrl: 'https://api.invalid',
      tenantKey: 'synthetic space',
      platform: 'cup-admin',
      appVersion: 'test',
      initialAccessToken: 'synthetic-original',
      fetchImplementation: transport,
    });
    await expect(
      client.requestAdmin('/synthetic', {
        method,
        auth: 'none',
        retryOnUnauthorized: true,
        credentials: 'omit',
        idempotencyKey: 'synthetic-operation-key',
        headers: { Authorization: 'Bearer synthetic-other' },
        body: '{}',
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(transport).toHaveBeenCalledOnce();
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe('https://api.invalid/admin/api/v1/synthetic%20space/synthetic');
    expect(init?.credentials).toBe('same-origin');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-original');
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('synthetic-operation-key');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
  },
);

it('does not expose a late media error body from a retired account', async () => {
  let finish!: (v: unknown) => void;
  const body = new Promise<unknown>((yes) => {
    finish = yes;
  });
  const response = Response.json({}, { status: 403 });
  vi.spyOn(response, 'json').mockReturnValue(body);
  const client = new PadlHubApiClient({
    baseUrl: 'https://api.invalid',
    tenantKey: 'synthetic',
    platform: 'cup-admin',
    appVersion: 'test',
    initialAccessToken: 'synthetic-original',
    fetchImplementation: () => Promise.resolve(response),
  });
  const old = client
    .downloadConversationMedia('synthetic-room', 'synthetic-media')
    .catch((error) => error as Error);
  await Promise.resolve();
  client.setAccessToken('synthetic-new');
  finish({ message: 'synthetic-old-private' });
  expect(await old).toMatchObject({ code: 'AUTH_PRINCIPAL_CHANGED' });
});
