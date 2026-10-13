// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateGamePage } from './CreateGamePage.js';
import type { AuthGateway } from './auth-gateway.js';
import {
  bindCreateGameOperation,
  createGameAttemptStorageKey,
  loadCreateGameAttemptLedger,
  prepareCreateGameAttempt,
  type CreateGameAttemptLockManager,
} from './create-game-attempt.js';

const stationId = '11111111-1111-4111-8111-111111111111';
const gameId = '751fe6a8-b0b1-4b2b-873d-a2d785c4e191';
const operationId = 'c3889c99-b0e3-4a3d-b3e8-a5c99af730ea';
const principal = {
  tenantId: '22222222-2222-4222-8222-222222222222',
  userId: '33333333-3333-4333-8333-333333333333',
};
const locks: CreateGameAttemptLockManager = { request: (_n, _o, fn) => Promise.resolve().then(fn) };
const payload = {
  title: 'Исходная игра',
  kind: 'FRIENDLY',
  visibility: 'PUBLIC',
  stationId,
  startsAt: '2027-08-15T15:00:00Z',
  endsAt: '2027-08-15T16:30:00Z',
  timezone: 'Europe/Moscow',
  capacity: 4,
  levelRange: null,
  paymentMode: 'NO_PAYMENT',
  waitlistEnabled: true,
} as const;
function result(status: 'SUCCEEDED' | 'ACCEPTED' | 'PROCESSING' | 'FAILED' = 'SUCCEEDED') {
  return {
    commandId: operationId,
    operation: {
      id: operationId,
      type: 'CREATE_GAME',
      status,
      gameId,
      aggregateRevision: 1,
      createdAt: '2026-10-13T10:00:00Z',
      updatedAt: '2026-10-13T10:00:00Z',
      nextAction: { type: 'NONE' },
      error: null,
    },
    game: null,
    replayed: true,
    recovery: { paymentMode: 'NO_PAYMENT' },
  } as const;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function api() {
  return {
    listLocations: vi
      .fn()
      .mockResolvedValue({ items: [{ id: stationId, title: 'Синтетическая станция' }] }),
    createGame: vi.fn<AuthGateway['createGame']>().mockResolvedValue(result()),
    getGameCreateOperation: vi
      .fn<NonNullable<AuthGateway['getGameCreateOperation']>>()
      .mockResolvedValue(result()),
  };
}
function page(gateway = api(), navigate = vi.fn()) {
  const props = {
    gateway: gateway as unknown as AuthGateway,
    principal,
    attemptStorage: window.localStorage,
    attemptLockManager: locks,
    navigate,
  };
  return { ...render(<CreateGamePage {...props} />), gateway, navigate, props };
}
async function saved(bound = false) {
  const attempt = await prepareCreateGameAttempt(principal, payload, window.localStorage, locks, {
    createAttemptId: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    createIdempotencyKey: () => 'synthetic-p2-original-key-0001',
  });
  if (attempt.state !== 'PENDING') throw new Error('pending required');
  return bound
    ? bindCreateGameOperation(principal, attempt, operationId, window.localStorage, locks, gameId)
    : attempt;
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/games/new');
});

describe('same-operation CREATE recovery on the actual page', () => {
  it('records one key before CREATE, then requires the canonical GET before opening the same game', async () => {
    const gateway = api();
    const read = deferred<ReturnType<typeof result>>();
    gateway.getGameCreateOperation.mockReturnValue(read.promise);
    const { navigate } = page(gateway);
    await screen.findByRole('option', { name: 'Синтетическая станция' });
    await userEvent.click(screen.getByRole('button', { name: 'Создать игру' }));
    await waitFor(() => expect(gateway.getGameCreateOperation).toHaveBeenCalledTimes(1));
    const key = gateway.createGame.mock.calls[0]![1]!.idempotencyKey;
    expect(loadCreateGameAttemptLedger(principal, window.localStorage).activeAttempt).toMatchObject(
      { idempotencyKey: key, operationId, gameId },
    );
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => {
      read.resolve(result());
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(expect.stringContaining(`/games/${gameId}?created=1`)),
    );
    expect(gateway.createGame).toHaveBeenCalledTimes(1);
    expect(
      loadCreateGameAttemptLedger(principal, window.localStorage).resolvedAttempts[0],
    ).toMatchObject({ idempotencyKey: key, operationId, gameId });
  });
  it('loses the accepted POST response, reloads and reopens by the same key with CREATE count still one', async () => {
    const gateway = api();
    gateway.createGame.mockRejectedValueOnce(new TypeError('accepted response lost'));
    const first = page(gateway);
    await screen.findByRole('option', { name: 'Синтетическая станция' });
    await userEvent.click(screen.getByRole('button', { name: 'Создать игру' }));
    await screen.findByText(/Связь прервалась/);
    const original = loadCreateGameAttemptLedger(principal, window.localStorage).activeAttempt!;
    expect(original.operationId).toBeUndefined();
    first.unmount();
    const reopened = page(gateway);
    await waitFor(() => expect(reopened.navigate).toHaveBeenCalled());
    expect(gateway.getGameCreateOperation.mock.calls[0]![0]).toBe(original.idempotencyKey);
    reopened.unmount();
    page(gateway);
    await waitFor(() => expect(gateway.getGameCreateOperation).toHaveBeenCalledTimes(2));
    expect(gateway.createGame).toHaveBeenCalledTimes(1);
    expect(
      loadCreateGameAttemptLedger(principal, window.localStorage).resolvedAttempts[0],
    ).toMatchObject({
      attemptId: original.attemptId,
      idempotencyKey: original.idempotencyKey,
      payloadFingerprint: original.payloadFingerprint,
      operationId,
      gameId,
    });
  });
  it.each(['ACCEPTED', 'PROCESSING', 'FAILED'] as const)(
    'keeps %s and repeated checks read only, despite changed form fields',
    async (status) => {
      const original = await saved(true);
      const gateway = api();
      gateway.getGameCreateOperation.mockResolvedValue(result(status));
      page(gateway);
      await screen.findByRole('button', { name: 'Проверить прежнюю операцию' });
      await userEvent.clear(screen.getByRole('textbox', { name: 'Название' }));
      for (let n = 0; n < 2; n++) {
        await userEvent.click(
          await screen.findByRole('button', { name: 'Проверить прежнюю операцию' }),
        );
        await waitFor(() =>
          expect(screen.getByRole('button', { name: 'Проверить прежнюю операцию' })).toBeEnabled(),
        );
      }
      expect(gateway.createGame).not.toHaveBeenCalled();
      expect(gateway.getGameCreateOperation).toHaveBeenCalledTimes(3);
      expect(loadCreateGameAttemptLedger(principal, window.localStorage).activeAttempt).toEqual(
        original,
      );
      expect(screen.getByRole('status')).toHaveTextContent(status);
      expect(screen.getByRole('status')).toHaveTextContent('РасчётНеизвестно');
    },
  );
  it.each([
    'missing',
    'unavailable',
    'wrong-operation',
    'wrong-game',
    'untrusted-success',
  ] as const)('retains custody on %s without a new CREATE or false success', async (failure) => {
    const original = await saved(true);
    const gateway = api();
    if (failure === 'missing' || failure === 'unavailable')
      gateway.getGameCreateOperation.mockRejectedValue(
        Object.assign(new Error(failure), { status: failure === 'missing' ? 404 : 503 }),
      );
    else if (failure === 'untrusted-success')
      gateway.getGameCreateOperation.mockResolvedValue({
        ...result(),
        recovery: undefined,
      } as never);
    else
      gateway.getGameCreateOperation.mockResolvedValue({
        ...result(),
        operation: {
          ...result().operation,
          ...(failure === 'wrong-game' ? { gameId: stationId } : { id: stationId }),
        },
      });
    const { navigate } = page(gateway);
    await screen.findByRole('button', { name: 'Проверить прежнюю операцию' });
    await userEvent.click(screen.getByRole('button', { name: 'Проверить прежнюю операцию' }));
    expect(gateway.createGame).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(loadCreateGameAttemptLedger(principal, window.localStorage).activeAttempt).toEqual(
      original,
    );
    expect(screen.getByRole('status')).toHaveTextContent('UNKNOWN');
  });
  it('bounds waiting and ignores an old late success after a newer state read', async () => {
    await saved(true);
    const gateway = api();
    const late = deferred<ReturnType<typeof result>>();
    gateway.getGameCreateOperation
      .mockReturnValueOnce(late.promise)
      .mockResolvedValue(result('PROCESSING'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { navigate } = page(gateway);
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(8_001);
    });
    vi.useRealTimers();
    await screen.findByRole('button', { name: 'Проверить прежнюю операцию' });
    await userEvent.click(screen.getByRole('button', { name: 'Проверить прежнюю операцию' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('PROCESSING'));
    await screen.findByRole('button', { name: 'Проверить прежнюю операцию' });
    await act(async () => {
      late.resolve(result());
      await Promise.resolve();
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('PROCESSING');
    expect(gateway.createGame).not.toHaveBeenCalled();
  });
  it.each(['account', 'tenant', 'logout'] as const)(
    'ignores a delayed response after %s and never exposes the prior actor game',
    async (change) => {
      const original = await saved(true);
      const gateway = api();
      const late = deferred<ReturnType<typeof result>>();
      gateway.getGameCreateOperation
        .mockReturnValueOnce(late.promise)
        .mockRejectedValue(new Error('not found'));
      const view = page(gateway);
      await waitFor(() => expect(gateway.getGameCreateOperation).toHaveBeenCalledTimes(1));
      if (change === 'logout') view.unmount();
      else
        view.rerender(
          <CreateGamePage
            {...view.props}
            principal={{
              ...principal,
              ...(change === 'tenant' ? { tenantId: stationId } : { userId: stationId }),
            }}
          />,
        );
      await act(async () => {
        late.resolve(result());
        await Promise.resolve();
      });
      expect(view.navigate).not.toHaveBeenCalled();
      expect(gateway.createGame).not.toHaveBeenCalled();
      expect(loadCreateGameAttemptLedger(principal, window.localStorage).activeAttempt).toEqual(
        original,
      );
      expect(screen.queryByText(new RegExp(gameId))).not.toBeInTheDocument();
    },
  );
  it('fails closed on malformed storage and does not send a command', async () => {
    window.localStorage.setItem(createGameAttemptStorageKey(principal), 'malformed');
    const gateway = api();
    page(gateway);
    await screen.findByRole('option', { name: 'Синтетическая станция' });
    await userEvent.click(screen.getByRole('button', { name: 'Создать игру' }));
    expect(gateway.createGame).not.toHaveBeenCalled();
    expect(gateway.getGameCreateOperation).not.toHaveBeenCalled();
  });
});
