// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BookingRecommendations,
  BookingRecommendationReasonChips,
} from './BookingRecommendations.js';
import type { BookingRecommendationPage } from './auth-gateway.js';

afterEach(cleanup);

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
        reasons={['LEVEL_MATCH', 'FAVORITE_STATION', 'PREFERRED_TIME']}
      />,
    );

    const markers = screen.getByLabelText('Почему игра подходит');
    expect(within(markers).getByText('Ровные соперники')).toBeInTheDocument();
    expect(within(markers).getByText('Любимая станция')).toBeInTheDocument();
    expect(within(markers).getByText('Ваше удобное время')).toBeInTheDocument();
    expect(within(markers).queryByText(/^\+/)).not.toBeInTheDocument();
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
  });
});
