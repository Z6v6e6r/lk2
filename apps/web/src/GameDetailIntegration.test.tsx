// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GameDetailView } from './GameDetailView.js';
import type { GameCard } from './auth-gateway.js';

const PLAYERS = [
  ['f75b4e2a-9c98-4b26-85b6-ae58e0edca24', 'Анна'],
  ['a9c106f7-0db8-4e27-b1e0-298829f94730', 'Борис'],
  ['6a758cce-23ab-4ffd-9c57-a1bc5d4aab70', 'Вера'],
  ['c68f263e-4a54-4472-9254-103e3b332538', 'Глеб'],
] as const;

const game: GameCard = {
  id: '6fe9dc1f-87b5-4efd-83a2-5cf9d8070b76',
  revision: 8,
  surface: 'HISTORY',
  displayState: 'RESULT_REQUIRED',
  title: 'Вечерний матч',
  kind: 'RATING',
  visibility: 'PUBLIC',
  startsAt: '2026-07-22T08:00:00.000Z',
  endsAt: '2026-07-22T09:30:00.000Z',
  timezone: 'Europe/Moscow',
  station: { id: 'ee2eb9ac-fcb5-40d2-a714-97b9ef75a4a0', name: 'Селигерская', shortAddress: null },
  court: { id: '00ea5af2-e651-4b38-9220-cac5191b4ec4', name: 'Корт №3' },
  levelRange: null,
  rosterState: 'LOCKED',
  capacity: { total: 4, occupied: 4, reserved: 0, open: 0, waitlistCount: 0 },
  participants: PLAYERS.map(([userId, displayName], index) => ({
    userId,
    displayName,
    avatarUrl: null,
    level: 'C' as const,
    levelValue: 3.42 + index / 10,
    role: index === 0 ? ('ORGANIZER' as const) : ('PLAYER' as const),
  })),
  priceSummary: null,
  viewerRelation: 'PARTICIPANT',
  viewerPaymentState: 'PAID',
  resultSummary: { state: 'AWAITING_SUBMISSION' },
  badges: ['RATING'],
  allowedActions: ['OPEN_DETAILS', 'SUBMIT_RESULT', 'OPEN_CHAT'],
  deepLink: '/games/6fe9dc1f-87b5-4efd-83a2-5cf9d8070b76',
  conversation: {
    conversationId: 'e82ed43e-4e8c-487e-a308-e926806125bb',
    unreadCount: 0,
  },
};

const recruitingGame: GameCard = {
  ...game,
  surface: 'MY_UPCOMING',
  displayState: 'FINDING_PLAYERS',
  rosterState: 'OPEN',
  resultSummary: null,
  capacity: { total: 4, occupied: 1, reserved: 0, open: 3, waitlistCount: 0 },
  participants: game.participants.slice(0, 1),
};

function renderInviteCard(
  overrides: Partial<GameCard> = {},
  busy = false,
): ReturnType<typeof render> {
  return render(
    <GameDetailView
      activeTab="GAME"
      busy={busy}
      game={{ ...recruitingGame, ...overrides }}
      onAction={vi.fn()}
      onChatOpen={vi.fn()}
      onSubmit={vi.fn().mockResolvedValue(undefined)}
      onTabChange={vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  Reflect.deleteProperty(navigator, 'share');
  Reflect.deleteProperty(navigator, 'clipboard');
  window.history.replaceState({}, '', '/');
});

describe('Game detail integrated presentation', () => {
  it('invites from the bottom of the participant card using only the canonical public game link', async () => {
    const user = userEvent.setup();
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    const onAction = vi.fn();
    window.history.replaceState(
      {},
      '',
      `/games/${game.id}?invitationId=private-token&created=1#result`,
    );
    render(
      <GameDetailView
        activeTab="GAME"
        busy={false}
        game={recruitingGame}
        onAction={onAction}
        onChatOpen={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onTabChange={vi.fn()}
      />,
    );
    const panel = screen.getByRole('region', { name: 'Участники игры' });
    const invite = within(panel).getByRole('button', { name: 'Пригласить в игру' });
    expect(panel.lastElementChild).toContainElement(invite);
    await user.click(invite);
    expect(share).toHaveBeenCalledExactlyOnceWith({
      title: game.title,
      url: new URL(`/games/${game.id}`, window.location.origin).toString(),
    });
    expect(onAction).not.toHaveBeenCalled();
  });

  it('copies the canonical invite link when native sharing is unavailable', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderInviteCard();
    await user.click(screen.getByRole('button', { name: 'Пригласить в игру' }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(
      new URL(`/games/${game.id}`, window.location.origin).toString(),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Ссылка на игру скопирована');
  });

  it.each(['missing', 'denied'])('offers a selectable link when clipboard is %s', async (state) => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value:
        state === 'missing'
          ? undefined
          : { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    renderInviteCard();
    await user.click(screen.getByRole('button', { name: 'Пригласить в игру' }));
    const link = await screen.findByRole('textbox', { name: 'Ссылка на игру' });
    expect(link).toHaveValue(new URL(`/games/${game.id}`, window.location.origin).toString());
    expect(link).toHaveAttribute('readonly');
    expect(screen.queryByText('Ссылка на игру скопирована')).toBeNull();
  });

  it('does not copy or report success after the native share menu is cancelled', async () => {
    const user = userEvent.setup();
    const share = vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderInviteCard();
    await user.click(screen.getByRole('button', { name: 'Пригласить в игру' }));
    expect(share).toHaveBeenCalledOnce();
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('falls back to copying when native sharing fails for a non-cancellation reason', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: vi.fn().mockRejectedValue(new Error('Unavailable')),
    });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderInviteCard();
    await user.click(screen.getByRole('button', { name: 'Пригласить в игру' }));
    expect(writeText).toHaveBeenCalledOnce();
    expect(await screen.findByRole('status')).toHaveTextContent('Ссылка на игру скопирована');
  });

  it('prevents duplicate share requests while the share menu is open', async () => {
    const user = userEvent.setup();
    let finish: (() => void) | undefined;
    const pendingShare = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const share = vi.fn().mockReturnValue(pendingShare);
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    renderInviteCard();
    const invite = screen.getByRole('button', { name: 'Пригласить в игру' });
    await user.click(invite);
    expect(invite).toBeDisabled();
    await user.click(invite);
    expect(share).toHaveBeenCalledOnce();
    await act(async () => {
      finish?.();
      await pendingShare;
    });
    expect(invite).toBeEnabled();
  });

  it('disables invitations while the game is busy', async () => {
    const user = userEvent.setup();
    const share = vi.fn();
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    renderInviteCard({}, true);
    const invite = screen.getByRole('button', { name: 'Пригласить в игру' });
    expect(invite).toBeDisabled();
    await user.click(invite);
    expect(share).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'private game', overrides: { visibility: 'PRIVATE' } },
    { name: 'full game', overrides: { capacity: game.capacity, participants: game.participants } },
    { name: 'locked roster', overrides: { rosterState: 'LOCKED' } },
    { name: 'cancelled game', overrides: { displayState: 'CANCELLED' } },
    { name: 'completed game', overrides: { displayState: 'COMPLETED' } },
  ] satisfies { name: string; overrides: Partial<GameCard> }[])(
    'hides public invitations for $name',
    ({ overrides }) => {
      renderInviteCard(overrides);
      expect(screen.queryByRole('button', { name: 'Пригласить в игру' })).toBeNull();
    },
  );

  it('keeps invitations available for the last open place', () => {
    renderInviteCard({
      displayState: 'ONE_SPOT_LEFT',
      rosterState: 'LAST_SPOT',
      capacity: { ...game.capacity, occupied: 3, open: 1 },
      participants: game.participants.slice(0, 3),
    });
    expect(screen.getByRole('button', { name: 'Пригласить в игру' })).toBeEnabled();
  });

  it('shares the configured public Web origin instead of the Android WebView origin', async () => {
    const user = userEvent.setup();
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    render(
      <GameDetailView
        activeTab="GAME"
        busy={false}
        game={recruitingGame}
        publicGameOrigin="https://lk2.padlhub.su"
        readOnly
        onAction={vi.fn()}
        onChatOpen={vi.fn()}
        onSubmit={vi.fn()}
        onTabChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Пригласить в игру' }));
    expect(share).toHaveBeenCalledExactlyOnceWith({
      title: game.title,
      url: `https://lk2.padlhub.su/games/${game.id}`,
    });
  });

  it('does not share the local Android origin when the public origin is unavailable', async () => {
    const user = userEvent.setup();
    const share = vi.fn();
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    render(
      <GameDetailView
        activeTab="GAME"
        busy={false}
        game={recruitingGame}
        publicGameOrigin={null}
        readOnly
        onAction={vi.fn()}
        onChatOpen={vi.fn()}
        onSubmit={vi.fn()}
        onTabChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Пригласить в игру' }));
    expect(share).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Ссылка на игру пока недоступна');
  });

  it.each(['SUBMIT_RESULT', 'CONFIRM_RESULT', 'DISPUTE_RESULT'] as const)(
    'does not expose unsupported %s writes in the native read-only result',
    (action) => {
      render(
        <GameDetailView
          activeTab="RESULT"
          busy={false}
          game={{ ...game, allowedActions: [action] }}
          readOnly
          onAction={vi.fn()}
          onChatOpen={vi.fn()}
          onSubmit={vi.fn()}
          onTabChange={vi.fn()}
        />,
      );
      expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'game-detail-panel-result');
      expect(screen.queryByRole('heading', { name: 'Пары и счёт по сетам' })).toBeNull();
      expect(screen.queryByRole('button', { name: /Подтвердить|Оспорить|Отправить/ })).toBeNull();
    },
  );

  it('keeps presentation without duplicate Web participation/chat controls in native mode', () => {
    render(
      <GameDetailView
        activeTab="GAME"
        busy={false}
        game={{
          ...recruitingGame,
          viewerRelation: 'PARTICIPANT',
          participants: game.participants.slice(0, 2),
          allowedActions: ['JOIN', 'LEAVE', 'OPEN_CHAT'],
        }}
        viewerUserId={PLAYERS[1][0]}
        readOnly
        onAction={vi.fn()}
        onChatOpen={vi.fn()}
        onSubmit={vi.fn()}
        onTabChange={vi.fn()}
      />,
    );
    const panel = screen.getByRole('region', { name: 'Участники игры' });
    expect(within(panel).getByText('Организатор')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Стартовый состав' })).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /Покинуть игру|Вступить в игру|Открыть чат игры/ }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: /Слоты пары/ })).toBeNull();
  });
});
