// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { BookingRecommendationPage } from './auth-gateway.js';
import { BookingRecommendations } from './BookingRecommendations.js';

afterEach(cleanup);

type RecommendationGame = Extract<
  BookingRecommendationPage['items'][number],
  { kind: 'GAME' }
>['game'];

function recommendationGame(overrides: Partial<RecommendationGame> = {}): RecommendationGame {
  return {
    id: '70000000-0000-4000-8000-000000000001',
    revision: 1,
    surface: 'DISCOVER',
    displayState: 'FINDING_PLAYERS',
    title: 'Открытая игра',
    kind: 'RATING',
    visibility: 'PUBLIC',
    startsAt: '2026-08-29T15:00:00.000Z',
    endsAt: '2026-08-29T16:30:00.000Z',
    timezone: 'Europe/Moscow',
    station: {
      id: '60000000-0000-4000-8000-000000000001',
      name: 'Сколково',
    },
    court: {
      id: '61000000-0000-4000-8000-000000000001',
      name: 'Корт №6',
    },
    levelRange: { from: 'D+', to: 'C' },
    rosterState: 'OPEN',
    capacity: { total: 4, occupied: 1, reserved: 0, open: 3, waitlistCount: 0 },
    participants: [
      {
        userId: '80000000-0000-4000-8000-000000000001',
        displayName: 'Анна Петрова',
        avatarUrl: null,
        level: 'D+',
        role: 'ORGANIZER',
      },
    ],
    priceSummary: { amountMinor: 80_000, currency: 'RUB' },
    viewerRelation: 'NONE',
    viewerPaymentState: 'NOT_REQUIRED',
    badges: [],
    allowedActions: ['OPEN_DETAILS', 'JOIN'],
    deepLink: '/games/70000000-0000-4000-8000-000000000001',
    resultSummary: null,
    conversation: null,
    ...overrides,
  };
}

function recommendationPage(items: BookingRecommendationPage['items']): BookingRecommendationPage {
  return {
    version: 'a'.repeat(64),
    generatedAt: '2026-08-26T09:00:00.000Z',
    staleAt: '2026-08-26T09:05:00.000Z',
    personalization: 'LEARNED',
    items,
    nextCursor: null,
  };
}

describe('Home V3 recommendation photo grid', () => {
  it('renders a paid game from the existing model without recommendation badges', () => {
    const game = recommendationGame();
    const { container } = render(
      <BookingRecommendations
        compact
        compactVisualVariant="photo-grid"
        page={recommendationPage([
          { kind: 'GAME', game, reasons: ['PLAYED_STATION', 'LEVEL_MATCH'] },
        ])}
      />,
    );

    expect(container.querySelector('.booking-recommendations')).toHaveClass('is-photo-grid');
    const section = container.querySelector('.booking-recommendation');
    expect(section).toHaveClass('is-photo-grid-card');
    expect(section).not.toHaveAttribute('style');
    const card = within(section as HTMLElement);
    expect(card.getByText('Игра')).toBeInTheDocument();
    expect(card.getByText('18:00–19:30')).toBeInTheDocument();
    expect(card.getByRole('link', { name: 'Открытая игра' })).toHaveAttribute(
      'href',
      `/games/${game.id}`,
    );
    expect(card.getByText('Сколково · Корт №6')).toBeInTheDocument();
    expect(card.getByText('D+–C')).toBeInTheDocument();
    expect(card.getByText('1 из 4 мест')).toBeInTheDocument();
    expect(card.getByRole('link', { name: /Вступить · 800\s₽/ })).toHaveAttribute(
      'href',
      `/games/${game.id}`,
    );
    expect(card.getByRole('link', { name: `Открыть: ${game.title}` })).toHaveAttribute(
      'href',
      `/games/${game.id}`,
    );
    expect(card.getByRole('img', { name: /Анна Петрова/ })).toBeInTheDocument();
    expect(section?.querySelector('.recommendation-grid-card__hero img')).toHaveAttribute(
      'src',
      expect.stringMatching(/game-hero\.webp$/),
    );
    expect(section?.querySelector('.recommendation-grid-card__hero img')).toHaveAttribute(
      'alt',
      '',
    );
    expect(card.queryByLabelText('Почему игра подходит')).not.toBeInTheDocument();
    expect(card.queryByText('Часто играете здесь')).not.toBeInTheDocument();
    expect(card.queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps long content bounded with the maximum participant list', () => {
    const participants = Array.from({ length: 4 }, (_value, index) => ({
      userId: `80000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      displayName: `Игрок ${index + 1}`,
      avatarUrl: null,
      level: 'D+' as const,
      role: index === 0 ? ('ORGANIZER' as const) : ('PLAYER' as const),
    }));
    const game = recommendationGame({
      title: 'Очень длинное название открытой игры для всех желающих',
      station: {
        id: '60000000-0000-4000-8000-000000000001',
        name: 'Очень длинное название падел-клуба в Сколково',
      },
      court: null,
      capacity: { total: 4, occupied: 3, reserved: 0, open: 1, waitlistCount: 0 },
      participants,
      priceSummary: { amountMinor: 0, currency: 'RUB' },
    });

    const { container } = render(
      <BookingRecommendations
        compact
        compactVisualVariant="photo-grid"
        page={recommendationPage([{ kind: 'GAME', game, reasons: [] }])}
      />,
    );
    const card = container.querySelector('.recommendation-grid-card') as HTMLElement;

    expect(within(card).getByRole('link', { name: game.title })).toHaveClass(
      'recommendation-grid-card__title',
    );
    expect(within(card).getByText(game.station.name)).toHaveAttribute('title', game.station.name);
    expect(within(card).getAllByRole('img', { name: /\u0418грок/ })).toHaveLength(4);
    expect(within(card).getByText('Осталось 1 место')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Вступить · Бесплатно' })).toBeInTheDocument();
  });

  it('omits unavailable level, trainer and recommendation data from a training card', () => {
    const page = recommendationPage([
      {
        kind: 'TRAINING',
        activity: {
          id: '50000000-0000-4000-8000-000000000001',
          kind: 'TRAINING',
          title: 'Утренняя тренировка',
          startsAt: '2026-08-30T08:00:00.000Z',
          endsAt: '2026-08-30T09:00:00.000Z',
          timezone: 'Europe/Moscow',
          station: {
            id: '60000000-0000-4000-8000-000000000002',
            name: 'Динамо',
            shortAddress: null,
          },
          court: null,
          levelRange: null,
          capacity: { total: 3, open: 2 },
          host: null,
          route: '/trainings?event=50000000-0000-4000-8000-000000000001',
        },
        reasons: [],
      },
    ]);
    const { container } = render(
      <BookingRecommendations compact compactVisualVariant="photo-grid" page={page} />,
    );
    const card = container.querySelector('.recommendation-grid-card') as HTMLElement;

    expect(within(card).getByText('Тренировка')).toBeInTheDocument();
    expect(within(card).getByText('1 из 3 мест')).toBeInTheDocument();
    expect(within(card).queryByText(/\u0422ренер/)).not.toBeInTheDocument();
    expect(within(card).queryByText(/\u0423ровень/)).not.toBeInTheDocument();
    expect(within(card).queryByLabelText('Участники события')).not.toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Записаться' })).toHaveAttribute(
      'href',
      page.items[0]?.kind === 'TRAINING' ? page.items[0].activity.route : '',
    );
    expect(card.querySelector('.recommendation-grid-card__hero img')).toHaveAttribute(
      'src',
      expect.stringMatching(/training-hero\.webp$/),
    );
  });

  it('keeps sold-out tournament details reachable while disabling the CTA', () => {
    const route = '/tournaments?event=50000000-0000-4000-8000-000000000002';
    const { container } = render(
      <BookingRecommendations
        compact
        compactVisualVariant="photo-grid"
        page={recommendationPage([
          {
            kind: 'TOURNAMENT',
            activity: {
              id: '50000000-0000-4000-8000-000000000002',
              kind: 'TOURNAMENT',
              title: 'Вечерний турнир',
              startsAt: '2026-08-31T17:00:00.000Z',
              endsAt: '2026-08-31T19:00:00.000Z',
              timezone: 'Europe/Moscow',
              station: {
                id: '60000000-0000-4000-8000-000000000003',
                name: 'Терехово',
                shortAddress: null,
              },
              levelRange: { from: 'D', to: 'D+' },
              capacity: { total: 16, open: 0 },
              host: {
                displayName: 'Илья Соколов',
                avatarUrl: null,
                role: 'ORGANIZER',
              },
              route,
            },
            reasons: ['AVAILABLE_SOON'],
          },
        ])}
      />,
    );
    const card = container.querySelector('.recommendation-grid-card') as HTMLElement;

    expect(
      within(card).getByText('Мест нет', { selector: '.recommendation-grid-card__social > span' }),
    ).toBeInTheDocument();
    expect(
      within(card).getByText('Мест нет', { selector: '.recommendation-grid-card__action' }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(within(card).queryByRole('link', { name: 'Мест нет' })).not.toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Вечерний турнир' })).toHaveAttribute(
      'href',
      route,
    );
    expect(within(card).queryByLabelText('Участники события')).not.toBeInTheDocument();
    expect(card.querySelector('.recommendation-grid-card__hero img')).toHaveAttribute(
      'src',
      expect.stringMatching(/tournament-hero\.webp$/),
    );
  });
});
