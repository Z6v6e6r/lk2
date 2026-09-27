// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LinkedMessageText } from './LinkedMessageText.js';

afterEach(cleanup);

describe('LinkedMessageText', () => {
  it('renders a pasted address as an external link and keeps the surrounding sentence', () => {
    const { container } = render(
      <LinkedMessageText text="Корт: https://padlhub.ru/games, бронь" linkClassName="link" />,
    );

    const anchor = screen.getByRole('link', { name: 'https://padlhub.ru/games' });
    expect(anchor).toHaveAttribute('href', 'https://padlhub.ru/games');
    expect(anchor).toHaveAttribute('target', '_blank');
    expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
    expect(anchor).toHaveClass('link');
    expect(container.textContent).toBe('Корт: https://padlhub.ru/games, бронь');
  });

  it('renders every address of one message', () => {
    render(<LinkedMessageText text="padlhub.ru и https://t.me/padel" />);

    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'padlhub.ru' })).toHaveAttribute(
      'href',
      'https://padlhub.ru',
    );
    expect(screen.getByRole('link', { name: 'https://t.me/padel' })).toHaveAttribute(
      'href',
      'https://t.me/padel',
    );
  });

  it('keeps plain text as text, including line breaks', () => {
    const { container } = render(<LinkedMessageText text={'Первая строка\nИгра 5.5'} />);

    expect(screen.queryByRole('link')).toBeNull();
    expect(container.textContent).toBe('Первая строка\nИгра 5.5');
  });

  it('never turns a javascript: payload into an anchor', () => {
    const { container } = render(<LinkedMessageText text="javascript:alert(1)" />);

    expect(screen.queryByRole('link')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });
});
