// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocationAdminView } from '@phub/locations';

import { LocationsWorkspace } from './LocationsWorkspace.js';
import type { NotificationAdminClient } from './notification-admin-client.js';

afterEach(cleanup);

const location = (id: string, title: string) =>
  ({
    id,
    version: 3,
    slug: id === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' ? 'terekhovo' : 'seliger',
    title,
    shortTitle: null,
    city: 'Москва',
    courtCount: 4,
    address: 'Тестовый адрес',
    latitude: 55.7,
    longitude: 37.6,
    timezone: 'Europe/Moscow',
    metroName: null,
    metroDistanceMeters: null,
    phoneE164: null,
    workingHours: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map((weekday) => ({
      weekday,
      closed: false,
      intervals: [{ opensAt: '07:00', closesAt: '23:00' }],
    })),
    amenities: [],
    gallery: [],
    recommendationPhotos: [],
    publicationStatus: 'DRAFT',
    showOnHome: true,
    sortOrder: 100,
    completeness: { percent: 100, missingFields: [], readyToPublish: true },
  }) as unknown as LocationAdminView;

function mediaAsset(id: string) {
  return {
    id,
    status: 'READY',
    mediaUrl: `/public/api/v1/local-padel/location-media/${id}`,
    contentType: 'image/webp',
    bytes: 1200,
    width: 800,
    height: 500,
    sha256: 'a'.repeat(64),
    createdAt: '2026-10-11T10:00:00.000Z',
    replayed: false,
  };
}

describe('LocationsWorkspace gallery uploads', () => {
  it('adds the stable PadlHub media URL to a new gallery row after computer upload', async () => {
    const mediaUrl =
      '/public/api/v1/local-padel/location-media/44444444-4444-4444-8444-444444444444';
    const uploadLocationMedia = vi.fn().mockResolvedValue({
      id: '44444444-4444-4444-8444-444444444444',
      status: 'READY',
      mediaUrl,
      contentType: 'image/webp',
      bytes: 1200,
      width: 800,
      height: 500,
      sha256: 'a'.repeat(64),
      createdAt: '2026-07-19T10:00:00.000Z',
      replayed: false,
    });
    const client = {
      listLocations: vi.fn().mockResolvedValue({ items: [] }),
      createLocation: vi.fn(),
      updateLocation: vi.fn(),
      uploadLocationMedia,
      resolveMediaUrl: (url: string) => `https://api.padlhub.test${url}`,
      resolveLocationMediaUrl: (id: string) =>
        `https://api.padlhub.test/public/api/v1/local-padel/location-media/${id}`,
    } as unknown as NotificationAdminClient;
    render(<LocationsWorkspace client={client} />);
    const input = await screen.findByLabelText('Загрузить фотографию с компьютера');
    const file = new File(['png-bytes'], 'location.png', { type: 'image/png' });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(uploadLocationMedia).toHaveBeenCalledWith(file));
    expect(await screen.findByDisplayValue(mediaUrl)).toBeInTheDocument();
    expect(screen.getByText('Фотография загружена.')).toBeInTheDocument();
  });

  it('uploads several photos for a recommendation type, activates one and saves the station', async () => {
    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = '22222222-2222-4222-8222-222222222222';
    const station = location('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Терехово');
    const uploadLocationMedia = vi
      .fn()
      .mockResolvedValueOnce(mediaAsset(firstId))
      .mockResolvedValueOnce(mediaAsset(secondId));
    const updateLocation = vi.fn().mockResolvedValue({ ...station, version: 4 });
    const client = {
      listLocations: vi.fn().mockResolvedValue({ items: [station] }),
      createLocation: vi.fn(),
      updateLocation,
      uploadLocationMedia,
      resolveMediaUrl: (url: string) => url,
      resolveLocationMediaUrl: (id: string) => `/location-media/${id}`,
    } as unknown as NotificationAdminClient;
    render(<LocationsWorkspace client={client} />);

    fireEvent.click((await screen.findByText('Терехово')).closest('button')!);
    const input = screen.getByLabelText('Загрузить фото для карточки «Игра»');
    fireEvent.change(input, {
      target: {
        files: [
          new File(['one'], 'game-one.png', { type: 'image/png' }),
          new File(['two'], 'game-two.png', { type: 'image/png' }),
        ],
      },
    });

    await waitFor(() => expect(uploadLocationMedia).toHaveBeenCalledTimes(2));
    expect(await screen.findAllByAltText('Фото для карточки «Игра»')).toHaveLength(2);
    fireEvent.click(screen.getByLabelText('Использовать фото 1 для карточки «Игра»'));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик' }));

    await waitFor(() =>
      expect(updateLocation).toHaveBeenCalledWith(
        station.id,
        station.version,
        expect.objectContaining({
          recommendationPhotos: [
            expect.objectContaining({ assetId: firstId, eventType: 'GAME', isActive: true }),
            expect.objectContaining({ assetId: secondId, eventType: 'GAME', isActive: false }),
          ],
        }),
      ),
    );
  });

  it('keeps an in-flight recommendation upload on its station and allows removing it', async () => {
    const first = location('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Терехово');
    const second = location('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Селигерская');
    let finishUpload: ((value: ReturnType<typeof mediaAsset>) => void) | undefined;
    const uploadLocationMedia = vi.fn(
      () => new Promise<ReturnType<typeof mediaAsset>>((resolve) => (finishUpload = resolve)),
    );
    const client = {
      listLocations: vi.fn().mockResolvedValue({ items: [first, second] }),
      createLocation: vi.fn(),
      updateLocation: vi.fn(),
      uploadLocationMedia,
      resolveMediaUrl: (url: string) => url,
      resolveLocationMediaUrl: (id: string) => `/location-media/${id}`,
    } as unknown as NotificationAdminClient;
    render(<LocationsWorkspace client={client} />);

    fireEvent.click((await screen.findByText('Терехово')).closest('button')!);
    fireEvent.change(screen.getByLabelText('Загрузить фото для карточки «Игра»'), {
      target: { files: [new File(['one'], 'game.png', { type: 'image/png' })] },
    });

    await waitFor(() => expect(uploadLocationMedia).toHaveBeenCalledOnce());
    expect(screen.getByText('Селигерская').closest('button')).toBeDisabled();
    finishUpload?.(mediaAsset('33333333-3333-4333-8333-333333333333'));
    const image = await screen.findByAltText('Фото для карточки «Игра»');
    expect(image).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Удалить фото для карточки «Игра»' }));
    await waitFor(() =>
      expect(screen.queryByAltText('Фото для карточки «Игра»')).not.toBeInTheDocument(),
    );
  });

  it('skips a replayed asset already bound to the same recommendation type', async () => {
    const id = '44444444-4444-4444-8444-444444444444';
    const station = location('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Терехово');
    const uploadLocationMedia = vi.fn().mockResolvedValue(mediaAsset(id));
    const client = {
      listLocations: vi.fn().mockResolvedValue({ items: [station] }),
      createLocation: vi.fn(),
      updateLocation: vi.fn(),
      uploadLocationMedia,
      resolveMediaUrl: (url: string) => url,
      resolveLocationMediaUrl: (assetId: string) => `/location-media/${assetId}`,
    } as unknown as NotificationAdminClient;
    render(<LocationsWorkspace client={client} />);

    fireEvent.click((await screen.findByText('Терехово')).closest('button')!);
    fireEvent.change(screen.getByLabelText('Загрузить фото для карточки «Игра»'), {
      target: {
        files: [
          new File(['same'], 'same-one.png', { type: 'image/png' }),
          new File(['same'], 'same-two.png', { type: 'image/png' }),
        ],
      },
    });

    await waitFor(() => expect(uploadLocationMedia).toHaveBeenCalledTimes(2));
    expect(await screen.findAllByAltText('Фото для карточки «Игра»')).toHaveLength(1);
    expect(screen.getByText(/уже было добавлено: 1/i)).toBeInTheDocument();
  });
});
