// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { GameCard } from '@phub/api-sdk';
import { IOSGameCancel } from './IOSGameCancel.js';
import { game, fixtureReply, nativeResult, syntheticSession } from './testing/cabinet-fixtures.js';
import type { IOSSessionPlugin } from './session.js';
const owned: GameCard = {
  ...game,
  viewerRelation: 'ORGANIZER',
  capacity: { ...game.capacity, total: 4 },
  participants: [],
  levelRange: game.levelRange ?? null,
  priceSummary: game.priceSummary ?? null,
  conversation: null,
  resultSummary: null,
  allowedActions: ['OPEN_DETAILS', 'CANCEL'],
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe('iOS local cancellation', () => {
  it.each(['CANCELLED', 'ONE_SPOT_LEFT'] as const)(
    'resolves ambiguous ACK only through GET: %s',
    async (displayState) => {
      const keys: string[] = [];
      let reads = 0;
      const request = vi.fn<IOSSessionPlugin['request']>(async (input) => {
        if (input.operation === 'gameCancel') {
          keys.push(input.headers['Idempotency-Key']!);
          throw Object.assign(new Error('Synthetic network unavailable'), {
            code: 'NATIVE_NETWORK_UNAVAILABLE',
          });
        }
        if (input.operation === 'read' && input.resource === 'game') {
          reads++;
          return nativeResult({
            game: {
              ...owned,
              displayState,
              allowedActions:
                displayState === 'CANCELLED' ? ['OPEN_DETAILS'] : owned.allowedActions,
            },
          });
        }
        return await Promise.resolve(fixtureReply(input));
      });
      const session = syntheticSession(request);
      await session.restore();
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(<IOSGameCancel game={owned} session={session} />);
      fireEvent.click(screen.getByRole('button', { name: 'Отменить игру' }));
      await waitFor(() => expect(reads).toBe(1));
      expect(await screen.findByRole('status')).toHaveTextContent(
        displayState === 'CANCELLED' ? 'Игра отменена.' : 'Отмена пока не подтверждена.',
      );
      expect(keys).toHaveLength(1);
      expect(new Set(keys).size).toBe(1); // Native cancellation is attempted once; ambiguous ACK uses GET.
      fireEvent.click(screen.getByRole('button', { name: 'Обновить статус игры' }));
      await waitFor(() => expect(reads).toBe(2));
      expect(keys).toHaveLength(1);
    },
  );
  it('coalesces double click and drops late ACK on synchronous logout', async () => {
    let complete!: (value: ReturnType<typeof nativeResult>) => void;
    let finishLogout!: (value: ReturnType<typeof nativeResult>) => void;
    const pending = new Promise<ReturnType<typeof nativeResult>>((r) => {
      complete = r;
    });
    const logoutPending = new Promise<ReturnType<typeof nativeResult>>((r) => {
      finishLogout = r;
    });
    let commands = 0,
      reads = 0;
    const session = syntheticSession(async (input) => {
      if (input.operation === 'gameCancel') {
        commands++;
        return await pending;
      }
      if (input.operation === 'logout') return await logoutPending;
      if (input.operation === 'read' && input.resource === 'game') reads++;
      return await Promise.resolve(fixtureReply(input));
    });
    await session.restore();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<IOSGameCancel game={owned} session={session} />);
    fireEvent.click(screen.getByRole('button', { name: 'Отменить игру' }));
    fireEvent.click(screen.getByRole('button', { name: 'Отменить игру' }));
    await waitFor(() => expect(commands).toBe(1));
    const logout = session.logout();
    expect(session.gameCancelPrincipal()).toBeNull();
    await act(async () => {
      complete(nativeResult({}, 202));
      await pending;
    });
    await expect(session.cancelGame(owned.id)).rejects.toThrow();
    expect(reads).toBe(0);
    expect(commands).toBe(1);
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => {
      finishLogout(nativeResult(null, 204));
      await logout;
    });
  });
  it('does not infer cancellation capability from zero price or organizer alone', async () => {
    const session = syntheticSession();
    await session.restore();
    render(
      <IOSGameCancel
        game={{
          ...owned,
          priceSummary: { amountMinor: 0, currency: 'RUB' },
          allowedActions: ['OPEN_DETAILS'],
        }}
        session={session}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Отменить игру' })).toBeNull();
  });
});

it('drains the old SDK invocation before relogin; original retry cannot bind the new session', async () => {
  let failFirst!: (e: unknown) => void;
  const pending = new Promise<ReturnType<typeof nativeResult>>((_, j) => {
    failFirst = j;
  });
  let commands = 0;
  const session = syntheticSession(async (input) => {
    if (input.operation === 'gameCancel') {
      commands++;
      return await pending;
    }
    return await Promise.resolve(fixtureReply(input));
  });
  await session.restore();
  const original = session.gameCancelPrincipal();
  const cancel = session.cancelGame(owned.id).then(
    () => 'accepted',
    () => 'discarded',
  );
  await waitFor(() => expect(commands).toBe(1));
  const logout = session.logout();
  await expect(session.verify('22222222-2222-4222-8222-222222222222', '1234')).rejects.toThrow();
  failFirst({ code: 'NATIVE_NETWORK_UNAVAILABLE' });
  expect(await cancel).toBe('discarded');
  await logout;
  await session.verify('22222222-2222-4222-8222-222222222222', '1234');
  expect(session.gameCancelPrincipal()).not.toBe(original);
  expect(session.canDispatchGameCancellation(owned.id)).toBe(false);
  expect(commands).toBe(1);
});

it('refreshes a read-only game without suggesting a cancellation attempt', async () => {
  let commands = 0;
  const ordinary = {
    ...owned,
    viewerRelation: 'NONE' as const,
    allowedActions: ['OPEN_DETAILS' as const],
  };
  const session = syntheticSession(async (input) => {
    if (input.operation === 'gameCancel') commands++;
    if (input.operation === 'read' && input.resource === 'game')
      return nativeResult({ game: ordinary });
    return await Promise.resolve(fixtureReply(input));
  });
  await session.restore();
  render(<IOSGameCancel game={ordinary} session={session} />);
  fireEvent.click(screen.getByRole('button', { name: 'Обновить статус игры' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Статус игры обновлён.');
  expect(screen.queryByText(/Отмена.*не подтверждена/)).toBeNull();
  expect(commands).toBe(0);
});
