// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GameCard } from './GameCard.js';
import type { GameCard as ViewerGameCard, PublicGameCard } from './auth-gateway.js';
import {
  gameHistoryPrimaryAction,
  gameHistoryStateLabel,
  gamePrimaryAction,
  gameStateLabel,
} from './game-card-policy.js';

const publicGame: PublicGameCard = {
  id: '751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
  revision: 4,
  surface: 'DISCOVER',
  displayState: 'FINDING_PLAYERS',
  title: 'Френдли на Селигерской',
  kind: 'FRIENDLY',
  visibility: 'PUBLIC',
  startsAt: '2026-07-20T15:00:00.000Z',
  endsAt: '2026-07-20T16:00:00.000Z',
  timezone: 'Europe/Moscow',
  station: { id: 'a8df730b-6a67-41a5-8772-48bca84f73bc', name: 'Селигерская' },
  court: { id: 'ba9c4d82-cc20-4d0f-9eb0-16ad23d54cbd', name: 'Корт №3' },
  levelRange: { from: 'D+', to: 'C' },
  rosterState: 'OPEN',
  capacity: { total: 4, occupied: 2, reserved: 0, open: 2, waitlistCount: 0 },
  participants: [
    { displayName: 'Анна Петрова', avatarUrl: null, level: 'C', role: 'ORGANIZER' },
    { displayName: 'Максим Иванов', avatarUrl: null, level: 'D+', role: 'PLAYER' },
  ],
  priceSummary: { amountMinor: 230000, currency: 'RUB' },
  viewerRelation: 'ANONYMOUS',
  viewerPaymentState: 'NOT_REQUIRED',
  badges: [],
  allowedActions: ['OPEN_DETAILS', 'JOIN'],
  deepLink: '/games/751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
};

function viewerHistoryGame(
  overrides: Pick<ViewerGameCard, 'displayState' | 'resultSummary' | 'allowedActions'>,
): ViewerGameCard {
  return {
    ...publicGame,
    surface: 'HISTORY',
    levelRange: publicGame.levelRange ?? null,
    capacity: { ...publicGame.capacity, total: 4 },
    priceSummary: publicGame.priceSummary ?? null,
    participants: publicGame.participants.map((participant, index) => ({
      ...participant,
      userId:
        index === 0
          ? 'bd7574a5-0f0b-4be9-a17e-e124814f911c'
          : '8c70d632-d6ac-4b4b-9cf7-b8f71a5b9a43',
    })),
    viewerRelation: 'PARTICIPANT',
    conversation: null,
    ...overrides,
  };
}

afterEach(() => cleanup());

describe('GameCard lifecycle template', () => {
  it('renders one reusable discovery card with state, seats and primary action', () => {
    render(<GameCard game={publicGame} />);

    expect(screen.getByRole('article')).toHaveAttribute('data-display-state', 'FINDING_PLAYERS');
    expect(screen.queryByText('Ищем игроков')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Вступить в игру' })).toHaveAttribute(
      'href',
      `/games/${publicGame.id}`,
    );
    expect(screen.getAllByLabelText('Свободное место')).toHaveLength(2);
    const participantStack = screen.getByLabelText('Участники игры');
    expect(participantStack).toHaveClass('participant-avatar-stack');
    expect(within(participantStack).getAllByRole('img')).toHaveLength(2);
    expect(within(participantStack).getAllByRole('img')[0]).toHaveAttribute(
      'data-player-level-avatar',
    );
    expect(screen.getByText('Селигерская · Корт №3')).toBeInTheDocument();
    expect(screen.getByText(/2.*300/)).toBeInTheDocument();
  });

  it('requests an authenticated profile lookup when a discovery avatar is pressed', () => {
    const onParticipantProfileRequest = vi.fn();
    render(
      <GameCard game={publicGame} onParticipantProfileRequest={onParticipantProfileRequest} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Открыть профиль Анна Петрова' }));

    expect(onParticipantProfileRequest).toHaveBeenCalledWith(
      publicGame,
      publicGame.participants[0],
      0,
    );
  });

  it('uses the Home badge and metadata icons and hides status above the primary action', () => {
    render(
      <GameCard
        game={{
          ...publicGame,
          kind: 'RATING',
          displayState: 'ONE_SPOT_LEFT',
        }}
      />,
    );

    const card = screen.getByRole('article');
    const badge = within(card).getByText('Игра на рейтинг').closest('.fh-event__tag');
    expect(badge).toHaveClass('is-rating');
    expect(badge?.querySelector('svg')).toBeInTheDocument();
    expect(within(card).queryByText('⚡')).not.toBeInTheDocument();
    expect(card.querySelector('.game-card__date svg')).toBeInTheDocument();
    expect(
      card.querySelectorAll('.game-card__meta > .activity-card-metadata-row svg'),
    ).toHaveLength(2);
    expect(card.querySelector('.game-card__level svg')).toBeInTheDocument();
    expect(within(card).queryByText('Осталось одно место')).not.toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Вступить в игру' })).toBeInTheDocument();
  });

  it('keeps the lifecycle status when no primary action is available', () => {
    render(<GameCard game={{ ...publicGame, allowedActions: ['OPEN_DETAILS'] }} />);

    expect(screen.getByText('Ищем игроков')).toBeInTheDocument();
  });

  it('maps every server display state to explicit product copy', () => {
    expect(gameStateLabel('ONE_SPOT_LEFT')).toBe('Осталось одно место');
    expect(gameStateLabel('ROSTER_READY')).toBe('Состав набран');
    expect(gameStateLabel('RESULT_REQUIRED')).toBe('Внесите счёт');
    expect(gameStateLabel('RESULT_PENDING')).toBe('Ожидание результата');
    expect(gameStateLabel('RESULT_DISPUTED')).toBe('Результат оспаривается');
    expect(gameStateLabel('COMPLETED')).toBe('Игра завершена');
    expect(gameStateLabel('CANCELLED')).toBe('Игра отменена');
  });

  it('uses the four result presentations required by compact history cards', () => {
    const historyGame = viewerHistoryGame({
      displayState: 'RESULT_PENDING',
      resultSummary: { state: 'PENDING_CONFIRMATION', sets: [{ teamA: 6, teamB: 4 }] },
      allowedActions: ['OPEN_DETAILS', 'CONFIRM_RESULT', 'DISPUTE_RESULT'],
    });

    expect(gameHistoryPrimaryAction(historyGame)).toBe('DISPUTE_RESULT');
    expect(gameHistoryStateLabel(historyGame)).toBe('Ожидание результата');
    expect(
      gameHistoryPrimaryAction({
        ...historyGame,
        displayState: 'RESULT_REQUIRED',
        resultSummary: { state: 'AWAITING_SUBMISSION' },
        allowedActions: ['OPEN_DETAILS', 'SUBMIT_RESULT'],
      }),
    ).toBe('SUBMIT_RESULT');
    expect(
      gameHistoryStateLabel({
        ...historyGame,
        displayState: 'RESULT_DISPUTED',
        resultSummary: { state: 'DISPUTED', sets: [{ teamA: 6, teamB: 4 }] },
        allowedActions: ['OPEN_DETAILS', 'OPEN_DISPUTE'],
      }),
    ).toBe('Результат оспаривается');
    expect(
      gameHistoryStateLabel({
        ...historyGame,
        displayState: 'COMPLETED',
        resultSummary: { state: 'CONFIRMED', sets: [{ teamA: 6, teamB: 4 }] },
        allowedActions: ['OPEN_DETAILS', 'VIEW_RESULT'],
      }),
    ).toBe('Результат внесён');
    expect(
      gameHistoryStateLabel({
        ...historyGame,
        displayState: 'COMPLETED',
        resultSummary: { state: 'AWAITING_SUBMISSION' },
        allowedActions: ['OPEN_DETAILS'],
      }),
    ).toBe('Игра завершена');
  });

  it('renders a compact history action without the generic state or details fallback', () => {
    render(
      <GameCard
        compact
        game={viewerHistoryGame({
          displayState: 'RESULT_PENDING',
          resultSummary: {
            state: 'PENDING_CONFIRMATION',
            sets: [{ teamA: 6, teamB: 4 }],
          },
          allowedActions: ['OPEN_DETAILS', 'CONFIRM_RESULT', 'DISPUTE_RESULT'],
        })}
      />,
    );

    expect(screen.getByRole('link', { name: 'Оспорить результат' })).toHaveAttribute(
      'href',
      `/games/${publicGame.id}`,
    );
    expect(screen.getAllByRole('link', { name: publicGame.title }).at(-1)).toHaveClass(
      'activity-card-title',
    );
    const card = screen.getAllByRole('article').at(-1)!;
    expect(within(card).getByLabelText('Дата игры: пн, 20 июля')).toHaveTextContent('20пн');
    expect(within(card).getByText('Селигерская · 18:00')).toHaveClass('game-card__history-meta');
    expect(card.querySelector('.game-card__meta')).not.toBeInTheDocument();
    expect(within(card).queryByText('Ожидание результата')).not.toBeInTheDocument();
    expect(within(card).queryByRole('link', { name: 'Подробнее' })).not.toBeInTheDocument();
  });

  it('uses the Home badge and the detailed result table in compact history', () => {
    const playerIds = [
      'bd7574a5-0f0b-4be9-a17e-e124814f911c',
      '8c70d632-d6ac-4b4b-9cf7-b8f71a5b9a43',
      '310957c6-1d83-438c-b094-5b1f50db5729',
      'b7f081db-f92e-4ec1-bf70-0f44a5966e8d',
    ];
    const historyGame = viewerHistoryGame({
      displayState: 'COMPLETED',
      resultSummary: {
        state: 'CONFIRMED',
        sets: [
          {
            setNumber: 1,
            teamAUserIds: [playerIds[0]!, playerIds[1]!],
            teamBUserIds: [playerIds[2]!, playerIds[3]!],
            teamA: 6,
            teamB: 4,
          },
        ],
      },
      allowedActions: ['OPEN_DETAILS', 'VIEW_RESULT'],
    });

    render(
      <GameCard
        compact
        game={{
          ...historyGame,
          kind: 'RATING',
          participants: playerIds.map((userId, index) => ({
            userId,
            displayName: `Игрок ${index + 1}`,
            avatarUrl: null,
            level: 'C',
            role: index === 0 ? ('ORGANIZER' as const) : ('PLAYER' as const),
          })),
        }}
      />,
    );

    const card = screen.getAllByRole('article').at(-1)!;
    const badge = within(card).getByText('Игра на рейтинг').closest('.fh-event__tag');
    expect(badge).toHaveClass('is-rating');
    expect(badge?.querySelector('svg')).toBeInTheDocument();
    expect(within(card).queryByText('⚡')).not.toBeInTheDocument();
    expect(within(card).getByLabelText('Дата игры: пн, 20 июля')).toHaveTextContent('20пн');
    expect(card.querySelector('.game-card__meta')).not.toBeInTheDocument();
    expect(within(card).getByRole('table', { name: 'Счёт по сетам' })).toBeInTheDocument();
    expect(within(card).getAllByRole('row')).toHaveLength(2);
    expect(within(card).queryByLabelText('Участники игры')).not.toBeInTheDocument();
    expect(card.querySelector('.game-score')).not.toBeInTheDocument();
    expect(card.querySelector('.game-card__footer')).not.toBeInTheDocument();
    expect(within(card).queryByText('Результат внесён')).not.toBeInTheDocument();
  });

  it('derives the visible action only from server allowedActions', () => {
    expect(gamePrimaryAction(publicGame)).toBe('JOIN');
    expect(gamePrimaryAction({ ...publicGame, allowedActions: ['OPEN_DETAILS'] })).toBeUndefined();
    expect(
      gamePrimaryAction({ ...publicGame, allowedActions: ['OPEN_DETAILS', 'JOIN_WAITLIST'] }),
    ).toBe('JOIN_WAITLIST');
  });

  it('fails closed for an action that needs a separate server workflow', () => {
    render(
      <GameCard
        game={{
          ...publicGame,
          surface: 'MY_UPCOMING',
          displayState: 'SEAT_PAYMENT_REQUIRED',
          levelRange: publicGame.levelRange ?? null,
          capacity: { ...publicGame.capacity, total: 4 },
          priceSummary: publicGame.priceSummary ?? null,
          participants: publicGame.participants.map((participant, index) => ({
            ...participant,
            userId:
              index === 0
                ? 'bd7574a5-0f0b-4be9-a17e-e124814f911c'
                : '8c70d632-d6ac-4b4b-9cf7-b8f71a5b9a43',
          })),
          viewerRelation: 'SEAT_RESERVED',
          viewerPaymentState: 'REQUIRES_ACTION',
          resultSummary: null,
          allowedActions: ['OPEN_DETAILS', 'PAY'],
          conversation: null,
        }}
        onAction={() => undefined}
        unsupportedActionBehavior="DISABLED"
      />,
    );

    expect(screen.getByRole('button', { name: 'Оплатить место' })).toBeDisabled();
  });

  it('links a viewer-visible player avatar to the protected PadlHub profile', () => {
    const participantId = 'bd7574a5-0f0b-4be9-a17e-e124814f911c';
    render(
      <GameCard
        game={{
          ...publicGame,
          participants: publicGame.participants.map((participant, index) => ({
            ...participant,
            ...(index === 0 ? { userId: participantId } : {}),
          })),
        }}
      />,
    );

    expect(screen.getAllByRole('link', { name: 'Анна Петрова · C' }).at(-1)).toHaveAttribute(
      'href',
      `/profile/${participantId}`,
    );
  });
});
