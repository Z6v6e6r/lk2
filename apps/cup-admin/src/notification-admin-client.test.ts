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

describe('NotificationAdminClient community moderation', () => {
  it('reads the bounded pending-content queue with an opaque cursor', async () => {
    const calls: Array<{
      readonly input: Parameters<typeof fetch>[0];
      readonly init?: RequestInit;
    }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init ? { init } : {}) });
      return Promise.resolve(Response.json({ items: [], nextCursor: 'opaque-next-cursor-value' }));
    };
    const client = createNotificationAdminClient({
      baseUrl: 'https://api.padlhub.test',
      tenantKey: 'local-padel',
      appVersion: '0.1.0',
      fetchImplementation,
    });

    await client.listPendingCommunityContent({
      communityId: '11111111-1111-4111-8111-111111111111',
      cursor: 'opaque-current-cursor-value',
      limit: 20,
    });

    expect(calls[0]?.input).toBe(
      'https://api.padlhub.test/admin/api/v1/local-padel/community-content/pending?communityId=11111111-1111-4111-8111-111111111111&cursor=opaque-current-cursor-value&limit=20',
    );
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('X-App-Platform')).toBe('cup-admin');
    expect(headers.get('Idempotency-Key')).toBeNull();
  });

  it('approves pending content using only the server revision and an idempotency key', async () => {
    const calls: Array<{
      readonly input: Parameters<typeof fetch>[0];
      readonly init?: RequestInit;
    }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init ? { init } : {}) });
      return Promise.resolve(
        Response.json({
          id: '44444444-4444-4444-8444-444444444444',
          communityId: '11111111-1111-4111-8111-111111111111',
          authorUserId: '33333333-3333-4333-8333-333333333333',
          status: 'PUBLISHED',
          body: 'Публикация для проверки',
          revision: 4,
          createdAt: '2026-08-04T12:00:00.000Z',
          publishedAt: '2026-08-04T12:10:00.000Z',
          updatedAt: '2026-08-04T12:10:00.000Z',
          archivedAt: null,
          restoreUntil: null,
          retentionUntil: null,
        }),
      );
    };
    const client = createNotificationAdminClient({
      baseUrl: 'https://api.padlhub.test',
      tenantKey: 'local-padel',
      appVersion: '0.1.0',
      fetchImplementation,
    });

    await client.approveCommunityPost(
      '11111111-1111-4111-8111-111111111111',
      '44444444-4444-4444-8444-444444444444',
      3,
    );

    expect(calls[0]?.input).toBe(
      'https://api.padlhub.test/admin/api/v1/local-padel/communities/11111111-1111-4111-8111-111111111111/content/posts/44444444-4444-4444-8444-444444444444/approve',
    );
    const requestBody = calls[0]?.init?.body;
    expect(typeof requestBody).toBe('string');
    if (typeof requestBody !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(requestBody) as unknown).toEqual({ expectedRevision: 3 });
    expect(requestBody).not.toMatch(/actor|status|author|reason/i);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('X-App-Platform')).toBe('cup-admin');
    expect(headers.get('Idempotency-Key')).toMatch(/^[A-Za-z0-9-]{16,}$/);
  });

  it('rejects pending content with revision and a structured reason only', async () => {
    const calls: Array<{
      readonly input: Parameters<typeof fetch>[0];
      readonly init?: RequestInit;
    }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init ? { init } : {}) });
      return Promise.resolve(Response.json({ status: 'HIDDEN' }));
    };
    const client = createNotificationAdminClient({
      baseUrl: 'https://api.padlhub.test',
      tenantKey: 'local-padel',
      appVersion: '0.1.0',
      fetchImplementation,
    });

    await client.rejectCommunityPost(
      '11111111-1111-4111-8111-111111111111',
      '44444444-4444-4444-8444-444444444444',
      { expectedRevision: 3, reasonCode: 'CONTENT_POLICY_VIOLATION' },
    );

    expect(calls[0]?.input).toBe(
      'https://api.padlhub.test/admin/api/v1/local-padel/communities/11111111-1111-4111-8111-111111111111/content/posts/44444444-4444-4444-8444-444444444444/reject',
    );
    const requestBody = calls[0]?.init?.body;
    expect(typeof requestBody).toBe('string');
    if (typeof requestBody !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(requestBody) as unknown).toEqual({
      expectedRevision: 3,
      reasonCode: 'CONTENT_POLICY_VIOLATION',
    });
    expect(requestBody).not.toMatch(/actor|status|author/i);
    expect(new Headers(calls[0]?.init?.headers).get('Idempotency-Key')).toMatch(
      /^[A-Za-z0-9-]{16,}$/,
    );
  });

  it('uses the bounded CUP queue and sends only canonical decision revisions', async () => {
    const calls: Array<{
      readonly input: Parameters<typeof fetch>[0];
      readonly init?: RequestInit;
    }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init ? { init } : {}) });
      return Promise.resolve(
        Response.json({
          outcome: 'APPROVED',
          requestId: '22222222-2222-4222-8222-222222222222',
          communityId: '11111111-1111-4111-8111-111111111111',
          requesterUserId: '33333333-3333-4333-8333-333333333333',
          requestStatus: 'APPROVED',
          requestRevision: 2,
          membershipStatus: 'ACTIVE',
          membershipRevision: 4,
          reasonCode: null,
          decidedAt: '2026-08-03T11:00:00.000Z',
          replayed: false,
        }),
      );
    };
    const client = createNotificationAdminClient({
      baseUrl: 'https://api.padlhub.test',
      tenantKey: 'local-padel',
      appVersion: '0.1.0',
      fetchImplementation,
    });

    await client.approveCommunityJoinRequest('22222222-2222-4222-8222-222222222222', {
      expectedMembershipRevision: 3,
      expectedRequestRevision: 1,
    });

    expect(calls[0]?.input).toBe(
      'https://api.padlhub.test/admin/api/v1/local-padel/community-join-requests/22222222-2222-4222-8222-222222222222/approve',
    );
    const requestBody = calls[0]?.init?.body;
    expect(typeof requestBody).toBe('string');
    if (typeof requestBody !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(requestBody) as unknown).toEqual({
      expectedMembershipRevision: 3,
      expectedRequestRevision: 1,
    });
    expect(requestBody).not.toMatch(/actor|role|userId|phone|clientId/i);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('X-App-Platform')).toBe('cup-admin');
    expect(headers.get('Idempotency-Key')).toMatch(/^[A-Za-z0-9-]{16,}$/);
  });

  it('creates a quota grant without client-controlled capability, actor or issuer fields', async () => {
    const calls: Array<{
      readonly input: Parameters<typeof fetch>[0];
      readonly init?: RequestInit;
    }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init ? { init } : {}) });
      return Promise.resolve(
        Response.json({
          id: '22222222-2222-4222-8222-222222222222',
          communityId: '11111111-1111-4111-8111-111111111111',
          status: 'ACTIVE',
          revision: 1,
          createdAt: '2026-08-04T12:00:00.000Z',
          updatedAt: '2026-08-04T12:00:00.000Z',
          expiresAt: '2026-08-05T12:00:00.000Z',
          consumedAt: null,
          replayed: false,
        }),
      );
    };
    const client = createNotificationAdminClient({
      baseUrl: 'https://api.padlhub.test',
      tenantKey: 'local-padel',
      appVersion: '0.1.0',
      fetchImplementation,
    });

    await client.createCommunityDirectInviteQuotaGrant('11111111-1111-4111-8111-111111111111', {
      reasonCode: 'OPERATIONS_EXCEPTION',
      ticketId: 'CUP-1842',
    });

    expect(calls[0]?.input).toBe(
      'https://api.padlhub.test/admin/api/v1/local-padel/communities/11111111-1111-4111-8111-111111111111/direct-invite-quota-grants',
    );
    const requestBody = calls[0]?.init?.body;
    expect(typeof requestBody).toBe('string');
    if (typeof requestBody !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(requestBody) as unknown).toEqual({
      reasonCode: 'OPERATIONS_EXCEPTION',
      ticketId: 'CUP-1842',
    });
    expect(requestBody).not.toMatch(/authorizedByUserId|capability|quotaOverride|issuer|revision/i);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('X-App-Platform')).toBe('cup-admin');
    expect(headers.get('Idempotency-Key')).toMatch(/^[A-Za-z0-9-]{16,}$/);
  });
});
