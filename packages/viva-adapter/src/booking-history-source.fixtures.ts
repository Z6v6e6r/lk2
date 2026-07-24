const baseExercise = {
  timeFrom: '2026-07-10T09:00:00+03:00',
  timeTo: '2026-07-10T10:00:00+03:00',
  studio: { name: 'ПаделхАБ Терехово', address: 'Терехово, 1' },
  room: { name: 'Корт 4' },
} as const;

export const VIVA_BOOKING_HISTORY_MIXED_PAGE_FIXTURE = {
  content: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      isCancelled: false,
      exercise: {
        ...baseExercise,
        id: '21111111-1111-4111-8111-111111111111',
        direction: { id: 4588, name: 'Падел' },
        type: { id: 999, name: 'Своя игра' },
      },
    },
    {
      id: '12222222-2222-4222-8222-222222222222',
      isCancelled: false,
      exercise: {
        ...baseExercise,
        id: '22222222-2222-4222-8222-222222222222',
        direction: { id: 7, name: 'Падел' },
        type: { id: 605, name: 'Групповая тренировка' },
      },
    },
    {
      id: '13333333-3333-4333-8333-333333333333',
      isCancelled: false,
      exercise: {
        ...baseExercise,
        id: '23333333-3333-4333-8333-333333333333',
        direction: { id: 2617, name: 'Турниры' },
        type: { id: 7, name: 'Американо' },
      },
    },
    {
      id: '14444444-4444-4444-8444-444444444444',
      isCancelled: true,
      exercise: {
        ...baseExercise,
        id: '24444444-4444-4444-8444-444444444444',
        direction: { id: 4588, name: 'Падел' },
        type: { id: 1613, name: 'Открытая игра' },
      },
    },
  ],
  totalPages: 2,
  totalElements: 5,
  last: false,
  first: true,
  numberOfElements: 4,
  size: 4,
  number: 0,
  empty: false,
} as const;

export const VIVA_BOOKING_HISTORY_NAME_FALLBACK_PAGE_FIXTURE = {
  content: [
    {
      id: '15555555-5555-4555-8555-555555555555',
      isCancelled: false,
      exercise: {
        ...baseExercise,
        direction: { id: 70, name: 'Падел' },
        type: { id: 71, name: 'Americano tournament' },
      },
    },
    {
      id: '16666666-6666-4666-8666-666666666666',
      isCancelled: false,
      exercise: {
        ...baseExercise,
        direction: { id: 72, name: 'Падел' },
        type: { id: 73, name: 'Игра + тренер' },
      },
    },
    {
      id: '17777777-7777-4777-8777-777777777777',
      isCancelled: false,
      exercise: {
        ...baseExercise,
        direction: { id: 74, name: 'Падел' },
        type: { id: 75, name: 'Open game' },
      },
    },
  ],
  totalPages: 1,
  totalElements: 3,
  last: true,
  first: true,
  numberOfElements: 3,
  size: 20,
  number: 0,
  empty: false,
} as const;

export const VIVA_BOOKING_HISTORY_EMPTY_PAGE_FIXTURE = {
  content: [],
  totalPages: 0,
  totalElements: 0,
  last: true,
  first: true,
  numberOfElements: 0,
  size: 20,
  number: 0,
  empty: true,
} as const;
