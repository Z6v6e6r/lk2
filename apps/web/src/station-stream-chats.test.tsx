// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { ChatsPage, type CommunityChatsSource } from './ChatsPage.js';
import { writeCommunityChatsCache } from './chats-ui/community-chats-cache.js';
const id = '11111111-1111-4111-8111-111111111111';
const row = {
  id,
  title: 'Station stream',
  logoUrl: null,
  isVerified: true,
  unreadChatCount: 0,
  route: '/communities/' + id,
};
const position = {
  streamId: id,
  membershipEpoch: 0,
  baselineSequence: 0,
  readThroughSequence: 0,
  publishedThroughSequence: 0,
  unreadCount: 0,
};
const props = {
  mode: 'list' as const,
  hasExplicitRecipient: false,
  page: { items: [] },
  messages: [],
  currentUserId: id,
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
};
function source(
  availability: 'AVAILABLE' | 'UNADOPTED' | 'NOT_STATION' | 'ERROR',
): CommunityChatsSource {
  return {
    loadCommunities: vi.fn(() => Promise.resolve({ items: [row] })),
    loadMessages: vi.fn(() => Promise.resolve({ items: [] })),
    stream: {
      scope: 'tenant:user',
      principal: 'first',
      isCurrent: () => true,
      summaries: vi.fn(() =>
        availability === 'ERROR'
          ? Promise.reject(new Error('unavailable'))
          : Promise.resolve({
              contractVersion: 1 as const,
              contract: 'station-stream-summaries' as const,
              items: [
                availability === 'AVAILABLE'
                  ? { communityId: id, availability, ...position }
                  : { communityId: id, availability },
              ],
            }),
      ),
      page: vi.fn(() =>
        Promise.resolve({
          historyVersion: 3 as const,
          mode: 'STREAM' as const,
          ...position,
          afterSequence: 0,
          throughSequence: 0,
          items: [],
          nextCursor: null,
          catchUpCursor: 'abcdefghijklmnop',
          olderCursor: null,
          archiveCursor: 'abcdefghijklmnop',
          canRequestStationMessage: true,
        }),
      ),
      read: vi.fn(),
      status: vi.fn(),
    },
  };
}
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
it.each(['AVAILABLE', 'UNADOPTED', 'NOT_STATION', 'ERROR'] as const)(
  'fresh %s selects only its authorized history mode',
  async (availability) => {
    const s = source(availability);
    render(<ChatsPage {...props} communityChats={s} />);
    fireEvent.click(screen.getByRole('button', { name: 'Сообщества' }));
    fireEvent.click(await screen.findByText('Station stream'));
    if (availability === 'AVAILABLE') {
      await screen.findByText('Непрочитанных сообщений: 0');
      expect(s.stream!.page).toHaveBeenCalledOnce();
      expect(s.loadMessages).not.toHaveBeenCalled();
    } else if (availability === 'ERROR') {
      await screen.findByText('Не удалось подтвердить доступ к истории и счётчику сообщений.');
      expect(s.stream!.page).not.toHaveBeenCalled();
      expect(s.loadMessages).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Число непрочитанных сообщений недоступно')).toBeTruthy();
    } else {
      await vi.waitFor(() => expect(s.loadMessages).toHaveBeenCalledOnce());
      expect(s.stream!.page).not.toHaveBeenCalled();
    }
    expect(s.stream!.read).not.toHaveBeenCalled();
  },
);
it('cached AVAILABLE is not adoption authority before fresh summaries', async () => {
  writeCommunityChatsCache(
    id,
    [{ ...row, stationStream: { communityId: id, availability: 'AVAILABLE', ...position } }],
    null,
  );
  const s = source('ERROR');
  vi.mocked(s.loadCommunities).mockReturnValue(new Promise(() => {}));
  render(<ChatsPage {...props} communityChats={s} />);
  fireEvent.click(screen.getByRole('button', { name: 'Сообщества' }));
  fireEvent.click(screen.getByText('Station stream'));
  await screen.findByText('Не удалось подтвердить доступ к истории и счётчику сообщений.');
  expect(s.stream!.page).not.toHaveBeenCalled();
  expect(s.loadMessages).not.toHaveBeenCalled();
});
