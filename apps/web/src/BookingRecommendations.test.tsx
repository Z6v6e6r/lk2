// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BookingRecommendations,
  BookingRecommendationReasonChips,
} from './BookingRecommendations.js';
import type { BookingRecommendationPage } from './auth-gateway.js';

afterEach(cleanup);

type RecommendationGame = Extract<
  BookingRecommendationPage['items'][number],
  { kind: 'GAME' }
>['game'];

function recommendationGame(kind: RecommendationGame['kind'], id: string): RecommendationGame {
  return {
    id,
    revision: 1,
    surface: 'DISCOVER',
    displayState: 'FINDING_PLAYERS',
    title: kind === 'COACH_GAME' ? 'Игра + тренер' : 'Открытая игра',
    kind,
    visibility: 'PUBLIC',
    startsAt: '2026-07-30T15:00:00.000Z',
    endsAt: '2026-07-30T16:30:00.000Z',
    timezone: 'Europe/Moscow',
    station: {
      id: '60000000-0000-4000-8000-000000000001',
      name: 'Терехово',
    },
    court: null,
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
    priceSummary: null,
    viewerRelation: 'NONE',
    viewerPaymentState: 'NOT_REQUIRED',
    badges: [],
    allowedActions: ['OPEN_DETAILS', 'JOIN'],
    deepLink: `/games/${id}`,
    resultSummary: null,
    conversation: null,
  };
}

describe('booking recommendation markers', () => {
  it('shows two compact markers and summarizes the remaining factual reasons', () => {
    render(
      <BookingRecommendationReasonChips
        compact
        reasons={['LEVEL_MATCH', 'PLAYED_STATION', 'USUAL_TIME']}
      />,
    );

    const markers = screen.getByLabelText('Почему игра подходит');
    expect(within(markers).getByText('Ровные соперники')).toBeInTheDocument();
    expect(within(markers).getByText('Часто играете здесь')).toBeInTheDocument();
    expect(within(markers).queryByText('Ваше обычное время')).not.toBeInTheDocument();
    expect(within(markers).getByLabelText('Ещё причин: 1')).toHaveTextContent('+1');
  });

  it('keeps every marker visible on the complete recommendations page', () => {
    render(
      <BookingRecommendationReasonChips
        reasons={['LEVEL_MATCH', 'FRIEND_PLAYING', 'FAVORITE_STATION', 'PREFERRED_TIME']}
      />,
    );

    const markers = screen.getByLabelText('Почему игра подходит');
    expect(within(markers).getByText('Ровные соперники')).toBeInTheDocument();
    expect(within(markers).getByText('Здесь играют друзья')).toBeInTheDocument();
    expect(within(markers).getByText('Любимая станция')).toBeInTheDocument();
    expect(within(markers).getByText('Ваше удобное время')).toBeInTheDocument();
    expect(within(markers).queryByText(/^\+/)).not.toBeInTheDocument();
  });

  it('applies lime backgrounds to games and purple backgrounds to coach games', () => {
    const page: BookingRecommendationPage = {
      version: 'c'.repeat(64),
      generatedAt: '2026-07-29T09:00:00.000Z',
      staleAt: '2026-07-29T09:05:00.000Z',
      personalization: 'BASIC',
      items: [
        {
          kind: 'GAME',
          game: recommendationGame('RATING', '70000000-0000-4000-8000-000000000001'),
          reasons: [],
        },
        {
          kind: 'GAME',
          game: recommendationGame('COACH_GAME', '70000000-0000-4000-8000-000000000002'),
          reasons: [],
        },
        {
          kind: 'TRAINING',
          activity: {
            id: '50000000-0000-4000-8000-000000000003',
            kind: 'TRAINING',
            title: 'Игра+Тренер',
            startsAt: '2026-07-30T15:00:00.000Z',
            endsAt: '2026-07-30T16:30:00.000Z',
            timezone: 'Europe/Moscow',
            station: {
              id: '60000000-0000-4000-8000-000000000001',
              name: 'Терехово',
              shortAddress: null,
            },
            levelRange: null,
            capacity: { total: 4, open: 3 },
            host: null,
            route: '/trainings?event=50000000-0000-4000-8000-000000000003',
          },
          reasons: [],
        },
      ],
      nextCursor: null,
    };

    render(<BookingRecommendations compact page={page} />);

    expect(
      screen.getByRole('link', { name: 'Открытая игра' }).closest('.booking-recommendation'),
    ).toHaveAttribute('data-booking-card-background-tone', 'game');
    expect(
      screen.getByRole('link', { name: 'Игра + тренер' }).closest('.booking-recommendation'),
    ).toHaveAttribute('data-booking-card-background-tone', 'coach-game');
    const coachTrainingSection = screen
      .getByRole('link', { name: 'Игра+Тренер' })
      .closest('.booking-recommendation');
    expect(coachTrainingSection).toHaveAttribute('data-booking-card-background-tone', 'coach-game');
    const coachTrainingCard = screen.getByRole('link', { name: 'Игра+Тренер' }).closest('article');
    const coachTrainingKind = within(coachTrainingCard as HTMLElement)
      .getByText('Игра + тренер')
      .closest('.booking-activity-card__kind');
    expect(coachTrainingKind).toHaveClass('booking-activity-card__kind--coach-game');
    expect(
      within(coachTrainingCard as HTMLElement)
        .getByText('Игра + тренер')
        .closest('.booking-activity-card__kind-label'),
    ).not.toBeNull();
    expect(
      (coachTrainingSection as HTMLElement).style.getPropertyValue(
        '--booking-card-background-image',
      ),
    ).toContain('coach-game-purple.webp');
  });

  it('renders training and tournament cards with level and availability', () => {
    const page: BookingRecommendationPage = {
      version: 'a'.repeat(64),
      generatedAt: '2026-07-26T09:00:00.000Z',
      staleAt: '2026-07-26T09:05:00.000Z',
      personalization: 'LEARNED',
      items: [
        {
          kind: 'TRAINING',
          activity: {
            id: '50000000-0000-4000-8000-000000000001',
            kind: 'TRAINING',
            title: 'Групповая тренировка',
            startsAt: '2026-07-27T15:00:00.000Z',
            endsAt: '2026-07-27T16:30:00.000Z',
            timezone: 'Europe/Moscow',
            station: {
              id: '60000000-0000-4000-8000-000000000001',
              name: 'Терехово',
              shortAddress: 'г Москва, ул Нижние Мнёвники, д 12а',
            },
            levelRange: { from: 'C', to: 'B' },
            capacity: { total: 8, open: 3 },
            host: {
              displayName: 'Мария Орлова',
              avatarUrl:
                '/public/api/v1/local-padel/booking-activities/50000000-0000-4000-8000-000000000001/host-avatar',
              role: 'TRAINER',
            },
            route: '/trainings?event=50000000-0000-4000-8000-000000000001',
          },
          reasons: ['LEVEL_MATCH', 'PLAYED_STATION'],
        },
        {
          kind: 'TOURNAMENT',
          activity: {
            id: '50000000-0000-4000-8000-000000000002',
            kind: 'TOURNAMENT',
            title: 'Мини-турнир',
            startsAt: '2026-07-28T15:00:00.000Z',
            endsAt: '2026-07-28T17:00:00.000Z',
            timezone: 'Europe/Moscow',
            station: {
              id: '60000000-0000-4000-8000-000000000002',
              name: 'Сколково',
              shortAddress: null,
            },
            levelRange: { from: 'C+', to: 'B' },
            capacity: { total: 16, open: 1 },
            host: {
              displayName: 'Илья Соколов',
              avatarUrl: null,
              role: 'ORGANIZER',
            },
            route: '/tournaments?event=50000000-0000-4000-8000-000000000002',
          },
          reasons: ['LEVEL_MATCH', 'AVAILABLE_SOON'],
        },
      ],
      nextCursor: null,
    };

    render(<BookingRecommendations page={page} compact />);

    expect(screen.getByRole('link', { name: 'Групповая тренировка' })).toHaveAttribute(
      'href',
      page.items[0]?.kind === 'TRAINING' ? page.items[0].activity.route : '',
    );
    expect(screen.getByText('Мини-турнир')).toBeInTheDocument();
    const trainingCard = screen
      .getByRole('link', { name: 'Групповая тренировка' })
      .closest('article');
    expect(trainingCard).not.toBeNull();
    expect(within(trainingCard!).getByText('пн, 27 июля')).toBeInTheDocument();
    expect(within(trainingCard!).getByText('18:00–19:30')).toBeInTheDocument();
    expect(within(trainingCard!).getByText('Терехово')).toBeInTheDocument();
    expect(
      within(trainingCard!).queryByText('г Москва, ул Нижние Мнёвники, д 12а'),
    ).not.toBeInTheDocument();
    expect(
      within(trainingCard!).getByText('от C до B').closest('.game-card__level'),
    ).not.toBeNull();
    expect(trainingCard?.querySelectorAll('.game-card__meta svg')).toHaveLength(3);
    expect(screen.getByText('Осталось 1 место')).toBeInTheDocument();
    expect(screen.queryByText('Почему вам подходит')).not.toBeInTheDocument();
    const trainingSection = trainingCard?.closest('.booking-recommendation');
    expect(trainingSection).toBeInstanceOf(HTMLElement);
    expect(trainingSection).toHaveAttribute('data-booking-card-background-tone', 'training');
    expect(
      (trainingSection as HTMLElement).style.getPropertyValue('--booking-card-background-image'),
    ).toContain('.webp');
    const reasonMarkers = within(trainingSection as HTMLElement).getByLabelText(
      'Почему игра подходит',
    );
    expect(reasonMarkers).toHaveClass('is-icon-only');
    expect(reasonMarkers).toHaveTextContent('');
    expect(reasonMarkers.closest('.game-card__footer')).not.toBeNull();
    expect(reasonMarkers.closest('.game-card__actions')).toBeNull();
    expect(within(reasonMarkers).getByLabelText('Ровные соперники')).toBeInTheDocument();
    expect(within(reasonMarkers).getByLabelText('Часто играете здесь')).toBeInTheDocument();

    cleanup();
    render(
      <BookingRecommendations
        page={page}
        compact
        compactActionVariant="mini-create"
        compactMetadataVariant="station-time"
        compactRosterVariant="host-slots"
        showCompactReasonBadges={false}
      />,
    );

    const v3TrainingCard = screen
      .getByRole('link', { name: 'Групповая тренировка' })
      .closest('article');
    expect(v3TrainingCard).toBeInstanceOf(HTMLElement);
    const trainingKind = within(v3TrainingCard as HTMLElement)
      .getByText('Тренировка')
      .closest('.booking-activity-card__kind');
    expect(trainingKind).toHaveClass('booking-activity-card__kind--training');
    expect(trainingKind?.querySelector('.booking-activity-card__kind-icon svg')).not.toBeNull();
    expect(trainingKind?.querySelector('.booking-activity-card__kind-label')).toHaveTextContent(
      'Тренировка',
    );
    const stationRow = within(v3TrainingCard as HTMLElement)
      .getByText('Терехово')
      .closest('.activity-card-metadata-row');
    expect(stationRow).toBeInstanceOf(HTMLElement);
    expect(within(stationRow as HTMLElement).queryByText('18:00–19:30')).not.toBeInTheDocument();
    const timeRow = within(v3TrainingCard as HTMLElement)
      .getByText('18:00–19:30')
      .closest('.activity-card-metadata-row');
    expect(timeRow).toBeInstanceOf(HTMLElement);
    expect(
      within(v3TrainingCard as HTMLElement).queryByText('пн, 27 июля'),
    ).not.toBeInTheDocument();
    expect(
      within(v3TrainingCard as HTMLElement)
        .getByText('от C до B')
        .closest('.game-card__level'),
    ).not.toBeNull();
    expect(v3TrainingCard?.querySelectorAll('.game-card__meta svg')).toHaveLength(3);
    const miniCreateAction = within(v3TrainingCard as HTMLElement).getByRole('link', {
      name: 'Записаться',
    });
    expect(miniCreateAction).toHaveClass('game-card__button--mini-create');
    expect(miniCreateAction).toHaveTextContent('');
    expect(miniCreateAction.querySelector('svg')).toHaveAttribute('viewBox', '0 0 88 72');
    expect(miniCreateAction.querySelector('rect')).toHaveAttribute('width', '56');
    const trainerSlots = within(v3TrainingCard as HTMLElement).getByLabelText(
      'Тренер и свободные места',
    );
    const trainerAvatar = within(trainerSlots).getByRole('img', { name: /Мария Орлова/ });
    expect(trainerAvatar.querySelector('[data-player-level-ring]')).not.toBeInTheDocument();
    expect(trainerAvatar.querySelector('[data-player-level-photo]')).toHaveAttribute(
      'src',
      '/public/api/v1/local-padel/booking-activities/50000000-0000-4000-8000-000000000001/host-avatar',
    );
    const openSlots = within(trainerSlots).getByLabelText('Свободных мест: 3');
    expect(openSlots).toHaveClass('booking-activity-card__open-slots');
    expect(within(openSlots).getAllByLabelText('Свободное место')).toHaveLength(3);
    expect(openSlots).not.toHaveTextContent('+3');
    expect(
      within(v3TrainingCard as HTMLElement).queryByText('Свободно мест: 3'),
    ).not.toBeInTheDocument();
    expect(
      within(v3TrainingCard as HTMLElement).queryByLabelText('Почему игра подходит'),
    ).not.toBeInTheDocument();
    const tournamentCard = screen.getByText('Мини-турнир').closest('article');
    const tournamentKind = within(tournamentCard as HTMLElement)
      .getByText('Турнир')
      .closest('.booking-activity-card__kind');
    expect(tournamentKind).toHaveClass('booking-activity-card__kind--tournament');
    expect(tournamentKind?.querySelector('.booking-activity-card__kind-icon svg')).toHaveAttribute(
      'viewBox',
      '0 0 8 8',
    );
    expect(tournamentKind?.querySelector('.booking-activity-card__kind-icon path')).toHaveAttribute(
      'fill',
      'currentColor',
    );
    expect(tournamentCard?.closest('.booking-recommendation')).toHaveAttribute(
      'data-booking-card-background-tone',
      'tournament',
    );
    expect(
      within(tournamentCard as HTMLElement)
        .getByText('от C+ до B')
        .closest('.game-card__level'),
    ).not.toBeNull();
    const organizerSlots = within(tournamentCard as HTMLElement).getByLabelText(
      'Организатор и свободные места',
    );
    const organizerAvatar = within(organizerSlots).getByLabelText('Организатор');
    expect(within(organizerAvatar).getByRole('img', { name: /Илья Соколов/ })).toBeInTheDocument();
    const tournamentOpenSlots = within(organizerSlots).getByLabelText('Свободных мест: 1');
    expect(tournamentOpenSlots).toHaveClass('booking-activity-card__open-slots');
    expect(within(tournamentOpenSlots).getAllByLabelText('Свободное место')).toHaveLength(1);
  });

  it('requests the next page when the compact feed approaches its scroll boundary', () => {
    const onLoadMore = vi.fn();
    const page: BookingRecommendationPage = {
      version: 'b'.repeat(64),
      generatedAt: '2026-07-26T09:00:00.000Z',
      staleAt: '2026-07-26T09:05:00.000Z',
      personalization: 'BASIC',
      items: [
        {
          kind: 'TRAINING',
          activity: {
            id: '50000000-0000-4000-8000-000000000003',
            kind: 'TRAINING',
            title: 'Тренировка',
            startsAt: '2026-07-27T15:00:00.000Z',
            endsAt: '2026-07-27T16:30:00.000Z',
            timezone: 'Europe/Moscow',
            station: {
              id: '60000000-0000-4000-8000-000000000001',
              name: 'Терехово',
              shortAddress: null,
            },
            levelRange: null,
            capacity: { total: 8, open: 2 },
            host: null,
            route: '/trainings?event=50000000-0000-4000-8000-000000000003',
          },
          reasons: ['AVAILABLE_SOON'],
        },
      ],
      nextCursor: 'next-recommendation-cursor',
    };
    const { container } = render(
      <BookingRecommendations compact hasMore onLoadMore={onLoadMore} page={page} />,
    );
    const feed = container.querySelector('.booking-recommendations');
    expect(feed).toBeInstanceOf(HTMLElement);
    Object.defineProperties(feed, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 800 },
      scrollTop: { configurable: true, value: 200 },
    });

    fireEvent.scroll(feed as HTMLElement);

    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it('repeats ads without leaving an empty compact-grid cell before a strip', () => {
    const page: BookingRecommendationPage = {
      version: 'd'.repeat(64),
      generatedAt: '2026-07-31T09:00:00.000Z',
      staleAt: '2026-07-31T09:05:00.000Z',
      personalization: 'BASIC',
      items: Array.from({ length: 4 }, (_value, index) => ({
        kind: 'GAME' as const,
        game: recommendationGame(
          'RATING',
          `70000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        ),
        reasons: [] as const,
      })),
      nextCursor: null,
    };
    const recommendationStripAdvertising = {
      repeatEveryCards: 2,
      items: [
        {
          id: '90000000-0000-4000-8000-000000000001',
          title: 'Узкая плашка',
          route: '/offers/strip',
          imageUrl: 'https://padlhub.test/strip.webp',
          mobileImageUrl: null,
        },
      ],
    };
    const recommendationCardAdvertising = {
      repeatEveryCards: 3,
      items: [
        {
          id: '90000000-0000-4000-8000-000000000002',
          title: 'Карточная реклама',
          route: '/offers/card',
          imageUrl: 'https://padlhub.test/card.webp',
          mobileImageUrl: null,
          squareImageUrl: 'https://padlhub.test/card-square.webp',
          horizontalImageUrl: 'https://padlhub.test/card-horizontal.webp',
          badgeText: 'Партнёр',
          footerText: 'Подробнее',
        },
      ],
    };

    const onAdvertisingEngagement = vi.fn().mockResolvedValue({ accepted: true });
    const { container, rerender } = render(
      <BookingRecommendations
        advertisingLayout="compact"
        compact
        page={page}
        recommendationCardAdvertising={recommendationCardAdvertising}
        recommendationStripAdvertising={recommendationStripAdvertising}
        onAdvertisingEngagement={onAdvertisingEngagement}
      />,
    );
    const compactFeed = container.querySelector('.booking-recommendations');
    expect([...(compactFeed?.children ?? [])].map((element) => element.className)).toEqual([
      'booking-recommendation',
      'booking-recommendation',
      'booking-recommendation-ad is-strip is-compact',
      'booking-recommendation',
      'booking-recommendation-ad is-card is-compact',
      'booking-recommendation-ad is-strip is-compact',
      'booking-recommendation',
    ]);
    const compactChildren = [...(compactFeed?.children ?? [])];
    let previousStripIndex = -1;
    for (const strip of compactChildren) {
      if (strip.getAttribute('data-recommendation-ad-kind') !== 'strip') continue;
      const stripIndex = compactChildren.indexOf(strip);
      const compactCardsBeforeStrip = compactChildren
        .slice(previousStripIndex + 1, stripIndex)
        .filter((element) => element.getAttribute('data-recommendation-ad-kind') !== 'strip');
      expect(compactCardsBeforeStrip.length % 2).toBe(0);
      previousStripIndex = stripIndex;
    }
    const compactCardLink = screen.getByRole('link', { name: 'Реклама: Карточная реклама' });
    expect(compactCardLink).toHaveAttribute('href', '/offers/card');
    expect(within(compactCardLink).queryByText('Карточная реклама')).not.toBeInTheDocument();
    expect(screen.getByText('Партнёр')).toBeVisible();
    expect(screen.getByText('Подробнее')).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'Реклама: Карточная реклама' }).querySelector('img'),
    ).toHaveAttribute('src', 'https://padlhub.test/card-square.webp');
    expect(onAdvertisingEngagement).toHaveBeenCalledWith(
      '90000000-0000-4000-8000-000000000002',
      'IMPRESSION',
    );
    fireEvent.click(screen.getByRole('link', { name: 'Реклама: Карточная реклама' }));
    expect(onAdvertisingEngagement).toHaveBeenCalledWith(
      '90000000-0000-4000-8000-000000000002',
      'CLICK',
    );

    rerender(
      <BookingRecommendations
        advertisingLayout="vertical"
        compact
        page={page}
        recommendationCardAdvertising={recommendationCardAdvertising}
        recommendationStripAdvertising={recommendationStripAdvertising}
        onAdvertisingEngagement={onAdvertisingEngagement}
      />,
    );
    expect(
      container.querySelector('[data-recommendation-ad-kind="strip"]'),
    ).not.toBeInTheDocument();
    expect(container.querySelector('[data-recommendation-ad-kind="card"]')).toHaveClass(
      'is-vertical',
    );
    expect(
      screen.getByRole('link', { name: 'Реклама: Карточная реклама' }).querySelector('img'),
    ).toHaveAttribute('src', 'https://padlhub.test/card-horizontal.webp');
    expect(screen.getByText('Карточная реклама')).toBeVisible();
  });

  it('counts compact card ads toward an eight-card strip interval', () => {
    const page: BookingRecommendationPage = {
      version: 'e'.repeat(64),
      generatedAt: '2026-07-31T09:00:00.000Z',
      staleAt: '2026-07-31T09:05:00.000Z',
      personalization: 'BASIC',
      items: Array.from({ length: 14 }, (_value, index) => ({
        kind: 'GAME' as const,
        game: recommendationGame(
          'RATING',
          `71000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        ),
        reasons: [] as const,
      })),
      nextCursor: null,
    };
    const { container } = render(
      <BookingRecommendations
        advertisingLayout="compact"
        compact
        page={page}
        recommendationCardAdvertising={{
          repeatEveryCards: 6,
          items: [
            {
              id: '91000000-0000-4000-8000-000000000001',
              title: 'Карточная реклама',
              route: '/offers/card',
              imageUrl: 'https://padlhub.test/card.webp',
              mobileImageUrl: null,
            },
          ],
        }}
        recommendationStripAdvertising={{
          repeatEveryCards: 8,
          items: [
            {
              id: '91000000-0000-4000-8000-000000000002',
              title: 'Узкая плашка',
              route: '/offers/strip',
              imageUrl: 'https://padlhub.test/strip.webp',
              mobileImageUrl: null,
            },
          ],
        }}
      />,
    );

    const compactChildren = [
      ...(container.querySelector('.booking-recommendations')?.children ?? []),
    ];
    let compactCardsSinceStrip = 0;
    let stripCount = 0;
    for (const element of compactChildren) {
      if (element.getAttribute('data-recommendation-ad-kind') === 'strip') {
        expect(compactCardsSinceStrip).toBe(8);
        compactCardsSinceStrip = 0;
        stripCount += 1;
      } else {
        compactCardsSinceStrip += 1;
      }
    }
    expect(stripCount).toBe(2);
    expect(
      compactChildren.filter(
        (element) => element.getAttribute('data-recommendation-ad-kind') === 'card',
      ),
    ).toHaveLength(2);
  });
});
