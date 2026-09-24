// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatFilters } from './ChatFilters.js';

afterEach(cleanup);

describe('chat filter rail accessibility', () => {
  it('keeps an accessible name on every control while the phone layout hides the label', () => {
    render(<ChatFilters filter="ALL" onFilterChange={() => {}} />);

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

  it('keeps stations as the second destination right after "Все"', () => {
    render(<ChatFilters filter="ALL" onFilterChange={() => {}} />);

    const labels = screen
      .getAllByRole('button')
      .map((control) => control.getAttribute('aria-label'));

    expect(labels.slice(0, 3)).toEqual(['Все', 'Станции', 'Личные']);
  });
});
