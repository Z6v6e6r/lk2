// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import coachGameBadgeUrl from './assets/recommendation-cards/coach-game-badge.svg';

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
  it('keeps the badge day and weekday in the event timezone across midnight', () => {
    const game = recommendationGame({
      startsAt: '2026-08-29T22:00:00.000Z',
      endsAt: '2026-08-29T23:00:00.000Z',
    });
    const { container } = render(
      <BookingRecommendations
        compact
        compactVisualVariant="photo-grid"
        page={recommendationPage([{ kind: 'GAME', game, reasons: [] }])}
      />,
    );
    const badge = container.querySelector('.recommendation-grid-card__hero time');
    expect(badge).toHaveAttribute('aria-label', 'Дата события: воскресенье, 30 августа');
    expect(badge?.querySelector('.recommendation-grid-card__day')).toHaveTextContent('30');
    expect(badge?.querySelector('.recommendation-grid-card__weekday')).toHaveTextContent('вс');
    expect(container.querySelector('.recommendation-grid-card__time')).toHaveTextContent(
      '30 авг, 01:00—02:00',
    );
    expect(container.querySelectorAll('.recommendation-grid-card__metadata img')).toHaveLength(3);
  });

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
    expect(card.getByText('Игра на рейтинг')).toBeInTheDocument();
    expect(card.getByText('18:00—19:30')).toBeInTheDocument();
    expect(card.getByRole('link', { name: 'Открытая игра' })).toHaveAttribute(
      'href',
      `/games/${game.id}`,
    );
    expect(card.getByText('Сколково · Корт №6')).toBeInTheDocument();
    expect(card.getByText('от D+ до C')).toBeInTheDocument();
    expect(card.getByText('1 из 4 мест')).toHaveClass('sr-only');
    expect(section?.querySelector('.recommendation-grid-card__action')).toBeNull();
    expect(section?.querySelector('.recommendation-grid-card__more')).toBeNull();
    expect(
      card.getAllByRole('link').filter((link) => link.getAttribute('href') === game.deepLink),
    ).toHaveLength(1);
    expect(card.getByRole('img', { name: /Анна Петрова/ })).toBeInTheDocument();
    expect(card.getAllByLabelText('Свободное место')).toHaveLength(3);
    expect(section?.querySelector('.recommendation-grid-card__hero img')).toHaveAttribute(
      'src',
      expect.stringMatching(/skolkovo\/game-\d\.webp$/),
    );
    expect(section?.querySelector('.recommendation-grid-card__hero img')).toHaveAttribute(
      'alt',
      '',
    );
    expect(card.queryByLabelText('Почему игра подходит')).not.toBeInTheDocument();
    expect(card.queryByText('Часто играете здесь')).not.toBeInTheDocument();
    expect(card.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the friendly badge, station address and level fallback from the game model', () => {
    const game = recommendationGame({
      kind: 'FRIENDLY',
      station: {
        id: '60000000-0000-4000-8000-000000000001',
        name: 'Селигерская',
        shortAddress: 'адрес',
      },
      levelRange: null,
    });
    const { container } = render(
      <BookingRecommendations
        compact
        compactVisualVariant="photo-grid"
        page={recommendationPage([{ kind: 'GAME', game, reasons: [] }])}
      />,
    );
    const card = within(container);
    expect(card.getByText('Френдли игра')).toBeInTheDocument();
    expect(card.getByText('Селигерская, адрес')).toBeInTheDocument();
    expect(card.getByText('Любой уровень')).toBeInTheDocument();
    expect(
      container.querySelector(
        '.recommendation-grid-card__footer .recommendation-grid-card__action',
      ),
    ).toBeNull();
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
    expect(within(card).getByText('Осталось 1 место')).toHaveClass('sr-only');
    expect(within(card).queryByLabelText('Свободное место')).not.toBeInTheDocument();
  });

  it('uses the supplied coach-game badge for coach games', () => {
    const game = recommendationGame({ kind: 'COACH_GAME' });
    const { container } = render(
      <BookingRecommendations
        compact
        compactVisualVariant="photo-grid"
        page={recommendationPage([{ kind: 'GAME', game, reasons: [] }])}
      />,
    );
    expect(within(container).getByRole('img', { name: 'Игра + тренер' })).toHaveAttribute(
      'src',
      coachGameBadgeUrl,
    );
  });

  it('separates a training host from the free participant slots', () => {
    const page = recommendationPage([
      {
        kind: 'TRAINING',
        activity: {
          id: '50000000-0000-4000-8000-000000000001',
          kind: 'TRAINING',
          title: 'Групповая тренировка уровень D',
          startsAt: '2026-08-30T08:00:00.000Z',
          endsAt: '2026-08-30T09:00:00.000Z',
          timezone: 'Europe/Moscow',
          station: {
            id: '60000000-0000-4000-8000-000000000002',
            name: 'Динамо',
            shortAddress: null,
          },
          court: null,
          levelRange: { from: 'D', to: 'D' },
          capacity: { total: 3, open: 2 },
          host: {
            displayName: 'Александр',
            avatarUrl: null,
            role: 'TRAINER',
          },
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
    expect(within(card).getByRole('link', { name: 'Групповая тренировка D' })).toBeInTheDocument();
    expect(
      card.querySelector('.recommendation-grid-card__info-row[title="Александр"] svg'),
    ).toHaveAttribute('viewBox', '0 0 16 16');
    expect(within(card).getByText('1 из 3 мест')).toHaveClass('sr-only');
    expect(within(card).getByText('Александр')).toBeInTheDocument();
    expect(within(card).queryByText(/\u0423ровень/)).not.toBeInTheDocument();
    const roster = within(card).getByLabelText('Тренер и свободные места');
    expect(within(roster).getByLabelText('Тренер')).toBeInTheDocument();
    expect(within(roster).getByLabelText('Свободных мест: 2')).toBeInTheDocument();
    expect(within(roster).getByRole('img', { name: 'Александр' })).toBeInTheDocument();
    expect(within(roster).getAllByLabelText('Свободное место')).toHaveLength(2);
    expect(within(card).queryByLabelText('Участники события')).not.toBeInTheDocument();
    expect(card.querySelector('.recommendation-grid-card__hero img')).toHaveAttribute(
      'src',
      expect.stringMatching(/training-hero\.webp$/),
    );
  });

  it.each([
    ['Вечерний Американо', 'Американо', false],
    ['МЕКСИКАНО D+', 'Мексикано', false],
    ['Американо ВРЕМЯ  НА ДРУЗЕЙ', 'Время на друзей', true],
  ])('uses the event badge and real capacity for %s', (title, badge, friends) => {
    const activity = {
      id: '50000000-0000-4000-8000-000000000002',
      kind: 'TOURNAMENT' as const,
      title,
      startsAt: '2026-08-31T17:00:00.000Z',
      endsAt: '2026-08-31T19:00:00.000Z',
      timezone: 'Europe/Moscow',
      station: { id: '60000000-0000-4000-8000-000000000003', name: 'Терехово', shortAddress: null },
      levelRange: { from: 'D' as const, to: 'D+' as const },
      host: null,
      capacity: { total: 16, open: 11 },
      route: '/tournaments?event=50000000-0000-4000-8000-000000000002',
    };
    const { container, rerender } = render(
      <BookingRecommendations
        compact
        compactVisualVariant="photo-grid"
        page={recommendationPage([{ kind: 'TOURNAMENT', activity, reasons: [] }])}
      />,
    );
    expect(container.querySelector('.recommendation-grid-card__event-badge')).toHaveTextContent(
      badge,
    );
    expect(
      container.querySelector('.recommendation-grid-card')?.hasAttribute('data-friends-event'),
    ).toBe(friends);
    expect(
      within(container).getByLabelText('Занято 5 из 16 мест. Свободных мест: 11'),
    ).toBeInTheDocument();
    expect(container.querySelector('.recommendation-grid-card__capacity-count')).toHaveTextContent(
      '5/16',
    );
    expect(within(container).getByText('(+11 мест)')).toBeVisible();
    rerender(
      <BookingRecommendations
        compact
        compactVisualVariant="photo-grid"
        page={recommendationPage([
          {
            kind: 'TOURNAMENT',
            activity: { ...activity, capacity: { total: null, open: null } },
            reasons: [],
          },
        ])}
      />,
    );
    expect(within(container).getByText('Места уточняются')).toBeVisible();
    expect(container.querySelector('.recommendation-grid-card__capacity-count')).toHaveTextContent(
      '—/—',
    );
  });

  it('keeps sold-out tournament details reachable without a separate CTA', () => {
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

    expect(within(card).getByText('Мест нет')).toBeVisible();
    expect(within(card).queryByRole('button')).not.toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Вечерний турнир' })).toHaveAttribute(
      'href',
      route,
    );
    const roster = within(card).getByLabelText('Занято 16 из 16 мест. Мест нет');
    expect(within(roster).getByRole('img', { name: 'Илья Соколов' })).toBeInTheDocument();
    expect(within(roster).queryByLabelText('Свободное место')).not.toBeInTheDocument();
    expect(within(card).queryByLabelText('Участники события')).not.toBeInTheDocument();
    expect(card.querySelector('.recommendation-grid-card__hero img')).toHaveAttribute(
      'src',
      expect.stringMatching(/tournament-hero\.webp$/),
    );
  });
});
