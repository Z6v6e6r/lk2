// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GameDetailView, type GameDetailTab } from './GameDetailView.js';
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

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('GameDetailView', () => {
  it('keeps the match overview and result entry in two explicit tabs', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [activeTab, setActiveTab] = useState<GameDetailTab>('GAME');
      return (
        <GameDetailView
          activeTab={activeTab}
          busy={false}
          game={game}
          onAction={vi.fn()}
          onSubmit={vi.fn().mockResolvedValue(undefined)}
          onTabChange={setActiveTab}
        />
      );
    }

    render(<Harness />);

    expect(screen.getByRole('tab', { name: 'Игра' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Вечерний матч' })).toBeInTheDocument();
    expect(screen.getByText('Игра на рейтинг')).toBeInTheDocument();
    expect(screen.queryByText(/Внести счёт/i)).toBeNull();
    expect(screen.getByRole('img', { name: 'Анна, уровень C, прогресс 42%' })).toBeInTheDocument();
    expect(screen.queryByText(/Уровень:/)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Участники игры' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Стартовый состав' })).toBeInTheDocument();
    expect(screen.queryByText('2 пары по 2 игрока')).toBeNull();
    expect(screen.queryByText('Выбирается по сетам')).toBeNull();
    expect(screen.queryByText(/Состав пар задаётся отдельно/i)).toBeNull();
    expect(screen.getByRole('link', { name: 'Чат игры' })).toHaveAttribute(
      'href',
      `/chats/${game.conversation?.conversationId}`,
    );
    expect(screen.queryByText('Чат игры')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Пары и счёт по сетам' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Слоты пары 1: свободное место 1' }));
    expect(screen.getByRole('dialog', { name: 'Выберите участника · Пара A' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Выбрать Анна' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      within(screen.getByLabelText('Слоты пары 1')).getByRole('img', {
        name: /Анна, уровень C/,
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Слоты пары 1: свободное место 1' }));
    expect(screen.queryByRole('button', { name: 'Выбрать Анна' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Выбрать Борис' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Закрыть выбор участника' }));

    await user.click(screen.getByRole('button', { name: 'Внести результат' }));

    expect(screen.getByRole('tab', { name: 'Результат' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Пары и счёт по сетам' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Отправить на согласование' })).toBeInTheDocument();
  });

  it('does not publish a chat entrypoint without both authorization and a conversation id', () => {
    const renderState = (overrides: Partial<GameCard>) => {
      const rendered = render(
        <GameDetailView
          activeTab="GAME"
          busy={false}
          game={{ ...game, ...overrides }}
          onAction={vi.fn()}
          onSubmit={vi.fn().mockResolvedValue(undefined)}
          onTabChange={vi.fn()}
        />,
      );
      expect(screen.queryByRole('link', { name: 'Чат игры' })).toBeNull();
      rendered.unmount();
    };

    renderState({ conversation: null });
    renderState({ allowedActions: game.allowedActions.filter((action) => action !== 'OPEN_CHAT') });
  });

  it('restores the lineup after remount and lets players be swapped or removed', async () => {
    const user = userEvent.setup();
    const renderGame = () =>
      render(
        <GameDetailView
          activeTab="GAME"
          busy={false}
          game={game}
          onAction={vi.fn()}
          onSubmit={vi.fn().mockResolvedValue(undefined)}
          onTabChange={vi.fn()}
        />,
      );

    renderGame();
    await user.click(screen.getByRole('button', { name: 'Слоты пары 1: свободное место 1' }));
    await user.click(screen.getByRole('button', { name: 'Выбрать Анна' }));
    await user.click(screen.getByRole('button', { name: 'Слоты пары 2: свободное место 1' }));
    await user.click(screen.getByRole('button', { name: 'Выбрать Борис' }));

    cleanup();
    renderGame();

    expect(
      within(screen.getByLabelText('Слоты пары 1')).getByRole('button', {
        name: 'Управлять Анна',
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText('Слоты пары 2')).getByRole('button', {
        name: 'Управлять Борис',
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Управлять Анна' }));
    expect(
      screen.getByRole('dialog', { name: 'Управление участником · Пара A' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Поменять местами с Борис' }));

    expect(
      within(screen.getByLabelText('Слоты пары 1')).getByRole('button', {
        name: 'Управлять Борис',
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText('Слоты пары 2')).getByRole('button', {
        name: 'Управлять Анна',
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Управлять Борис' }));
    await user.click(screen.getByRole('button', { name: 'Убрать Борис из состава' }));

    expect(
      within(screen.getByLabelText('Слоты пары 1')).getByRole('button', {
        name: 'Слоты пары 1: свободное место 1',
      }),
    ).toBeInTheDocument();
    expect(localStorage.length).toBe(1);
  });

  it('shows submitted sets and review actions in the result tab', async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    const pendingGame: GameCard = {
      ...game,
      revision: 9,
      displayState: 'RESULT_PENDING',
      resultSummary: {
        state: 'PENDING_CONFIRMATION',
        submissionId: '9befc171-241a-4419-a10d-8516555d8191',
        submittedByUserId: PLAYERS[0][0],
        submittedAt: '2026-07-22T07:39:58.313Z',
        confirmationQuorum: 1,
        sets: [
          {
            setNumber: 1,
            teamAUserIds: [PLAYERS[0][0], PLAYERS[1][0]],
            teamBUserIds: [PLAYERS[2][0], PLAYERS[3][0]],
            teamA: 6,
            teamB: 4,
          },
        ],
      },
      allowedActions: ['OPEN_DETAILS', 'CONFIRM_RESULT', 'DISPUTE_RESULT'],
    };

    render(
      <GameDetailView
        activeTab="RESULT"
        busy={false}
        game={pendingGame}
        onAction={onAction}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onTabChange={vi.fn()}
      />,
    );

    expect(screen.queryByText('Результат матча')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Счёт по сетам' })).toBeNull();
    expect(screen.getByText('На согласовании')).toHaveClass('fh-event__tag');
    expect(screen.getByLabelText('Анна, Борис: 6')).toHaveTextContent('АБАннаБорис6');
    expect(
      screen.getByLabelText('Анна, Борис: 6').querySelectorAll('[data-avatar-background]'),
    ).toHaveLength(2);
    expect(screen.getByText(':')).toHaveClass('game-detail-result__set-score-divider');
    const secondTeam = screen.getByLabelText('Вера, Глеб: 4');
    expect(secondTeam).toHaveClass('is-mirrored');
    expect(secondTeam.parentElement).toHaveClass('game-detail-result__teams');
    expect(screen.getByText('Отправитель результата:', { exact: false })).toHaveTextContent(
      'Отправитель результата: Анна · 22 июля в 10:39',
    );
    expect(screen.getByText('22 июля в 10:39')).toHaveAttribute(
      'datetime',
      '2026-07-22T07:39:58.313Z',
    );
    await user.click(screen.getByRole('button', { name: 'Подтвердить результат' }));
    expect(onAction).toHaveBeenCalledWith('CONFIRM_RESULT');
  });
});
