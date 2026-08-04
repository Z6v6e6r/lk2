import { describe, expect, it, vi } from 'vitest';

import { VivaExerciseRosterSourceAdapter } from './exercise-roster-source.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const exerciseExternalId = '22222222-2222-4222-8222-222222222222';

describe('VivaExerciseRosterSourceAdapter', () => {
  it('returns names and proxy-owned avatar references without exposing Viva identifiers', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      Response.json({
        content: [
          {
            isCancelled: false,
            client: {
              id: '33333333-3333-4333-8333-333333333333',
              firstName: 'Алексей',
              lastName: 'Сергеев',
              photo: 'https://media.vivacrm.test/private/avatar.jpg',
            },
          },
          {
            isCancelled: true,
            client: {
              id: '44444444-4444-4444-8444-444444444444',
              firstName: 'Скрытый',
              lastName: 'Игрок',
            },
          },
        ],
      }),
    );
    const profileId = '55555555-5555-4555-8555-555555555555';
    const resolveProfileIds = vi
      .fn()
      .mockResolvedValue(new Map([['33333333-3333-4333-8333-333333333333', profileId]]));
    const adapter = new VivaExerciseRosterSourceAdapter({
      mode: 'production',
      apiBaseUrl: 'https://api.vivacrm.test',
      apiKey: 'server-only-key',
      fetchImplementation,
      resolveProfileIds,
    });

    const [first, second] = await Promise.all([
      adapter.read({ tenantId, exerciseExternalId, correlationId: 'correlation-1' }),
      adapter.read({ tenantId, exerciseExternalId, correlationId: 'correlation-2' }),
    ]);

    expect(adapter.accessScope).toBe('BOOKING_OWNER');
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      profileId,
      displayName: 'Алексей Сергеев',
      avatarUrl: null,
    });
    expect(first[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    const participant = first[0];
    expect(participant).toBeDefined();
    expect(adapter.readAvatarSource(participant?.id ?? '')).toBe(
      'https://media.vivacrm.test/private/avatar.jpg',
    );
    expect(JSON.stringify(first)).not.toContain('33333333-3333-4333-8333-333333333333');
    expect(resolveProfileIds).toHaveBeenCalledWith({
      tenantId,
      externalClientIds: ['33333333-3333-4333-8333-333333333333'],
    });
    const [requestUrl, requestInit] = fetchImplementation.mock.calls[0] as [URL, RequestInit];
    expect(requestUrl.pathname).toBe(`/api/v1/exercises/${exerciseExternalId}/bookings`);
    expect(new Headers(requestInit.headers).get('authorization')).toBe('Bearer server-only-key');
  });

  it('falls back to a fresh roster when a refresh fails', async () => {
    let now = 1_000;
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          content: [
            {
              isCancelled: false,
              client: {
                id: '33333333-3333-4333-8333-333333333333',
                firstName: 'Мария',
                lastName: 'Иванова',
              },
            },
          ],
        }),
      )
      .mockRejectedValueOnce(new Error('offline'));
    const adapter = new VivaExerciseRosterSourceAdapter({
      mode: 'sandbox',
      apiBaseUrl: 'https://api.vivacrm.test',
      apiKey: 'server-only-key',
      fetchImplementation,
      maxAttempts: 1,
      freshTtlMs: 10,
      staleTtlMs: 1_000,
      now: () => now,
    });
    const first = await adapter.read({ tenantId, exerciseExternalId, correlationId: 'one' });
    now += 20;
    const stale = await adapter.read({ tenantId, exerciseExternalId, correlationId: 'two' });
    expect(stale).toEqual(first);
  });

  it('uses the trusted PadlHub proxy without forwarding a Viva system key', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      Response.json([
        {
          isCancelled: false,
          client: {
            id: '33333333-3333-4333-8333-333333333333',
            firstName: 'Мария',
            lastName: 'Иванова',
          },
        },
      ]),
    );
    const adapter = new VivaExerciseRosterSourceAdapter({
      mode: 'sandbox',
      apiBaseUrl: 'https://padlhub.test',
      transport: 'PADLHUB_PROXY',
      fetchImplementation,
    });

    const participants = await adapter.read({
      tenantId,
      exerciseExternalId,
      correlationId: 'proxy-correlation',
    });

    expect(adapter.accessScope).toBe('PUBLIC');
    expect(participants[0]?.displayName).toBe('Мария Иванова');
    const [requestUrl, requestInit] = fetchImplementation.mock.calls[0] as [URL, RequestInit];
    expect(requestUrl.pathname).toBe('/lk/tournaments/participants');
    expect(requestUrl.searchParams.get('exerciseId')).toBe(exerciseExternalId);
    expect(new Headers(requestInit.headers).has('authorization')).toBe(false);
  });
});
