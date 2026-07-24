// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocationsWorkspace } from './LocationsWorkspace.js';
import type { NotificationAdminClient } from './notification-admin-client.js';

afterEach(cleanup);

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
    } as unknown as NotificationAdminClient;
    render(<LocationsWorkspace client={client} />);
    const input = await screen.findByLabelText('Загрузить фотографию с компьютера');
    const file = new File(['png-bytes'], 'location.png', { type: 'image/png' });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(uploadLocationMedia).toHaveBeenCalledWith(file));
    expect(await screen.findByDisplayValue(mediaUrl)).toBeInTheDocument();
    expect(screen.getByText('Фотография загружена.')).toBeInTheDocument();
  });
});
