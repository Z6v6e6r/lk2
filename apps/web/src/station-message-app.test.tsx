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
  window.history.replaceState({}, '', '/chats');
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});
it.each(['android', 'web'] as const)(
  'actual App %s preserves reads but exposes station commands only on Web',
  async (platform) => {
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
      sessionStorage,
    ).original('original pending');
    render(<App gateway={gateway} tenantKey="test" clientPlatform={platform} />);
    fireEvent.click(await screen.findByRole('button', { name: /Сообщества/ }, { timeout: 5000 }));
    fireEvent.click(await screen.findByRole('button', { name: /Station club/ }));
    await screen.findByText('station history');
    expect(history).toHaveBeenCalledWith(community, undefined);
    if (platform === 'android') {
      expect(
        screen.queryByRole('textbox', { name: 'Сообщение сообществу' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Проверить статус' })).not.toBeInTheDocument();
      expect(screen.getByText('Чат сообщества доступен только для чтения.')).toBeInTheDocument();
      expect(send).not.toHaveBeenCalled();
      expect(status).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(status).toHaveBeenCalledWith(community, pending.requestId));
      fireEvent.change(screen.getByRole('textbox', { name: 'Сообщение сообществу' }), {
        target: { value: 'Web message' },
      });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
      await waitFor(() => expect(send).toHaveBeenCalledOnce());
    }
  },
);
