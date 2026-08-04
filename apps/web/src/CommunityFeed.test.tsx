// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CommunityMediaStatus,
  CommunityMediaUploadIssued,
  CommunityPost,
} from '@phub/api-sdk';

import { CommunityFeed, type CommunityFeedProps } from './CommunityFeed.js';

const communityId = '11111111-1111-4111-8111-111111111111';
const mediaId = '22222222-2222-4222-8222-222222222222';
const postId = '33333333-3333-4333-8333-333333333333';
const now = '2026-08-04T12:00:00.000Z';
const revokeObjectURL = vi.fn();

const issued: CommunityMediaUploadIssued = {
  id: mediaId,
  communityId,
  uploaderUserId: '44444444-4444-4444-8444-444444444444',
  mediaType: 'IMAGE',
  state: 'UPLOADING',
  revision: 1,
  declaredContentType: 'image/webp',
  declaredByteSize: 12,
  declaredSha256: 'a'.repeat(64),
  upload: {
    method: 'PUT',
    url: 'https://media.test/phub-media/source?signature=redacted',
    requiredHeaders: { 'Content-Type': 'image/webp' },
    expiresAt: now,
  },
  createdAt: now,
  updatedAt: now,
};

const scanning: CommunityMediaStatus = {
  ...issued,
  state: 'SCANNING',
  finalizedAt: now,
};

const ready: CommunityMediaStatus = {
  ...issued,
  state: 'READY',
  width: 64,
  height: 32,
  variants: [
    {
      variant: 'FEED',
      url: `/user/api/v1/local/communities/${communityId}/media/${mediaId}/variants/FEED`,
      contentType: 'image/webp',
      width: 64,
      height: 32,
      byteSize: 48,
    },
  ],
  readyAt: now,
  unattachedExpiresAt: now,
};

function post(status: CommunityPost['status'], body = 'Новость сообщества'): CommunityPost {
  return {
    id: postId,
    communityId,
    authorUserId: '44444444-4444-4444-8444-444444444444',
    status,
    body,
    revision: 1,
    createdAt: now,
    publishedAt: status === 'PUBLISHED' ? now : null,
    updatedAt: now,
    archivedAt: null,
    restoreUntil: null,
    retentionUntil: null,
  };
}

function props(overrides: Partial<CommunityFeedProps> = {}): CommunityFeedProps {
  return {
    communityId,
    canPublish: true,
    loadFeed: vi.fn().mockResolvedValue({ items: [], watermark: now }),
    issueMediaUpload: vi.fn().mockResolvedValue(issued),
    finalizeMediaUpload: vi.fn().mockResolvedValue(scanning),
    getMediaStatus: vi.fn().mockResolvedValue(ready),
    createPost: vi.fn().mockResolvedValue(post('PUBLISHED')),
    loadMediaVariant: vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/webp' })),
    pollIntervalMs: 1,
    maxPollAttempts: 3,
    ...overrides,
  };
}

beforeEach(() => {
  revokeObjectURL.mockReset();
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn().mockReturnValue('55555555-5555-4555-8555-555555555555'),
    subtle: {
      digest: vi.fn().mockResolvedValue(new Uint8Array(32).buffer),
    },
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn().mockReturnValue('blob:community-image'),
    revokeObjectURL,
  });
  Object.defineProperty(File.prototype, 'arrayBuffer', {
    configurable: true,
    value: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CommunityFeed media composer', () => {
  it('atomically applies a canonical snapshot without issuing a second feed read', async () => {
    const loadFeed = vi.fn();
    const api = props({
      loadFeed,
      canonicalSnapshot: {
        revision: 1,
        page: { items: [post('PUBLISHED', 'Канонический пост')], watermark: now },
      },
    });
    const view = render(<CommunityFeed {...api} />);

    expect(await screen.findByText('Канонический пост')).toBeVisible();
    expect(loadFeed).not.toHaveBeenCalled();

    view.rerender(
      <CommunityFeed
        {...api}
        canonicalSnapshot={{
          revision: 2,
          page: { items: [post('PUBLISHED', 'Пост после recovery')], watermark: now },
        }}
      />,
    );
    expect(await screen.findByText('Пост после recovery')).toBeVisible();
    expect(screen.queryByText('Канонический пост')).not.toBeInTheDocument();
  });

  it('uploads, finalizes and polls every image before enabling publication', async () => {
    let resolveStatus: (status: CommunityMediaStatus) => void = () => undefined;
    const status = new Promise<CommunityMediaStatus>((resolve) => {
      resolveStatus = resolve;
    });
    const api = props({ getMediaStatus: vi.fn().mockReturnValue(status) });
    render(<CommunityFeed {...api} />);
    const user = userEvent.setup();
    const publish = screen.getByRole('button', { name: 'Опубликовать' });
    expect(publish).toBeDisabled();
    await user.type(screen.getByLabelText('Новая публикация'), 'Тренировка в субботу');
    expect(publish).toBeEnabled();

    const file = new File(['image'], 'court.webp', { type: 'image/webp' });
    await user.upload(screen.getByLabelText('Добавить изображения'), file);
    expect(publish).toBeDisabled();
    expect(await screen.findByText('Проверяем…')).toBeVisible();
    await act(async () => {
      resolveStatus(ready);
      await status;
    });
    await waitFor(() => expect(screen.getByText('Готово')).toBeVisible());
    expect(publish).toBeEnabled();

    await user.click(publish);

    expect(api.issueMediaUpload).toHaveBeenCalledWith(
      communityId,
      expect.objectContaining({ mediaType: 'IMAGE', contentType: 'image/webp' }),
    );
    expect(fetch).toHaveBeenCalledWith(
      issued.upload.url,
      expect.objectContaining({ method: 'PUT', body: file, redirect: 'error' }),
    );
    expect(api.finalizeMediaUpload).toHaveBeenCalledWith(communityId, mediaId, 1);
    expect(api.getMediaStatus).toHaveBeenCalledWith(communityId, mediaId);
    expect(api.createPost).toHaveBeenCalledWith(communityId, {
      body: 'Тренировка в субботу',
      mediaIds: [mediaId],
    });
    expect(await screen.findByText('Публикация размещена.')).toBeVisible();
  });

  it('keeps failed or unfinished media from being published', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 403 } as Response);
    const api = props();
    render(<CommunityFeed {...api} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Новая публикация'), 'Пост с фото');
    await user.upload(
      screen.getByLabelText('Добавить изображения'),
      new File(['image'], 'court.webp', { type: 'image/webp' }),
    );

    expect(await screen.findByText('Хранилище отклонило загрузку изображения.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Опубликовать' })).toBeDisabled();
    expect(api.createPost).not.toHaveBeenCalled();
  });

  it('validates the file count and supported image formats before issue', async () => {
    const api = props();
    render(<CommunityFeed {...api} />);
    const input = screen.getByLabelText('Добавить изображения');
    fireEvent.change(input, {
      target: {
        files: Array.from(
          { length: 11 },
          (_, index) => new File(['x'], `${index}.webp`, { type: 'image/webp' }),
        ),
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('не более 10 изображений');
    expect(api.issueMediaUpload).not.toHaveBeenCalled();

    fireEvent.change(input, {
      target: { files: [new File(['x'], 'animation.gif', { type: 'image/gif' })] },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('JPEG, PNG или WebP');
    expect(api.issueMediaUpload).not.toHaveBeenCalled();
  });

  it('does not render pending moderation content as published', async () => {
    const api = props({
      createPost: vi.fn().mockResolvedValue(post('PENDING_MODERATION', 'Скрытый черновик')),
    });
    render(<CommunityFeed {...api} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Новая публикация'), 'Скрытый черновик');
    await user.click(screen.getByRole('button', { name: 'Опубликовать' }));

    expect(await screen.findByText('Публикация отправлена на модерацию.')).toBeVisible();
    expect(screen.queryByText('Скрытый черновик')).not.toBeInTheDocument();
  });

  it('loads protected variants through a Blob callback and revokes the object URL', async () => {
    const published = {
      ...post('PUBLISHED'),
      media: [
        {
          id: mediaId,
          mediaType: 'IMAGE' as const,
          width: 64,
          height: 32,
          variants: ready.state === 'READY' ? ready.variants : [],
        },
      ],
    };
    const api = props({
      loadFeed: vi.fn().mockResolvedValue({ items: [published], watermark: now }),
    });
    const view = render(<CommunityFeed {...api} />);

    const image = await screen.findByRole('img', { name: 'Изображение публикации' });
    expect(image).toHaveAttribute('src', 'blob:community-image');
    expect(api.loadMediaVariant).toHaveBeenCalledWith(communityId, mediaId, 'FEED');
    expect(image).not.toHaveAttribute('src', expect.stringContaining('/user/api/'));

    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:community-image');
  });
});
