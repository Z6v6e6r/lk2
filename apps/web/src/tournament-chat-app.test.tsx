// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { App } from './App.js';
import { createBrowserAuthGateway } from './auth-gateway.js';
const id = '10000000-0000-4000-8000-000000000001';
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', `/tournaments/${id}/chat`);
});
afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});
it.each(['web', 'android'] as const)(
  'actual App %s opens the exact chat route without an implicit command',
  async (platform) => {
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.invalid',
      tenantKey: 'synthetic',
      platform,
      appVersion: 'test',
      fetchImplementation: vi.fn(),
    });
    vi.spyOn(gateway, 'restoreSession').mockResolvedValue({
      context: {
        user: { id, displayName: 'Synthetic' },
        tenant: { id, key: 'synthetic', name: 'Synthetic' },
        roles: ['client'],
        permissions: [],
      },
    });
    vi.spyOn(gateway, 'tournamentChatPrincipal').mockReturnValue('synthetic-session');
    const history = vi.spyOn(gateway, 'getTournamentChatHistory').mockResolvedValue({
      contractVersion: 'tournament-chat.v1',
      tournamentId: id,
      streamId: null,
      throughSequence: 0,
      messages: [],
      hasMore: false,
      nextCursor: null,
    });
    const send = vi.spyOn(gateway, 'sendTournamentChatMessage'),
      status = vi.spyOn(gateway, 'getTournamentChatRequest');
    render(<App gateway={gateway} tenantKey="synthetic" clientPlatform={platform} />);
    await screen.findByRole('heading', { name: 'Чат турнира' });
    await screen.findByRole('textbox', { name: 'Сообщение' });
    expect(history).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  },
);
