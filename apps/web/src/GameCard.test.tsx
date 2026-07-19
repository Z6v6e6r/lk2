// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { GameCard } from './GameCard.js';
import type { PublicGameCard } from './auth-gateway.js';
import { gamePrimaryAction, gameStateLabel } from './game-card-policy.js';

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

describe('GameCard lifecycle template', () => {
  it('renders one reusable discovery card with state, seats and primary action', () => {
    render(<GameCard game={publicGame} />);

    expect(screen.getByRole('article')).toHaveAttribute('data-display-state', 'FINDING_PLAYERS');
    expect(screen.getByText('Ищем игроков')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Вступить в игру' })).toHaveAttribute(
      'href',
      `/games/${publicGame.id}`,
    );
    expect(screen.getAllByLabelText('Свободное место')).toHaveLength(2);
    expect(screen.getByText(/2.*300/)).toBeInTheDocument();
  });

  it('maps every server display state to explicit product copy', () => {
    expect(gameStateLabel('ONE_SPOT_LEFT')).toBe('Осталось одно место');
    expect(gameStateLabel('ROSTER_READY')).toBe('Состав набран');
    expect(gameStateLabel('RESULT_REQUIRED')).toBe('Внесите счёт');
    expect(gameStateLabel('RESULT_PENDING')).toBe('Ожидание результата');
    expect(gameStateLabel('RESULT_DISPUTED')).toBe('Результат оспаривается');
    expect(gameStateLabel('COMPLETED')).toBe('Игра состоялась');
    expect(gameStateLabel('CANCELLED')).toBe('Игра отменена');
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
});
