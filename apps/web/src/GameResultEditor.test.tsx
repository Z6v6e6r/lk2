// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GameResultEditor } from './GameResultEditor.js';
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
  title: 'Игра',
  kind: 'RATING',
  visibility: 'PUBLIC',
  startsAt: '2026-07-22T08:00:00.000Z',
  endsAt: '2026-07-22T09:30:00.000Z',
  timezone: 'Europe/Moscow',
  station: { id: 'ee2eb9ac-fcb5-40d2-a714-97b9ef75a4a0', name: 'Селигерская' },
  court: null,
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
  allowedActions: ['OPEN_DETAILS', 'SUBMIT_RESULT'],
  deepLink: '/games/6fe9dc1f-87b5-4efd-83a2-5cf9d8070b76',
  conversation: null,
};

afterEach(() => cleanup());

describe('GameResultEditor', () => {
  it('derives the opposing pair and submits the complete set snapshot', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <GameResultEditor
        game={game}
        busy={false}
        initialPairings={[
          [PLAYERS[0][0], PLAYERS[1][0]],
          [PLAYERS[2][0], PLAYERS[3][0]],
        ]}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.queryByRole('combobox')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Управлять Борис' }));
    expect(
      screen.getByRole('dialog', { name: 'Управление участником · Пара A' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Поменять местами с Анна' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Поменять местами с Вера' }));
    expect(
      within(screen.getByLabelText('Сет 1 · Слоты пары 1')).getByRole('button', {
        name: 'Управлять Вера',
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText('Сет 1 · Слоты пары 2')).getByRole('button', {
        name: 'Управлять Борис',
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Отправить на согласование' }));

    expect(onSubmit).toHaveBeenCalledWith({
      sets: [
        {
          setNumber: 1,
          teamAUserIds: [PLAYERS[0][0], PLAYERS[2][0]],
          teamBUserIds: [PLAYERS[1][0], PLAYERS[3][0]],
          teamA: 6,
          teamB: 0,
        },
      ],
    });
  });

  it('copies the previous pairings into a new independently editable set', async () => {
    const user = userEvent.setup();
    render(
      <GameResultEditor
        game={game}
        busy={false}
        onCancel={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await user.click(screen.getByRole('button', { name: '+ Добавить сет' }));
    expect(
      within(screen.getByLabelText('Сет 2 · Слоты пары 1')).getByRole('button', {
        name: 'Управлять Анна',
      }),
    ).toBeInTheDocument();
    await user.click(
      within(screen.getByLabelText('Сет 2 · Слоты пары 1')).getByRole('button', {
        name: 'Управлять Анна',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Поменять местами с Глеб' }));

    expect(
      within(screen.getByLabelText('Сет 1 · Слоты пары 1')).getByRole('button', {
        name: 'Управлять Анна',
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText('Сет 2 · Слоты пары 1')).getByRole('button', {
        name: 'Управлять Глеб',
      }),
    ).toBeInTheDocument();
  });
});
