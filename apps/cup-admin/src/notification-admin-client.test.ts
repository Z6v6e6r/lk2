// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { createNotificationAdminClient } from './notification-admin-client.js';

describe('NotificationAdminClient media uploads', () => {
  it('preserves the binary content type and retry-safe operation key', async () => {
    const calls: Array<{
      readonly input: Parameters<typeof fetch>[0];
      readonly init?: RequestInit;
    }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init ? { init } : {}) });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: '33333333-3333-4333-8333-333333333333',
            status: 'READY',
            mediaUrl:
              '/public/api/v1/local-padel/gift-certificate-media/33333333-3333-4333-8333-333333333333',
            contentType: 'image/webp',
            bytes: 1000,
            width: 800,
            height: 500,
            sha256: 'a'.repeat(64),
            createdAt: '2026-07-19T10:00:00.000Z',
            replayed: false,
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    };
    const client = createNotificationAdminClient({
      baseUrl: 'https://api.padlhub.test',
      tenantKey: 'local-padel',
      appVersion: '0.1.0',
      fetchImplementation,
    });
    const file = new File(['png'], 'design.png', { type: 'image/png' });

    await client.uploadGiftCertificateMedia(file);

    const requestInput = calls[0]?.input;
    const requestUrl =
      typeof requestInput === 'string'
        ? requestInput
        : requestInput instanceof URL
          ? requestInput.toString()
          : requestInput?.url;
    expect(requestUrl).toBe(
      'https://api.padlhub.test/admin/api/v1/local-padel/gift-certificate-media',
    );
    expect(calls[0]?.init?.body).toBe(file);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('Content-Type')).toBe('image/png');
    expect(headers.get('Idempotency-Key')).toMatch(/^[A-Za-z0-9-]{16,}$/);
    expect(headers.get('X-App-Platform')).toBe('cup-admin');
  });

  it('sends a location photo as raw bytes and preserves the server-issued stable media path', async () => {
    const calls: Array<{
      readonly input: Parameters<typeof fetch>[0];
      readonly init?: RequestInit;
    }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init ? { init } : {}) });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: '33333333-3333-4333-8333-333333333333',
            status: 'READY',
            mediaUrl:
              '/public/api/v1/local-padel/location-media/33333333-3333-4333-8333-333333333333',
            contentType: 'image/webp',
            bytes: 1000,
            width: 800,
            height: 500,
            sha256: 'a'.repeat(64),
            createdAt: '2026-07-19T10:00:00.000Z',
            replayed: false,
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    };
    const client = createNotificationAdminClient({
      baseUrl: 'https://api.padlhub.test',
      tenantKey: 'local-padel',
      appVersion: '0.1.0',
      fetchImplementation,
    });
    const file = new File(['png'], 'location.png', { type: 'image/png' });

    const result = await client.uploadLocationMedia(file);

    const requestInput = calls[0]?.input;
    const requestUrl =
      typeof requestInput === 'string'
        ? requestInput
        : requestInput instanceof URL
          ? requestInput.toString()
          : requestInput?.url;
    expect(requestUrl).toBe('https://api.padlhub.test/admin/api/v1/local-padel/location-media');
    expect(calls[0]?.init?.body).toBe(file);
    expect(new Headers(calls[0]?.init?.headers).get('Content-Type')).toBe('image/png');
    expect(result.mediaUrl).toBe(
      '/public/api/v1/local-padel/location-media/33333333-3333-4333-8333-333333333333',
    );
    expect(client.resolveMediaUrl(result.mediaUrl)).toBe(
      'https://api.padlhub.test/public/api/v1/local-padel/location-media/33333333-3333-4333-8333-333333333333',
    );
  });

  it('keeps a stable relative media path on the local proxy origin', () => {
    const client = createNotificationAdminClient({
      baseUrl: '',
      tenantKey: 'local-padel',
      appVersion: '0.1.0',
    });

    expect(
      client.resolveMediaUrl(
        '/public/api/v1/local-padel/location-media/33333333-3333-4333-8333-333333333333',
      ),
    ).toBe('/public/api/v1/local-padel/location-media/33333333-3333-4333-8333-333333333333');
  });
});
