// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { GameScoreSummary } from './GameScoreSummary.js';
import type { GameCard } from './auth-gateway.js';

const PLAYERS = [
  ['f75b4e2a-9c98-4b26-85b6-ae58e0edca24', 'Анна Первая'],
  ['a9c106f7-0db8-4e27-b1e0-298829f94730', 'Борис Второй'],
  ['6a758cce-23ab-4ffd-9c57-a1bc5d4aab70', 'Вера Третья'],
  ['c68f263e-4a54-4472-9254-103e3b332538', 'Глеб Четвёртый'],
] as const;

const participants: GameCard['participants'] = PLAYERS.map(([userId, displayName], index) => ({
  userId,
  displayName,
  avatarUrl: null,
  level: 'C',
  levelValue: 3.44 + index / 10,
  role: index === 0 ? 'ORGANIZER' : 'PLAYER',
}));

afterEach(() => cleanup());

describe('GameScoreSummary', () => {
  it('shows two pair rows while the partners stay together', () => {
    render(
      <GameScoreSummary
        participants={participants}
        sets={[
          {
            teamAUserIds: [PLAYERS[0][0], PLAYERS[1][0]],
            teamBUserIds: [PLAYERS[2][0], PLAYERS[3][0]],
            teamA: 6,
            teamB: 4,
          },
          {
            teamAUserIds: [PLAYERS[2][0], PLAYERS[3][0]],
            teamBUserIds: [PLAYERS[0][0], PLAYERS[1][0]],
            teamA: 2,
            teamB: 6,
          },
        ]}
      />,
    );

    const summary = screen.getByRole('region', { name: 'Сводка по парам' });
    expect(within(summary).getAllByRole('row')).toHaveLength(2);
    const firstPair = within(summary).getByRole('rowheader', {
      name: 'Анна Первая, Борис Второй',
    });
    expect(firstPair).toHaveTextContent('Анна');
    expect(firstPair).toHaveTextContent('Борис');
    const playerAvatars = within(summary).getAllByRole('img', { hidden: true });
    expect(playerAvatars).toHaveLength(4);
    expect(playerAvatars[0]).toHaveAttribute('data-size', '40');
    expect(playerAvatars[0]).toHaveAttribute('data-progress', '44');
    expect(playerAvatars[0]).toHaveTextContent('C');
    expect(within(summary).getByRole('cell', { name: 'Выиграно сетов: 2' })).toHaveTextContent('2');
  });

  it('switches to four personal rows after partners change', () => {
    render(
      <GameScoreSummary
        participants={participants}
        sets={[
          {
            teamAUserIds: [PLAYERS[0][0], PLAYERS[1][0]],
            teamBUserIds: [PLAYERS[2][0], PLAYERS[3][0]],
            teamA: 6,
            teamB: 4,
          },
          {
            teamAUserIds: [PLAYERS[0][0], PLAYERS[2][0]],
            teamBUserIds: [PLAYERS[1][0], PLAYERS[3][0]],
            teamA: 6,
            teamB: 3,
          },
        ]}
      />,
    );

    const summary = screen.getByRole('region', { name: 'Личная сводка игроков' });
    const personalRows = within(summary).getAllByRole('row');
    expect(personalRows).toHaveLength(4);
    expect(
      personalRows.map((row) => within(row).getByRole('rowheader').getAttribute('aria-label')),
    ).toEqual(['Анна Первая', 'Вера Третья', 'Борис Второй', 'Глеб Четвёртый']);
    const annaRow = within(summary).getByRole('rowheader', { name: 'Анна Первая' }).parentElement;
    const borisRow = within(summary).getByRole('rowheader', { name: 'Борис Второй' }).parentElement;
    expect(annaRow).not.toBeNull();
    expect(borisRow).not.toBeNull();
    expect(within(annaRow!).getByRole('cell', { name: 'Счёт по сетам' })).toHaveTextContent('66');
    expect(within(annaRow!).getByRole('cell', { name: 'Выиграно сетов: 2' })).toHaveTextContent(
      '2',
    );
    expect(within(borisRow!).getByRole('cell', { name: 'Счёт по сетам' })).toHaveTextContent('63');
    expect(within(borisRow!).getByRole('cell', { name: 'Выиграно сетов: 1' })).toHaveTextContent(
      '1',
    );
  });
});
