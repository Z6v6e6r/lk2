// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { ConversationMessage } from '../auth-gateway.js';
import { ChatMessageBubble } from './ChatMessageBubble.js';

afterEach(cleanup);

const conversationId = '22222222-2222-4222-8222-222222222222';

/** A reader never receives a bare URL: the API route is bearer-authenticated, so it loads a blob. */
function loadMedia(targetConversationId: string, mediaId: string): Promise<Blob> {
  expect(targetConversationId).toBe(conversationId);
  expect(mediaId).toMatch(/^[0-9a-f-]{36}$/u);
  return Promise.resolve(new Blob(['attachment-bytes'], { type: 'application/octet-stream' }));
}

function messageWith(
  attachments: NonNullable<ConversationMessage['attachments']>,
  body = '',
): ConversationMessage {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    conversationId,
    sequence: 1,
    sender: { userId: '11111111-1111-4111-8111-111111111111', displayName: 'Борис' },
    messageType: attachments.some((attachment) => attachment.mediaType === 'FILE')
      ? 'FILE'
      : 'IMAGE',
    body,
    attachments,
    createdAt: '2026-08-03T10:00:00.000Z',
  };
}

describe('ChatMessageBubble attachments', () => {
  it('renders a file card with name, size and a download link', async () => {
    const mediaId = '55555555-5555-4555-8555-555555555555';
    render(
      <ChatMessageBubble
        message={messageWith([
          {
            mediaId,
            position: 1,
            mediaType: 'FILE',
            fileName: 'договор.pdf',
            contentType: 'application/pdf',
            byteSize: 2 * 1024 * 1024,
          },
        ])}
        own={false}
        showSender
        loadMedia={loadMedia}
      />,
    );

    const card = await screen.findByRole('link', {
      name: new RegExp(`Скачать файл договор\\.pdf`, 'u'),
    });
    await waitFor(() => expect(card.getAttribute('href')).toMatch(/^blob:/u));
    expect(card).toHaveAttribute('download', 'договор.pdf');
    expect(card).toHaveTextContent('2 МБ');
    expect(card).toHaveTextContent('Скачать');
  });

  it('renders a compact image grid with lazy, alt-labelled object URLs', async () => {
    render(
      <ChatMessageBubble
        message={messageWith([
          {
            mediaId: '55555555-5555-4555-8555-555555555551',
            position: 1,
            mediaType: 'IMAGE',
            fileName: 'первое.png',
            contentType: 'image/png',
            byteSize: 1024,
          },
          {
            mediaId: '55555555-5555-4555-8555-555555555552',
            position: 2,
            mediaType: 'IMAGE',
            fileName: 'второе.png',
            contentType: 'image/png',
            byteSize: 2048,
          },
        ])}
        own
        showSender
        loadMedia={loadMedia}
      />,
    );

    const grid = screen.getByRole('list', { name: 'Изображения в сообщении' });
    const images = await within(grid).findAllByRole('img');
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute('alt', 'первое.png');
    expect(images[0]).toHaveAttribute('loading', 'lazy');
    expect(images[0]?.getAttribute('src')).toMatch(/^blob:/u);
  });

  it('shows image, file and text together in one bubble', async () => {
    render(
      <ChatMessageBubble
        message={messageWith(
          [
            {
              mediaId: '55555555-5555-4555-8555-555555555551',
              position: 1,
              mediaType: 'IMAGE',
              fileName: 'фото.png',
              contentType: 'image/png',
              byteSize: 1024,
            },
            {
              mediaId: '55555555-5555-4555-8555-555555555552',
              position: 2,
              mediaType: 'FILE',
              fileName: 'смета.xlsx',
              contentType: 'application/vnd.ms-excel',
              byteSize: 4096,
            },
          ],
          'Держите материалы',
        )}
        own={false}
        showSender
        loadMedia={loadMedia}
      />,
    );

    expect(screen.getByRole('list', { name: 'Изображения в сообщении' })).toBeVisible();
    expect(screen.getByRole('list', { name: 'Файлы в сообщении' })).toBeVisible();
    expect(screen.getByText('Держите материалы')).toBeVisible();
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(1));
    expect(await screen.findByText('Скачать')).toBeVisible();
  });
});
