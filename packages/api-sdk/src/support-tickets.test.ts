import { describe, expect, it, vi } from 'vitest';
import { PadlHubApiClient } from './index.js';
function fixture(platform: 'web' | 'cup-admin' = 'web') {
  const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        id: '33333333-3333-4333-8333-333333333333',
        version: 1,
        messages: [],
        history: [],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );
  return {
    fetchImplementation,
    client: new PadlHubApiClient({
      baseUrl: 'https://api.example.test',
      tenantKey: 'synthetic',
      platform,
      appVersion: 'test',
      initialAccessToken: 'synthetic-token',
      fetchImplementation,
    }),
  };
}
describe('support ticket SDK', () => {
  it('retains canonical command body/version/idempotency key and uses the user API', async () => {
    const { client, fetchImplementation } = fixture();
    const input = { body: 'Synthetic reply', expectedVersion: 7 };
    await client.sendSupportTicketMessage(
      '33333333-3333-4333-8333-333333333333',
      input,
      'synthetic-command-000001',
    );
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe(
      'https://api.example.test/user/api/v1/synthetic/support/tickets/33333333-3333-4333-8333-333333333333/messages',
    );
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('synthetic-command-000001');
    expect(typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined).toEqual(
      input,
    );
  });
  it('uses the admin API/platform for internal notes and never puts note text in the URL', async () => {
    const { client, fetchImplementation } = fixture('cup-admin');
    await client.sendAdminSupportTicketMessage(
      '33333333-3333-4333-8333-333333333333',
      { body: 'Synthetic private note', internal: true, expectedVersion: 8 },
      'synthetic-command-000002',
    );
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toContain('/admin/api/v1/synthetic/support/tickets/');
    expect(url).not.toContain('private');
    expect(new Headers(init?.headers).get('X-App-Platform')).toBe('cup-admin');
    expect(init?.method).toBe('POST');
  });
  it('passes opaque keyset cursors unchanged and marks canonical reads no-store', async () => {
    const { client, fetchImplementation } = fixture();
    await client.getSupportTicket(
      '33333333-3333-4333-8333-333333333333',
      'opaque_composite_cursor',
    );
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toContain('?before=opaque_composite_cursor');
    expect(init?.cache).toBe('no-store');
  });
});
