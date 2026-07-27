// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ProfileLevelHistoryPage } from './ProfileLevelHistoryPage.js';

afterEach(cleanup);

describe('ProfileLevelHistoryPage', () => {
  it('renders date and level axes from persisted history points', () => {
    render(
      <ProfileLevelHistoryPage
        history={{
          userId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
          items: [
            {
              changedAt: '2026-05-10T09:00:00.000Z',
              levelLabel: 'D+',
              levelValue: 2.75,
            },
            {
              changedAt: '2026-07-20T12:00:00.000Z',
              levelLabel: 'C',
              levelValue: 3.1,
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'История уровня' })).toBeVisible();
    expect(
      screen.getByRole('img', {
        name: 'График изменения уровня: дата по горизонтали, уровень по вертикали',
      }),
    ).toBeVisible();
    expect(screen.getByText('10 мая 2026 г.')).toBeVisible();
    expect(screen.getByText('20 июля 2026 г.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Назад в профиль' })).toHaveAttribute(
      'href',
      '/profile',
    );
  });
});
