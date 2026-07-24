import { describe, expect, it } from 'vitest';

import { submitGameResultInputSchema } from './index.js';

const PLAYERS = [
  'f75b4e2a-9c98-4b26-85b6-ae58e0edca24',
  'a9c106f7-0db8-4e27-b1e0-298829f94730',
  '6a758cce-23ab-4ffd-9c57-a1bc5d4aab70',
  'c68f263e-4a54-4472-9254-103e3b332538',
] as const;

describe('game result command contract', () => {
  it('allows partners to change between sets while preserving the game roster', () => {
    const parsed = submitGameResultInputSchema.safeParse({
      sets: [
        {
          setNumber: 1,
          teamAUserIds: [PLAYERS[0], PLAYERS[1]],
          teamBUserIds: [PLAYERS[2], PLAYERS[3]],
          teamA: 6,
          teamB: 4,
        },
        {
          setNumber: 2,
          teamAUserIds: [PLAYERS[0], PLAYERS[2]],
          teamBUserIds: [PLAYERS[1], PLAYERS[3]],
          teamA: 3,
          teamB: 6,
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects duplicated players, draws and roster changes', () => {
    const duplicated = submitGameResultInputSchema.safeParse({
      sets: [
        {
          setNumber: 1,
          teamAUserIds: [PLAYERS[0], PLAYERS[0]],
          teamBUserIds: [PLAYERS[2], PLAYERS[3]],
          teamA: 6,
          teamB: 6,
        },
      ],
    });
    const changedRoster = submitGameResultInputSchema.safeParse({
      sets: [
        {
          setNumber: 1,
          teamAUserIds: [PLAYERS[0], PLAYERS[1]],
          teamBUserIds: [PLAYERS[2], PLAYERS[3]],
          teamA: 6,
          teamB: 4,
        },
        {
          setNumber: 2,
          teamAUserIds: [PLAYERS[0], PLAYERS[1]],
          teamBUserIds: [PLAYERS[2], '640a3ae4-ef3b-4789-b6a0-2905bca1e523'],
          teamA: 6,
          teamB: 2,
        },
      ],
    });

    expect(duplicated.success).toBe(false);
    expect(changedRoster.success).toBe(false);
  });
});
