import { describe, expect, it, vi } from 'vitest';

import {
  fetchClientAssistedVivaProfilePhoto,
  normalizePadlHubUpcomingBookings,
  normalizePadlHubUserProfile,
  normalizeVivaUserProfile,
  vivaProfilePhotoSourceUrl,
} from './index.js';

const padlHubUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const vivaProfileId = '7aa93a46-9fa8-42b2-9894-490874fe53f7';

describe('profile normalization', () => {
  it('drops the Viva identifier and emits the canonical PadlHub profile DTO', () => {
    const result = normalizeVivaUserProfile(
      {
        id: vivaProfileId,
        firstName: ' Алексей ',
        middleName: 'Иванович',
        lastName: 'Петров',
        phone: '+7 (999) 123-31-90',
        deposit: 245_000,
        customFields: [
          {
            id: 'eabfe27b-3f72-4496-9185-1a2ec6e6465e',
            value: ['3,8'],
          },
        ],
      },
      padlHubUserId,
    );

    expect(result).toEqual({
      userId: padlHubUserId,
      displayName: 'Алексей Иванович Петров',
      firstName: 'Алексей',
      phoneLast4: '3190',
      balanceMinor: 245_000,
      currency: 'RUB',
      level: { label: 'C+', value: 3.8, assessmentRequired: false },
    });
    expect(JSON.stringify(result)).not.toContain(vivaProfileId);
  });

  it('uses an explicit unassessed level when Viva has no supported rating field', () => {
    expect(
      normalizeVivaUserProfile(
        {
          id: vivaProfileId,
          firstName: null,
          middleName: null,
          lastName: null,
          phone: null,
          deposit: -1500,
          customFields: [],
        },
        padlHubUserId,
      ),
    ).toMatchObject({
      userId: padlHubUserId,
      displayName: 'Игрок ПадлХАБ',
      balanceMinor: -1500,
      level: { label: 'D', value: 0, assessmentRequired: true },
    });
  });

  it('keeps the provider photo URL out of the profile DTO and fetches bounded bytes without credentials', async () => {
    const sourceUrl = 'https://media.vivacrm.invalid/profile/avatar.jpg';
    const payload = {
      id: vivaProfileId,
      firstName: 'Алексей',
      middleName: null,
      lastName: 'Петров',
      phone: null,
      photo: sourceUrl,
      deposit: 0,
      customFields: [],
    };
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }),
    );

    expect(vivaProfilePhotoSourceUrl(payload)).toBe(sourceUrl);
    expect(JSON.stringify(normalizeVivaUserProfile(payload, padlHubUserId))).not.toContain(
      sourceUrl,
    );
    await expect(
      fetchClientAssistedVivaProfilePhoto({
        sourceUrl,
        allowedHosts: ['.vivacrm.invalid'],
        fetchImplementation,
      }),
    ).resolves.toMatchObject({ contentType: 'image/jpeg' });
    expect(fetchImplementation).toHaveBeenCalledWith(
      sourceUrl,
      expect.objectContaining({ method: 'GET', mode: 'cors', credentials: 'omit' }),
    );
    const headers = new Headers(fetchImplementation.mock.calls[0]?.[1]?.headers);
    expect(headers.has('authorization')).toBe(false);
    await expect(
      fetchClientAssistedVivaProfilePhoto({
        sourceUrl: 'https://127.0.0.1/private',
        allowedHosts: ['.vivacrm.invalid'],
        fetchImplementation,
      }),
    ).rejects.toThrow('DIRECT_VIVA_PROFILE_PHOTO_HOST_NOT_ALLOWED');
    expect(fetchImplementation).toHaveBeenCalledOnce();

    const oversizedFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.enqueue(new Uint8Array([3, 4]));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'image/jpeg' } },
      ),
    );
    await expect(
      fetchClientAssistedVivaProfilePhoto({
        sourceUrl,
        allowedHosts: ['.vivacrm.invalid'],
        maxBytes: 3,
        fetchImplementation: oversizedFetch,
      }),
    ).rejects.toThrow('DIRECT_VIVA_PROFILE_PHOTO_TOO_LARGE');
  });

  it('rejects a malformed PadlHub fallback response', () => {
    expect(() => normalizePadlHubUserProfile({ userId: vivaProfileId })).toThrow();
  });

  it('accepts the stable PadlHub profile-photo delivery path', () => {
    const avatarUrl =
      '/public/api/v1/media/profile-photos/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222';

    expect(
      normalizePadlHubUserProfile({
        userId: padlHubUserId,
        displayName: 'Алексей Петров',
        avatarUrl,
        phoneLast4: '3190',
        balanceMinor: 245_000,
        currency: 'RUB',
        level: { label: 'C+', value: 3.8, assessmentRequired: false },
      }),
    ).toMatchObject({ userId: padlHubUserId, avatarUrl });
  });

  it('accepts bookings only when every item has a PadlHub UUID', () => {
    const payload = {
      version: 'home-17',
      generatedAt: '2026-07-15T18:00:00.000Z',
      staleAt: '2026-07-15T18:05:00.000Z',
      items: [
        {
          id: 'e45a6c36-58f3-467a-9ac2-54e36143ccea',
          kind: 'training',
          title: 'Групповая тренировка',
          startsAt: '2026-07-16T10:00:00.000Z',
          venue: 'ПаделХАБ',
          status: 'confirmed',
          route: '/bookings/e45a6c36-58f3-467a-9ac2-54e36143ccea',
        },
      ],
    };

    expect(normalizePadlHubUpcomingBookings(payload)).toEqual(payload);
    expect(() =>
      normalizePadlHubUpcomingBookings({
        ...payload,
        items: [{ ...payload.items[0], id: 'viva-booking-42' }],
      }),
    ).toThrow();
  });
});
