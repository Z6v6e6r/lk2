// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SummaryParticipants } from './SummaryParticipants.js';

afterEach(cleanup);

describe('SummaryParticipants', () => {
  it('shows no avatars or action when all seats are filled', () => {
    render(
      <SummaryParticipants
        action={<a href="/tournaments/final">Подробнее</a>}
        occupied={3}
        total={3}
      />,
    );

    expect(screen.getByText('Записано 3 из 3')).toBeInTheDocument();
    expect(screen.getByText('Мест нет')).toBeInTheDocument();
    expect(screen.queryByLabelText('Доступно мест: 0')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Подробнее' })).not.toBeInTheDocument();
  });

  it('shows up to three empty-seat icons and a separate remaining-seat counter', () => {
    render(<SummaryParticipants occupied={5} total={12} />);

    const slots = screen.getByLabelText('Доступно мест: 7');
    expect(screen.getByText('Доступно 7 мест из 12')).toBeInTheDocument();
    expect(within(slots).getAllByLabelText(/Свободное место/)).toHaveLength(3);
    expect(within(slots).getByLabelText('Ещё мест: 4')).toHaveTextContent('+4');
  });
});
