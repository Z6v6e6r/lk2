// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { GameCommandResult } from './auth-gateway.js';
import { GameCreationOperation } from './GameCreationOperation.js';
import { isCreateGameOperation } from './create-game-attempt.js';

afterEach(cleanup);
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const result = {
  commandId: id,
  operation: {
    id,
    type: 'CREATE_GAME',
    status: 'SUCCEEDED',
    gameId: id,
    aggregateRevision: 1,
    createdAt: '2027-01-01T12:00:00Z',
    updatedAt: '2027-01-01T12:00:00Z',
    nextAction: { type: 'NONE' },
    error: null,
  },
  game: null,
  replayed: false,
} as const satisfies GameCommandResult;

describe('beta creation operation rendering and response boundary', () => {
  it.each(['ACCEPTED', 'PROCESSING', 'FAILED', 'UNKNOWN'] as const)(
    'renders %s without booking success',
    (status) => {
      render(<GameCreationOperation status={status} />);
      expect(screen.getByRole('status')).toHaveTextContent(/бронь корта не подтверждена/i);
    },
  );

  it('accepts only the matching create operation with explicit terminal success', () => {
    expect(isCreateGameOperation(result, id)).toBe(true);
    const changes = [
      { type: 'JOIN_GAME' },
      { id: [id] },
      { gameId: [id] },
      { gameId: { toString: () => id } },
      { status: 'UNRECOGNIZED' },
      { gameId: null },
      { aggregateRevision: null },
      { aggregateRevision: 0 },
      { error: { code: 'GAME_NOT_FOUND', message: 'bad' } },
      {
        nextAction: {
          type: 'OPEN_PAYMENT',
          url: 'https://example.test',
          expiresAt: '2027-01-01T12:05:00Z',
        },
      },
    ];
    for (const change of changes) {
      expect(
        isCreateGameOperation({
          ...result,
          operation: { ...result.operation, ...change },
        } as GameCommandResult),
      ).toBe(false);
    }
    const sharedArrayId = [id];
    expect(
      isCreateGameOperation({
        ...result,
        commandId: sharedArrayId,
        operation: { ...result.operation, id: sharedArrayId },
      } as unknown as GameCommandResult),
    ).toBe(false);
    expect(isCreateGameOperation(result, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toBe(false);
    expect(
      isCreateGameOperation({ ...result, commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    ).toBe(false);
  });
});
