import { describe, expect, it, vi } from 'vitest';
import { PadlHubApiClient, type ProfileContacts } from './index.js';

describe('own contact read SDK', () => {
  it.each([
    { contacts: [] },
    {
      contacts: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          type: 'EMAIL' as const,
          normalizedValue: 'own@example.test',
          provenance: { sourceKind: 'LOCAL' as const, sourceUpdatedAt: null },
        },
      ],
    },
  ])('uses an authenticated self route without account selectors', async (body) => {
    const typedBody: ProfileContacts = body;
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(typedBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      }),
    );
    const client = new PadlHubApiClient({
      baseUrl: 'https://api.example.test',
      tenantKey: 'local-padel',
      platform: 'web',
      appVersion: 'test',
      initialAccessToken: 'synthetic-contact-access-token',
      fetchImplementation,
    });
    expect(await client.getProfileContacts()).toEqual(body);
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe('https://api.example.test/user/api/v1/local-padel/profile/contacts');
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer synthetic-contact-access-token',
    );
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();
  });
});
