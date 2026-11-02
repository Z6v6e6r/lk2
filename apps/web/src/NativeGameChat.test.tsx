// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeGameChat } from './NativeGameChat.js';
import { game as publicGame } from '../../mobile/src/ios/testing/cabinet-fixtures.js';
import type { GameCard as ViewerGameCard } from './auth-gateway.js';
const game: ViewerGameCard = {
  ...publicGame,
  surface: 'MY_UPCOMING',
  levelRange: publicGame.levelRange ?? null,
  capacity: { ...publicGame.capacity, total: 4 },
  priceSummary: publicGame.priceSummary ?? null,
  participants: publicGame.participants.map((p, index) => ({
    ...p,
    userId: `00000000-0000-4000-8000-00000000000${index}`,
  })),
  viewerRelation: 'PARTICIPANT',
  conversation: null,
  resultSummary: null,
};
import type { GetOrCreateGameConversationResult } from '@phub/api-sdk';
const id = '22222222-2222-4222-8222-222222222222';
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});
it('opens an authorized existing game chat without a command', () => {
  const open = vi.fn();
  render(
    <NativeGameChat
      game={{
        ...game,
        levelRange: null,
        resultSummary: null,
        allowedActions: ['OPEN_CHAT'],
        conversation: { conversationId: id, unreadCount: 0 },
      }}
      principal={() => 'owner'}
      open={open}
    />,
  );
  expect(screen.getByRole('link', { name: 'Чат игры' })).toHaveAttribute('href', `/chats/${id}`);
  expect(open).not.toHaveBeenCalled();
});
it('public/nonparticipant game never offers chat creation', () => {
  render(
    <NativeGameChat
      game={{
        ...game,
        levelRange: null,
        resultSummary: null,
        viewerRelation: 'NONE',
        conversation: null,
        allowedActions: [],
      }}
      principal={() => 'owner'}
      open={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button')).toBeNull();
});
it.each(['logout', 'unmount'])('late command after %s cannot navigate', async (mode) => {
  let finish!: (v: GetOrCreateGameConversationResult) => void;
  let current: string | null = 'original';
  const open = vi.fn(
    () =>
      new Promise<GetOrCreateGameConversationResult>((r) => {
        finish = r;
      }),
  );
  const view = render(
    <NativeGameChat
      game={{
        ...game,
        levelRange: null,
        resultSummary: null,
        viewerRelation: 'PARTICIPANT',
        conversation: null,
      }}
      principal={() => current}
      open={open}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Чат игры' }));
  fireEvent.click(screen.getByRole('button', { name: 'Чат игры' }));
  expect(open).toHaveBeenCalledTimes(1);
  if (mode === 'logout') current = null;
  else view.unmount();
  await act(async () => {
    finish({
      outcome: 'ok',
      conversation: { id },
      created: true,
      replayed: false,
    } as GetOrCreateGameConversationResult);
    await Promise.resolve();
  });
  expect(window.location.pathname).toBe('/');
});
