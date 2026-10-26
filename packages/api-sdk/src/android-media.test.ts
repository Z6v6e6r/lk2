import { describe, expect, it, vi } from 'vitest';

import { PadlHubApiClient } from './index.js';

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe('Android conversation-media relay', () => {
  it('sends raw octets only to the PadlHub API with the Android auth and idempotency headers', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ uploaded: true }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = new PadlHubApiClient({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'local-padel',
      platform: 'android',
      appVersion: '1.2.3',
      initialAccessToken: 'android-jwt',
      sessionMode: 'memory',
      fetchImplementation,
    });
    const bytes = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

    await expect(
      client.uploadConversationMediaBytes('room/../id', 'media/../id', bytes, 'media-upload-1'),
    ).resolves.toEqual({ uploaded: true });

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(requestUrl(url!)).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/conversations/room%2F..%2Fid/media/media%2F..%2Fid/bytes',
    );
    expect(requestUrl(url!)).not.toMatch(/^https?:\/\/(?!api\.padlhub\.test\/)/u);
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe(bytes);
    expect(init?.credentials).toBe('omit');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer android-jwt',
      'Content-Type': 'application/octet-stream',
      'Idempotency-Key': 'media-upload-1',
      'X-App-Platform': 'android',
    });
  });
});
