// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActivityHistoryModal, ActivityHistoryPanel } from './ActivityHistory.js';
import type { ActivityHistoryItem, ActivityHistoryPage } from './auth-gateway.js';

const generatedAt = '2026-07-21T09:00:00.000Z';

const game = {
  id: '751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
  revision: 4,
  surface: 'MY_HISTORY',
  displayState: 'COMPLETED',
  title: 'Френдли на Селигерской',
  kind: 'FRIENDLY',
  visibility: 'PUBLIC',
  startsAt: '2026-07-20T15:00:00.000Z',
  endsAt: '2026-07-20T16:00:00.000Z',
  timezone: 'Europe/Moscow',
  station: { id: 'a8df730b-6a67-41a5-8772-48bca84f73bc', name: 'Селигерская' },
  levelRange: null,
  rosterState: 'CLOSED',
  capacity: { total: 4, occupied: 4, reserved: 0, open: 0, waitlistCount: 0 },
  participants: [],
  priceSummary: null,
  viewerRelation: 'PLAYER',
  viewerPaymentState: 'PAID',
  resultSummary: { state: 'CONFIRMED', sets: [{ teamA: 6, teamB: 4 }] },
  conversation: null,
  badges: [],
  allowedActions: ['OPEN_DETAILS', 'VIEW_RESULT'],
  deepLink: '/games/751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
} as unknown as NonNullable<ActivityHistoryItem['game']>;

const items: ActivityHistoryItem[] = [
  {
    id: 'history-game',
    kind: 'GAME',
    status: 'COMPLETED',
    title: game.title,
    occurredAt: game.endsAt,
    startsAt: game.startsAt,
    endsAt: game.endsAt,
    venue: 'Селигерская',
    route: game.deepLink,
    game,
  },
  {
    id: 'history-training',
    kind: 'TRAINING',
    status: 'COMPLETED',
    title: 'Групповая тренировка',
    occurredAt: '2026-07-19T17:00:00.000Z',
    startsAt: '2026-07-19T16:00:00.000Z',
    endsAt: '2026-07-19T17:00:00.000Z',
    venue: 'Терехово',
    trainerName: 'Иван Смирнов',
  },
  {
    id: 'history-tournament',
    kind: 'TOURNAMENT',
    status: 'COMPLETED',
    title: 'Americano C',
    occurredAt: '2026-07-18T20:00:00.000Z',
    startsAt: '2026-07-18T17:00:00.000Z',
    endsAt: '2026-07-18T20:00:00.000Z',
    venue: 'Нагатинская',
    result: '3 место',
  },
];

function page(
  pageItems: ActivityHistoryItem[],
  nextCursor: string | null = null,
): ActivityHistoryPage {
  return {
    items: pageItems,
    nextCursor,
    freshness: 'FRESH',
    coverage: nextCursor ? 'PARTIAL' : 'COMPLETE',
    generatedAt,
  };
}

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
  vi.restoreAllMocks();
});

describe('ActivityHistoryPanel', () => {
  it('starts its initial request under React StrictMode', async () => {
    const loadHistory = vi.fn().mockResolvedValue(page([]));
    render(
      <StrictMode>
        <ActivityHistoryPanel active loadHistory={loadHistory} />
      </StrictMode>,
    );

    expect(await screen.findByText('История пока пуста')).toBeVisible();
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it('loads provider-neutral items, renders dedicated cards and applies filters', async () => {
    const loadHistory = vi.fn().mockResolvedValue(page(items, 'next-page'));
    render(<ActivityHistoryPanel active loadHistory={loadHistory} />);

    expect(await screen.findByText('Групповая тренировка')).toBeVisible();
    expect(screen.getByText('Иван Смирнов')).toBeVisible();
    expect(screen.getByLabelText('Счёт по сетам')).toBeInTheDocument();
    expect(screen.queryByText('Результат внесён')).not.toBeInTheDocument();
    expect(loadHistory).toHaveBeenCalledWith({ status: 'COMPLETED', limit: 20 });

    fireEvent.click(screen.getByRole('button', { name: 'Тренировки' }));
    await vi.waitFor(() =>
      expect(loadHistory).toHaveBeenLastCalledWith({
        kind: 'TRAINING',
        status: 'COMPLETED',
        limit: 20,
      }),
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Отменённые' }));
    await vi.waitFor(() =>
      expect(loadHistory).toHaveBeenLastCalledWith({
        kind: 'TRAINING',
        status: 'CANCELLED',
        limit: 20,
      }),
    );
  });

  it('hides the duplicate subtitle on a generic game card', async () => {
    const duplicateSubtitle = 'Корт №1 тест панорамик · г Москва, ул Складочная';
    const genericGame: ActivityHistoryItem = {
      id: 'generic-game',
      kind: 'GAME',
      status: 'COMPLETED',
      title: 'Открытая игра',
      subtitle: duplicateSubtitle,
      occurredAt: '2026-07-23T07:00:00.000Z',
      startsAt: '2026-07-23T06:00:00.000Z',
      endsAt: '2026-07-23T07:00:00.000Z',
      venue: 'Тестовая станция',
    };

    render(
      <ActivityHistoryPanel active loadHistory={vi.fn().mockResolvedValue(page([genericGame]))} />,
    );

    expect(await screen.findByText('Открытая игра')).toBeVisible();
    expect(screen.queryByText(duplicateSubtitle)).not.toBeInTheDocument();
    expect(screen.getByText('Тестовая станция')).toBeVisible();
  });

  it('shows the tournament name without its court and address subtitle', async () => {
    const courtAndAddress = 'Корт №1 · г Москва, ул Нижние Мнёвники, д 12а';
    const tournament: ActivityHistoryItem = {
      id: 'history-tournament-with-address',
      kind: 'TOURNAMENT',
      status: 'COMPLETED',
      title: 'Американо D+ в Терехово',
      subtitle: courtAndAddress,
      occurredAt: '2026-08-04T07:00:00.000Z',
      startsAt: '2026-08-04T05:30:00.000Z',
      endsAt: '2026-08-04T07:00:00.000Z',
      venue: 'Терехово',
    };

    render(
      <ActivityHistoryPanel active loadHistory={vi.fn().mockResolvedValue(page([tournament]))} />,
    );

    expect(await screen.findByRole('heading', { name: tournament.title })).toBeVisible();
    expect(screen.queryByText(courtAndAddress)).not.toBeInTheDocument();
    expect(document.querySelector('.tournament-history-card__copy > p')).toHaveTextContent(
      'Терехово • 04 августа • 08:30–10:00',
    );
  });

  it('shows the tournament podium and a separate viewer block only outside the top three', async () => {
    const tournamentResult: NonNullable<ActivityHistoryItem['tournamentResult']> = {
      status: 'CONFIRMED',
      podium: [
        { profileId: null, displayName: 'Иван Петров', avatarUrl: null, place: 1 },
        { profileId: null, displayName: 'Артём Сидоров', avatarUrl: null, place: 2 },
        { profileId: null, displayName: 'Максим Орлов', avatarUrl: null, place: 3 },
      ],
      viewer: { profileId: null, displayName: 'Алексей Иванов', avatarUrl: null, place: 5 },
    };
    const tournament: ActivityHistoryItem = {
      id: 'history-tournament-result',
      kind: 'TOURNAMENT',
      status: 'COMPLETED',
      title: 'Время на друзей',
      occurredAt: '2026-08-04T07:00:00.000Z',
      startsAt: '2026-08-04T05:30:00.000Z',
      endsAt: '2026-08-04T07:00:00.000Z',
      venue: 'Терехово',
      tournamentResult,
    };

    render(
      <ActivityHistoryPanel active loadHistory={vi.fn().mockResolvedValue(page([tournament]))} />,
    );

    expect(await screen.findByRole('list', { name: 'Призовые места' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Итоги' })).not.toBeInTheDocument();
    expect(document.querySelector('.tournament-history-card__podium .is-place-1')).toBeVisible();
    expect(document.querySelector('.tournament-history-card__podium .is-place-2')).toBeVisible();
    expect(document.querySelector('.tournament-history-card__podium .is-place-3')).toBeVisible();
    expect(screen.queryByText('1 место')).not.toBeInTheDocument();
    expect(screen.queryByText('2 место')).not.toBeInTheDocument();
    expect(screen.queryByText('3 место')).not.toBeInTheDocument();
    expect(
      document.querySelector('.tournament-history-card__podium [data-size="58"]'),
    ).toBeInTheDocument();
    expect(
      document.querySelectorAll('.tournament-history-card__podium [data-size="50"]'),
    ).toHaveLength(2);
    expect(screen.getByText('Алексей — 5 место')).toBeVisible();
    expect(screen.getByText('Ваш результат')).toBeVisible();
    expect(screen.queryByText('Результаты подтверждены')).not.toBeInTheDocument();

    cleanup();
    const topThreeTournament: ActivityHistoryItem = {
      ...tournament,
      tournamentResult: {
        ...tournamentResult,
        viewer: tournamentResult.podium[1]!,
      },
    };
    render(
      <ActivityHistoryPanel
        active
        loadHistory={vi.fn().mockResolvedValue(page([topThreeTournament]))}
      />,
    );

    expect(await screen.findByRole('list', { name: 'Призовые места' })).toBeVisible();
    expect(screen.queryByText('Ваш результат')).not.toBeInTheDocument();
  });

  it('loads the next cursor and offers a retry without dropping the first page', async () => {
    const loadHistory = vi
      .fn()
      .mockResolvedValueOnce(page(items.slice(0, 1), 'next-page'))
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(page(items.slice(1)));
    render(<ActivityHistoryPanel active loadHistory={loadHistory} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('следующую страницу');
    expect(screen.getByText(game.title)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('Групповая тренировка')).toBeVisible();
    expect(loadHistory).toHaveBeenLastCalledWith({
      status: 'COMPLETED',
      cursor: 'next-page',
      limit: 20,
    });
  });
});

describe('ActivityHistoryModal', () => {
  it('opens over Home, locks scroll and closes with Escape while restoring focus', async () => {
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            История
          </button>
          <ActivityHistoryModal
            open={open}
            loadHistory={() => Promise.resolve(page([]))}
            onClose={() => setOpen(false)}
          />
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'История' });
    opener.focus();
    fireEvent.click(opener);

    expect(await screen.findByRole('dialog', { name: 'История' })).toBeVisible();
    expect(document.body.style.overflow).toBe('hidden');
    expect(screen.getByRole('button', { name: 'Закрыть историю' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
    expect(opener).toHaveFocus();
  });
});
