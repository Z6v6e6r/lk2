// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { createBrowserAuthGateway } from './auth-gateway.js';
import { StationMessageCustody } from './chats-ui/station-message-custody.js';
const user = '11111111-1111-4111-8111-111111111111';
const community = '22222222-2222-4222-8222-222222222222';
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState({}, '', '/chats');
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});
it.each([
  ['android', 'UNADOPTED'],
  ['web', 'UNADOPTED'],
  ['android', 'AVAILABLE'],
  ['web', 'AVAILABLE'],
] as const)(
  'actual App %s/%s uses its scoped station custody and real handlers',
  async (platform, availability) => {
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.example.test',
      tenantKey: 'test',
      platform,
      appVersion: 'test',
      fetchImplementation: vi.fn(),
    });
    vi.spyOn(gateway, 'restoreSession').mockResolvedValue({
      context: {
        user: { id: user, displayName: 'Player' },
        tenant: { id: community, key: 'test', name: 'Test' },
        roles: ['client'],
        permissions: [],
        runtimeCapabilities: {
          phoneSubjectLink: false,
          communityDirectory: true,
          communityReadDetail: false,
          communityReadFeed: false,
          communityReadChat: true,
          communityReadRating: false,
          communityCanonical: false,
          communityDirectInvites: false,
          communityRealtime: false,
        },
      },
    });
    vi.spyOn(gateway, 'listConversations').mockResolvedValue({ items: [] });
    vi.spyOn(gateway, 'listMyCommunities').mockResolvedValue({
      items: [
        {
          id: community,
          title: 'Station club',
          logoUrl: null,
          isVerified: true,
          unreadChatCount: 0,
          route: '/communities/' + community,
        },
      ],
    });
    vi.spyOn(gateway, 'stationMessagePrincipal').mockReturnValue('original-principal');
    vi.spyOn(gateway, 'listStationStreamSummaries').mockResolvedValue({
      contractVersion: 1,
      contract: 'station-stream-summaries',
      items: [
        availability === 'AVAILABLE'
          ? {
              communityId: community,
              availability,
              streamId: community,
              membershipEpoch: 1,
              baselineSequence: 0,
              readThroughSequence: 0,
              publishedThroughSequence: 1,
              unreadCount: 1,
            }
          : { communityId: community, availability },
      ],
    });
    const history = vi.spyOn(gateway, 'listCommunityReadExperienceChat').mockResolvedValue({
      canRequestStationMessage: true,
      items: [
        {
          id: '33333333-3333-8333-8333-333333333333',
          body: 'station history',
          sentAt: '2026-11-01T00:00:00.000Z',
          author: { displayName: 'Player' },
          isViewer: true,
        },
      ],
    });
    vi.spyOn(gateway, 'getStationCommunityStream').mockResolvedValue({
      historyVersion: 3,
      mode: 'STREAM',
      streamId: community,
      membershipEpoch: 1,
      baselineSequence: 0,
      readThroughSequence: 0,
      publishedThroughSequence: 1,
      unreadCount: 1,
      afterSequence: 0,
      throughSequence: 1,
      items: [
        {
          id: '33333333-3333-8333-8333-333333333333',
          body: 'station history',
          sentAt: '2026-11-01T00:00:00.000Z',
          author: { displayName: 'Player' },
          isViewer: true,
          sequence: 1,
        },
      ],
      nextCursor: null,
      catchUpCursor: 'catch_up_cursor_',
      olderCursor: null,
      archiveCursor: 'archive_cursor__',
      canRequestStationMessage: true,
    });
    const send = vi
      .spyOn(gateway, 'sendStationCommunityMessage')
      .mockImplementation((_community, input) =>
        Promise.resolve({
          contractVersion: 1,
          contract: 'station-message',
          requestId: input.requestId,
          outcome: 'UNKNOWN',
          code: 'MESSAGE_RECEIPT_UNPROVEN',
        }),
      );
    const status = vi
      .spyOn(gateway, 'getStationCommunityMessageRequest')
      .mockImplementation((_community, requestId) =>
        Promise.resolve({
          contractVersion: 1,
          contract: 'station-message',
          requestId,
          outcome: 'UNKNOWN',
          code: 'MESSAGE_RECEIPT_UNPROVEN',
        }),
      );
    const pending = await new StationMessageCustody(
      JSON.stringify(['test', user]),
      community,
      platform === 'android' ? localStorage : sessionStorage,
    ).original('original pending');
    render(<App gateway={gateway} tenantKey="test" clientPlatform={platform} />);
    fireEvent.click(await screen.findByRole('button', { name: /Сообщества/ }, { timeout: 5000 }));
    fireEvent.click(await screen.findByRole('button', { name: /Station club/ }));
    await screen.findByText('station history');
    if (availability === 'AVAILABLE') {
      expect(history).not.toHaveBeenCalled();
      expect(screen.getByText('Непрочитанных сообщений: 1')).toBeTruthy();
    } else expect(history).toHaveBeenCalledWith(community, undefined);
    await waitFor(() => expect(status).toHaveBeenCalledWith(community, pending.requestId));
    fireEvent.change(screen.getByRole('textbox', { name: 'Сообщение сообществу' }), {
      target: { value: 'Web message' },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    if (platform === 'android') {
      await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
      expect(status).toHaveBeenLastCalledWith(community, pending.requestId);
      expect(send).not.toHaveBeenCalled();
    } else await waitFor(() => expect(send).toHaveBeenCalledOnce());
  },
);
