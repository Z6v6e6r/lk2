// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatFilters } from './ChatFilters.js';

afterEach(cleanup);

describe('chat filter rail accessibility', () => {
  it('keeps an accessible name on every control while the phone layout hides the label', () => {
    render(
      <ChatFilters filter="ALL" query="" onFilterChange={() => {}} onQueryChange={() => {}} />,
    );

    for (const name of [
      'Все',
      'Личные',
      'Игры',
      'Турниры',
      'Станции',
      'Сообщества',
      'Уведомления',
    ]) {
      const control = screen.getByRole(name === 'Уведомления' ? 'link' : 'button', { name });
      expect(control).toHaveAttribute('aria-label', name);
    }
  });
});
