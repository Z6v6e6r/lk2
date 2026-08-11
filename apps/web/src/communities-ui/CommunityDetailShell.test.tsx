// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommunityDetailShell } from './CommunityDetailShell.js';
import type { CommunityReadOnlyModel } from './types.js';

const model: CommunityReadOnlyModel = {
  community: {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Padel Friends',
    memberCount: 42,
  },
  posts: [
    {
      author: { displayName: 'Анна Петрова' },
      body: 'Играем в субботу!',
      publishedLabel: 'сегодня',
      reactionsCount: 4,
      commentsCount: 2,
    },
  ],
  messages: [
    {
      author: { displayName: 'Илья Смирнов' },
      body: 'Буду к 19:00',
      sentLabel: '18:42',
    },
  ],
  ranking: [
    {
      place: 1,
      displayName: 'Мария Иванова',
      levelLabel: 'Любитель',
      score: 1240,
    },
  ],
  ratingPeriod: '30d',
  ratingTab: 'overall',
};

afterEach(cleanup);

describe('CommunityDetailShell', () => {
  it('renders the Russian LK-aligned read-only feed shell', () => {
    render(<CommunityDetailShell model={model} />);
    expect(screen.getByRole('heading', { name: 'Padel Friends' })).toBeInTheDocument();
    expect(screen.getByLabelText('Сообщество доступно только для просмотра')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Лента' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Все публикации' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Турниры: фильтр недоступен' })).toBeDisabled();
    expect(screen.getByText('Играем в субботу!')).toBeInTheDocument();
  });

  it('changes read-only tabs and keeps the visible chat composer disabled', () => {
    const onTabChange = vi.fn();
    render(<CommunityDetailShell model={model} onTabChange={onTabChange} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Чат' }));
    expect(screen.getByText('Буду к 19:00')).toBeInTheDocument();
    expect(screen.getByText('Чат доступен только для чтения.')).toBeInTheDocument();
    expect(screen.getByText('Последние сообщения')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /отправить/i })).toBeDisabled();
    expect(onTabChange).toHaveBeenCalledWith('chat');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Чат' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Рейтинг' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      screen.getByRole('tab', { name: 'Рейтинг' }).id,
    );
  });

  it('renders and filters the ranking without commands', () => {
    render(<CommunityDetailShell model={model} initialTab="ranking" />);
    expect(screen.getByText('Мария Иванова')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Последние 30 дней: выбор периода недоступен' }).className,
    ).toContain('pillActive');
    expect(
      screen.getByRole('button', { name: 'Игры: выбор типа рейтинга недоступен' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Дополнительные фильтры недоступны' }),
    ).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Поиск игрока' }), {
      target: { value: 'нет' },
    });
    expect(screen.getByText('Игроки не найдены.')).toBeInTheDocument();
  });
});
