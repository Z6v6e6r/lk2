// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { ChatsPage, type CommunityChatsSource } from './ChatsPage.js';
import { communityThreadCache } from './chats-ui/thread-page-cache.js';
const id = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';
const scope = 'tenant/user';
beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const defaults = {
  mode: 'list',
  hasExplicitRecipient: false,
  page: { items: [] },
  messages: [],
  currentUserId: user,
  busy: null,
  error: null,
  pendingMessage: null,
  realtimeState: null,
  hasEarlierMessages: false,
  canRetrySend: false,
  policyBusy: false,
  attachments: [],
  attachmentNotice: null,
  loadMedia: () => Promise.resolve(new Blob()),
  onCreateDirect: vi.fn(),
  onAttachFiles: vi.fn(),
  onRemoveAttachment: vi.fn(),
  onSendMessage: vi.fn(),
  onRetrySend: vi.fn(),
  onRefresh: vi.fn(),
  onLoadEarlier: vi.fn(),
  onSetNotificationPolicy: vi.fn(),
} as const;
it('real thread drops cached messages on owner access denial while retaining original request metadata', async () => {
  const message = {
    id: '33333333-3333-8333-8333-333333333333',
    body: 'private cached body',
    sentAt: '2026-11-01T00:00:00.000Z',
    author: { displayName: 'Player' },
    isViewer: true,
  };
  const source: CommunityChatsSource = {
    custodyScope: scope,
    loadCommunities: vi.fn(() =>
      Promise.resolve({
        items: [
          {
            id,
            title: 'Station club',
            logoUrl: null,
            isVerified: true,
            unreadChatCount: 0,
            route: '/communities/' + id,
          },
        ],
      }),
    ),
    loadMessages: vi.fn(() =>
      Promise.resolve({ items: [message], canRequestStationMessage: true }),
    ),
    sendMessage: vi.fn(() => Promise.reject(Object.assign(new Error('DENIED'), { status: 403 }))),
    getMessageRequest: vi.fn<NonNullable<CommunityChatsSource['getMessageRequest']>>(
      (_id, requestId) =>
        Promise.resolve({
          contractVersion: 1,
          contract: 'station-message',
          requestId,
          outcome: 'UNKNOWN',
          code: 'MESSAGE_RECEIPT_UNPROVEN',
        }),
    ),
  };
  render(<ChatsPage {...defaults} communityChats={source} />);
  fireEvent.click(screen.getByRole('button', { name: /Сообщества/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Station club/ }));
  await screen.findByText('private cached body');
  expect(communityThreadCache.read(scope, id)).toHaveLength(1);
  fireEvent.change(screen.getByRole('textbox', { name: 'Сообщение сообществу' }), {
    target: { value: 'new message' },
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
  await waitFor(() => expect(screen.queryByText('private cached body')).not.toBeInTheDocument());
  expect(communityThreadCache.read(scope, id)).toBeNull();
  expect(screen.getByText(/Ожидают подтверждения: 1/)).toBeInTheDocument();
  expect(source.sendMessage).toHaveBeenCalledOnce();
});
