// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TrainingsPage } from './TrainingsPage.js';
import type { BookingRecommendationActivity } from './booking-activity-kind.js';
import type {
  AuthGateway,
  EventCatalogItem,
  EventCatalogPage,
  EventCatalogQuery,
} from './auth-gateway.js';

type TrainingCatalogItem = Extract<EventCatalogItem, { readonly activity: unknown }>;

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

function catalogItem(
  activity: BookingRecommendationActivity,
  kind: TrainingCatalogItem['kind'] = 'GROUP_TRAINING',
): TrainingCatalogItem {
  return { kind, activity };
}

function catalogPage(
  items: readonly TrainingCatalogItem[],
  options: { readonly nextCursor?: string | null; readonly totalMatched?: number } = {},
): EventCatalogPage {
  const activities = items.map((item) => item.activity);
  const categories = [
    ...new Map(
      activities.flatMap((activity) =>
        activity.category ? [[activity.category.id, activity.category.name] as const] : [],
      ),
    ),
  ].map(([id, name]) => ({
    id,
    name,
    count: activities.filter((activity) => activity.category?.id === id).length,
  }));
  const stations = [
    ...new Map(activities.map((activity) => [activity.station.id, activity.station.name] as const)),
  ].map(([id, name]) => ({
    id,
    name,
    count: activities.filter((activity) => activity.station.id === id).length,
  }));
  return {
    state: 'READY',
    snapshotVersion: 'a'.repeat(64),
    generatedAt: new Date().toISOString(),
    staleAt: new Date(Date.now() + 60_000).toISOString(),
    items: [...items],
    nextCursor: options.nextCursor ?? null,
    sourceStatus: [{ source: 'SCHEDULE', localDate: null, state: 'READY', errorCode: null }],
    totalMatched: options.totalMatched ?? items.length,
    facets: {
      kinds: [
        { kind: 'COACH_GAME', count: items.filter((item) => item.kind === 'COACH_GAME').length },
        {
          kind: 'GROUP_TRAINING',
          count: items.filter((item) => item.kind === 'GROUP_TRAINING').length,
        },
        { kind: 'SPLIT', count: items.filter((item) => item.kind === 'SPLIT').length },
      ],
      categories,
      stations,
    },
  };
}

function gateway(firstPage: EventCatalogPage): AuthGateway {
  return {
    listEventCatalog: vi.fn().mockResolvedValue(firstPage),
    continueEventCatalog: vi.fn().mockResolvedValue(
      catalogPage([], {
        nextCursor: null,
        totalMatched: firstPage.totalMatched ?? firstPage.items.length,
      }),
    ),
  } as unknown as AuthGateway;
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
    const api = gateway(
      catalogPage([catalogItem(groupTraining), catalogItem(coachGame, 'COACH_GAME')]),
    );

    render(<TrainingsPage gateway={api} />);

    expect(await screen.findByText(groupTraining.title)).toBeInTheDocument();
    expect(screen.getAllByText(coachGame.title)).toHaveLength(2);
    expect(api.listEventCatalog).toHaveBeenCalledTimes(1);
    expect(api.listEventCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'TRAININGS',
        kinds: ['COACH_GAME', 'GROUP_TRAINING', 'SPLIT'],
        availability: 'INCLUDE_FULL',
        limit: 20,
      }),
    );
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

  it('sends the selected PadlHub category to the server catalog query', async () => {
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
    const initialPage = catalogPage([catalogItem(beginner), catalogItem(advanced)]);
    const filteredPage = catalogPage([catalogItem(advanced)]);
    const api = gateway(initialPage);
    vi.mocked(api.listEventCatalog)
      .mockResolvedValueOnce(initialPage)
      .mockResolvedValueOnce(filteredPage);
    const user = userEvent.setup();

    render(<TrainingsPage gateway={api} />);
    await screen.findByText(beginner.title);

    await user.click(screen.getByRole('button', { name: 'Все типы' }));
    const categoryFilter = screen.getByRole('group', { name: 'Типы тренировок' });
    await user.click(within(categoryFilter).getByRole('checkbox', { name: 'Тактика' }));

    await waitFor(() =>
      expect(api.listEventCatalog).toHaveBeenLastCalledWith(
        expect.objectContaining({ categoryIds: [advanced.category!.id], limit: 20 }),
      ),
    );
    await waitFor(() => expect(screen.queryByText(beginner.title)).not.toBeInTheDocument());
    expect(screen.getByText(advanced.title)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Убрать фильтр Тактика' })).toBeInTheDocument();
  });

  it('loads a 20 plus 1 catalog through the opaque continuation cursor', async () => {
    const activities = Array.from({ length: 21 }, (_, index) =>
      training({
        id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, '0')}`,
        title: `Тренировка ${index + 1}`,
        route: `/trainings?event=${index + 1}`,
      }),
    );
    const firstPage = catalogPage(
      activities.slice(0, 20).map((item) => catalogItem(item)),
      {
        nextCursor: 'opaque-page-2',
        totalMatched: 21,
      },
    );
    const secondPage = catalogPage([catalogItem(activities[20]!)], {
      nextCursor: null,
      totalMatched: 21,
    });
    const api = gateway(firstPage);
    vi.mocked(api.continueEventCatalog).mockResolvedValueOnce(secondPage);
    const user = userEvent.setup();

    render(<TrainingsPage gateway={api} />);
    expect(await screen.findByText('Тренировка 20')).toBeInTheDocument();
    expect(screen.queryByText('Тренировка 21')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Показать ещё' }));

    await waitFor(() => expect(api.continueEventCatalog).toHaveBeenCalledWith('opaque-page-2', 20));
    expect(await screen.findByText('Тренировка 21')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).not.toBeInTheDocument();
  });

  it('starts a new dated query and ignores the late response from the previous query', async () => {
    const oldPage = deferred<EventCatalogPage>();
    const datedPage = deferred<EventCatalogPage>();
    const api = gateway(catalogPage([]));
    vi.mocked(api.listEventCatalog)
      .mockImplementationOnce(() => oldPage.promise)
      .mockImplementationOnce(() => datedPage.promise);
    const user = userEvent.setup();

    render(<TrainingsPage gateway={api} />);
    await waitFor(() => expect(api.listEventCatalog).toHaveBeenCalledTimes(1));
    const dateButtons = within(screen.getByLabelText('Выбор даты')).getAllByRole('button');
    const selectedDate = new Date();
    selectedDate.setHours(0, 0, 0, 0);
    selectedDate.setDate(selectedDate.getDate() + 1);

    await user.click(dateButtons[2]!);

    await waitFor(() => expect(api.listEventCatalog).toHaveBeenCalledTimes(2));
    const datedQuery = vi.mocked(api.listEventCatalog).mock.calls[1]?.[0] as EventCatalogQuery;
    expect(datedQuery.localDates).toEqual([localDateKey(selectedDate)]);
    const current = training({
      id: '99999999-9999-4999-8999-999999999999',
      title: 'Тренировка новой даты',
    });
    const stale = training({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: 'Устаревшая тренировка',
    });
    act(() => datedPage.resolve(catalogPage([catalogItem(current)])));
    expect(await screen.findByText(current.title)).toBeInTheDocument();

    act(() => oldPage.resolve(catalogPage([catalogItem(stale)])));
    await waitFor(() => expect(screen.queryByText(stale.title)).not.toBeInTheDocument());
    expect(screen.getByText(current.title)).toBeInTheDocument();
  });
});
