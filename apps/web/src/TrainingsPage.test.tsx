// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TrainingsPage } from './TrainingsPage.js';
import type { BookingRecommendationActivity } from './booking-activity-kind.js';
import type { AuthGateway, TrainingSchedulePage } from './auth-gateway.js';

const stationId = '11111111-1111-4111-8111-111111111111';

function training(
  overrides: Partial<BookingRecommendationActivity> = {},
): BookingRecommendationActivity {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    kind: 'TRAINING',
    title: 'Падел групповая тренировка',
    startsAt: new Date(Date.now() + 3_600_000).toISOString(),
    endsAt: new Date(Date.now() + 7_200_000).toISOString(),
    timezone: 'Europe/Moscow',
    station: {
      id: stationId,
      name: 'Терехово',
      shortAddress: 'г Москва, ул Нижние Мнёвники, д 12а',
    },
    court: {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Корт №2',
    },
    category: {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Для начинающих',
    },
    levelRange: { from: 'D', to: 'D+' },
    capacity: { total: 6, open: 3 },
    host: {
      displayName: 'Мария Орлова',
      avatarUrl:
        '/public/api/v1/local-padel/booking-activities/22222222-2222-4222-8222-222222222222/host-avatar',
      role: 'TRAINER',
    },
    route: '/trainings?event=22222222-2222-4222-8222-222222222222',
    ...overrides,
  };
}

function trainingSchedule(
  activities: readonly BookingRecommendationActivity[],
): TrainingSchedulePage {
  return {
    version: 'a'.repeat(64),
    generatedAt: new Date().toISOString(),
    staleAt: new Date(Date.now() + 60_000).toISOString(),
    items: [...activities],
  };
}

function gateway(page: TrainingSchedulePage): AuthGateway {
  return {
    listTrainingSchedule: vi.fn().mockResolvedValue(page),
  } as unknown as AuthGateway;
}

afterEach(() => cleanup());

describe('TrainingsPage', () => {
  it('shows the current group catalog including coach games with trainer and slot cards', async () => {
    const groupTraining = training();
    const coachGame = training({
      id: '55555555-5555-4555-8555-555555555555',
      title: 'Игра + тренер',
      category: {
        id: '66666666-6666-4666-8666-666666666666',
        name: 'Игра + тренер',
      },
      route: '/trainings?event=55555555-5555-4555-8555-555555555555',
    });
    const api = gateway(trainingSchedule([groupTraining, coachGame]));

    render(<TrainingsPage gateway={api} />);

    expect(await screen.findByText(groupTraining.title)).toBeInTheDocument();
    expect(screen.getAllByText(coachGame.title)).toHaveLength(2);
    expect(api.listTrainingSchedule).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Тренировки' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Групповые тренировки' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Индивидуальные тренировки' })).toHaveAttribute(
      'href',
      '/coaches',
    );

    const card = screen.getByText(groupTraining.title).closest('article');
    expect(card).not.toBeNull();
    expect(within(card!).getByText('Тренировка').parentElement).toHaveClass(
      'booking-activity-card__kind--training',
    );
    expect(
      within(card!).getByText(`${groupTraining.station.name} · ${groupTraining.court?.name}`),
    ).toBeInTheDocument();
    expect(
      within(card!).queryByText('г Москва, ул Нижние Мнёвники, д 12а'),
    ).not.toBeInTheDocument();
    const trainerSlots = within(card!).getByLabelText('Тренер и свободные места');
    expect(within(trainerSlots).getByRole('img', { name: /Мария Орлова/ })).toBeInTheDocument();
    expect(
      within(within(trainerSlots).getByLabelText('Свободных мест: 3')).getAllByLabelText(
        'Свободное место',
      ),
    ).toHaveLength(3);
  });

  it('filters the group list by its PadlHub category', async () => {
    const beginner = training();
    const advanced = training({
      id: '77777777-7777-4777-8777-777777777777',
      title: 'Тактическая тренировка',
      category: {
        id: '88888888-8888-4888-8888-888888888888',
        name: 'Тактика',
      },
      levelRange: { from: 'C', to: 'B' },
      route: '/trainings?event=77777777-7777-4777-8777-777777777777',
    });
    const api = gateway(trainingSchedule([beginner, advanced]));
    const user = userEvent.setup();

    render(<TrainingsPage gateway={api} />);
    await screen.findByText(beginner.title);

    await user.click(screen.getByRole('button', { name: 'Все типы' }));
    const categoryFilter = screen.getByRole('group', { name: 'Типы тренировок' });
    await user.click(within(categoryFilter).getByRole('checkbox', { name: 'Тактика' }));

    await waitFor(() => expect(screen.queryByText(beginner.title)).not.toBeInTheDocument());
    expect(screen.getByText(advanced.title)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Убрать фильтр Тактика' })).toBeInTheDocument();
  });
});
