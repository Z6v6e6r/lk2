// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import type { GameCard, GameCommandResult } from '@phub/api-sdk';
import { NativeSelfLeave, type NativeSelfLeaveGateway } from './NativeSelfLeave.js';
const id = '11111111-1111-4111-8111-111111111111',
  op = '22222222-2222-4222-8222-222222222222';
const game = { id, allowedActions: ['LEAVE'], viewerRelation: 'PARTICIPANT' } as GameCard;
const scope = { tenantId: 'tenant', userId: 'actor' };
const receipt = {
  commandId: op,
  operation: {
    id: op,
    type: 'LEAVE_GAME',
    gameId: id,
    status: 'UNKNOWN',
    nextAction: { type: 'WAIT_FOR_RECONCILIATION', retryAfterSeconds: 15 },
  },
  game: null,
  replayed: true,
} as GameCommandResult;
function gateway() {
  return {
    principal: (): string | null => 'original',
    leaveGame: vi.fn<NativeSelfLeaveGateway['leaveGame']>().mockResolvedValue(receipt),
    getManagedLeaveOperation: vi
      .fn<NonNullable<NativeSelfLeaveGateway['getManagedLeaveOperation']>>()
      .mockResolvedValue(receipt),
    reconcileManagedLeaveOperation: vi
      .fn<NonNullable<NativeSelfLeaveGateway['reconcileManagedLeaveOperation']>>()
      .mockResolvedValue(receipt),
  };
}
beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_n: unknown, _o: unknown, fn: () => unknown) => await fn() },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('real view retains original key after lost ACK/reload and uses only GET then explicit reconcile', async () => {
  const g = gateway();
  g.leaveGame.mockRejectedValueOnce(new TypeError('lost'));
  render(<NativeSelfLeave game={game} gateway={g} scope={scope} />);
  fireEvent.click(screen.getByRole('button', { name: 'Выйти из игры' }));
  await screen.findByRole('button', { name: 'Проверить выход' });
  const key = g.leaveGame.mock.calls[0]![1]!.idempotencyKey;
  cleanup();
  render(<NativeSelfLeave game={game} gateway={g} scope={scope} />);
  await waitFor(() => expect(g.getManagedLeaveOperation).toHaveBeenCalledWith(id, key));
  expect(g.leaveGame).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Повторить исходный запрос выхода' }));
  await waitFor(() => expect(g.reconcileManagedLeaveOperation).toHaveBeenCalledWith(id, key));
  expect(g.leaveGame).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/Оплатить|Лист ожидания/)).toBeNull();
});
it('missing locks and waitlist membership cannot issue a new departure', () => {
  const g = gateway();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  render(<NativeSelfLeave game={game} gateway={g} scope={scope} />);
  expect(screen.getByRole('button', { name: 'Выйти из игры' }).hasAttribute('disabled')).toBe(true);
  cleanup();
  render(
    <NativeSelfLeave game={{ ...game, viewerRelation: 'WAITLISTED' }} gateway={g} scope={scope} />,
  );
  expect(screen.queryByRole('button', { name: 'Выйти из игры' })).toBeNull();
  expect(g.leaveGame).not.toHaveBeenCalled();
});
it('account closing after render blocks dispatch', () => {
  const g = gateway();
  let principal: string | null = 'original';
  g.principal = () => principal;
  render(<NativeSelfLeave game={game} gateway={g} scope={scope} />);
  principal = null;
  fireEvent.click(screen.getByRole('button', { name: 'Выйти из игры' }));
  expect(g.leaveGame).not.toHaveBeenCalled();
});
