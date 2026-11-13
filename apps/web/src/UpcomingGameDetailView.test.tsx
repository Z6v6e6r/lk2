// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { UpcomingGameDetailView } from './UpcomingGameDetailView.js';
import type { HomeUpcomingItem } from './HomeDashboardPage.js';

const booking: HomeUpcomingItem = {
  id: '88888888-8888-4888-8888-888888888888',
  kind: 'game',
  title: 'Утренняя игра',
  startsAt: '2026-11-15T04:00:00Z',
  endsAt: '2026-11-15T05:00:00Z',
  venue: 'Терехово',
  status: 'confirmed',
  route: '/games?event=88888888-8888-4888-8888-888888888888',
};
afterEach(cleanup);

it('uses the detail layout and only the roster, capacity and profile links supplied by the snapshot', async () => {
  render(
    <UpcomingGameDetailView
      item={{
        ...booking,
        game: { type: 'rating', courtName: 'Корт №1' },
        roster: { state: 'READY', capacity: 2 },
        openSlots: 1,
        participants: [
          { profileId: '11111111-1111-4111-8111-111111111111', displayName: 'Анна', level: 'C' },
        ],
      }}
    />,
  );
  expect(screen.getByRole('region', { name: 'Карточка игры' })).toHaveClass('game-detail');
  expect(screen.getByText('Игра на рейтинг')).toBeVisible();
  expect(screen.getByText('Терехово · Корт №1')).toBeVisible();
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '2');
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
  expect(screen.getByRole('link', { name: /Анна/ })).toHaveAttribute(
    'href',
    '/profile/11111111-1111-4111-8111-111111111111',
  );
  expect(screen.getAllByText('Свободное место')).toHaveLength(1);
  expect(screen.getByText('Запись подтверждена')).toBeVisible();
  expect(screen.queryByRole('button', { name: /Пригласить|Вступить|Оплатить|Выйти/ })).toBeNull();
  await userEvent.click(screen.getByRole('tab', { name: 'Результат' }));
  expect(screen.getByRole('tabpanel', { name: 'Результат' })).toHaveTextContent(
    'Результат пока недоступен',
  );
});

it.each([undefined, { state: 'UNAVAILABLE' as const }])(
  'does not represent an unavailable roster as four free places: %j',
  (roster) => {
    render(<UpcomingGameDetailView item={{ ...booking, ...(roster ? { roster } : {}) }} />);
    expect(screen.getByText('Состав временно недоступен')).toBeVisible();
    expect(screen.queryByText('Свободное место')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText('Френдли игра')).toBeNull();
  },
);

it('does not render stale participant fields when the server marks the roster unavailable', () => {
  render(
    <UpcomingGameDetailView
      item={{
        ...booking,
        roster: { state: 'UNAVAILABLE' },
        openSlots: 4,
        participants: [{ displayName: 'Устаревший игрок' }],
      }}
    />,
  );
  expect(screen.queryByText('Устаревший игрок')).toBeNull();
  expect(screen.queryByText('Свободное место')).toBeNull();
});

it('preserves a stale roster warning without inventing profile identifiers or a capacity', () => {
  render(
    <UpcomingGameDetailView
      item={{
        ...booking,
        roster: { state: 'STALE' },
        participants: [{ displayName: 'Анна' }],
        status: 'waitlist',
      }}
    />,
  );
  expect(screen.getByText('Состав требует обновления')).toBeVisible();
  expect(screen.getByText('Вы в листе ожидания')).toBeVisible();
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.queryByRole('progressbar')).toBeNull();
});
