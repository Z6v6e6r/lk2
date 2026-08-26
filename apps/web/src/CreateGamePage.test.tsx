// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CreateGamePage } from './CreateGamePage.js';
import type { AuthGateway, GameCommandResult } from './auth-gateway.js';

const stationId = '11111111-1111-4111-8111-111111111111';
const gameId = '751fe6a8-b0b1-4b2b-873d-a2d785c4e191';

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function result(): GameCommandResult {
  const committedAt = '2026-08-26T10:00:00.000Z';
  return {
    commandId: 'c3889c99-b0e3-4a3d-b3e8-a5c99af730ea',
    operation: {
      id: 'c3889c99-b0e3-4a3d-b3e8-a5c99af730ea',
      type: 'CREATE_GAME',
      status: 'SUCCEEDED',
      gameId,
      aggregateRevision: 1,
      createdAt: committedAt,
      updatedAt: committedAt,
      nextAction: { type: 'NONE' },
      error: null,
    },
    game: null,
    replayed: false,
  };
}

function gateway(createGame: AuthGateway['createGame']): AuthGateway {
  return {
    listLocations: vi.fn().mockResolvedValue({
      items: [
        {
          id: stationId,
          title: 'Селигерская',
          city: 'Москва',
          courtCount: 3,
          coverImageUrl: null,
          route: `/locations/${stationId}`,
        },
      ],
    }),
    createGame,
  } as unknown as AuthGateway;
}

afterEach(() => cleanup());

describe('CreateGamePage', () => {
  it('submits the existing free-game contract once and opens the created detail', async () => {
    const command = deferred<GameCommandResult>();
    const createGame = vi.fn<AuthGateway['createGame']>().mockReturnValue(command.promise);
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<CreateGamePage gateway={gateway(createGame)} navigate={navigate} />);

    await screen.findByRole('option', { name: 'Селигерская' });
    const submit = screen.getByRole('button', { name: 'Создать игру' });
    await user.dblClick(submit);

    expect(createGame).toHaveBeenCalledOnce();
    expect(submit).toBeDisabled();
    expect(createGame).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Открытая игра',
        kind: 'FRIENDLY',
        visibility: 'PUBLIC',
        stationId,
        capacity: 4,
        paymentMode: 'NO_PAYMENT',
        waitlistEnabled: true,
        levelRange: null,
      }),
    );

    command.resolve(result());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/games/${gameId}?created=1`));
  });

  it('keeps invalid level bounds local and does not send a command', async () => {
    const createGame = vi.fn<AuthGateway['createGame']>();
    const user = userEvent.setup();
    render(<CreateGamePage gateway={gateway(createGame)} navigate={vi.fn()} />);

    await screen.findByRole('option', { name: 'Селигерская' });
    const levelSelectors = screen.getAllByRole('combobox');
    await user.selectOptions(levelSelectors[3]!, 'B');
    await user.selectOptions(levelSelectors[4]!, 'C');
    await user.click(screen.getByRole('button', { name: 'Создать игру' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Начальный уровень не может быть выше конечного.',
    );
    expect(createGame).not.toHaveBeenCalled();
  });

  it('keeps a stable server error visible and enables a safe retry', async () => {
    const createGame = vi
      .fn<AuthGateway['createGame']>()
      .mockRejectedValue(Object.assign(new Error('invalid'), { code: 'INVALID_REQUEST' }));
    const user = userEvent.setup();
    render(<CreateGamePage gateway={gateway(createGame)} navigate={vi.fn()} />);

    await screen.findByRole('option', { name: 'Селигерская' });
    await user.click(screen.getByRole('button', { name: 'Создать игру' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Проверьте обязательные поля и время игры.',
    );
    expect(screen.getByRole('button', { name: 'Создать игру' })).toBeEnabled();
  });
});
