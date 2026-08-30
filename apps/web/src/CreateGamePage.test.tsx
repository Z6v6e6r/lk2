// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CreateGamePage } from './CreateGamePage.js';
import type { AuthGateway, GameCommandResult } from './auth-gateway.js';
import {
  createGameAttemptStorageKey,
  loadCreateGameAttemptLedger,
  prepareCreateGameAttempt,
  resolveCreateGameAttempt,
  type CreateGameAttemptLockManager,
  type CreateGameAttemptPrincipal,
} from './create-game-attempt.js';

const stationId = '11111111-1111-4111-8111-111111111111';
const gameId = '751fe6a8-b0b1-4b2b-873d-a2d785c4e191';
const principal = {
  tenantId: '22222222-2222-4222-8222-222222222222',
  userId: '33333333-3333-4333-8333-333333333333',
};

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

function result(overrides: Partial<GameCommandResult> = {}): GameCommandResult {
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
    ...overrides,
  };
}

function gateway(
  createGame: AuthGateway['createGame'],
  station = { id: stationId, title: 'Селигерская' },
): AuthGateway {
  return {
    listLocations: vi.fn().mockResolvedValue({
      items: [
        {
          ...station,
          city: 'Москва',
          courtCount: 3,
          coverImageUrl: null,
          route: `/locations/${station.id}`,
        },
      ],
    }),
    createGame,
  } as unknown as AuthGateway;
}

function locks(): CreateGameAttemptLockManager {
  return {
    request: (_name, _options, callback) => Promise.resolve().then(callback),
  };
}

function savedPayload(title = 'Открытая игра') {
  return {
    title,
    kind: 'FRIENDLY' as const,
    visibility: 'PUBLIC' as const,
    stationId,
    startsAt: '2027-08-15T15:00:00.000Z',
    endsAt: '2027-08-15T16:30:00.000Z',
    timezone: 'Europe/Moscow',
    capacity: 4 as const,
    levelRange: null,
    paymentMode: 'NO_PAYMENT' as const,
    waitlistEnabled: true,
  };
}

function page(
  createGame: AuthGateway['createGame'],
  options: {
    readonly navigate?: (url: string) => void;
    readonly currentPrincipal?: CreateGameAttemptPrincipal;
    readonly api?: AuthGateway;
  } = {},
) {
  return render(
    <CreateGamePage
      gateway={options.api ?? gateway(createGame)}
      principal={options.currentPrincipal ?? principal}
      attemptStorage={window.localStorage}
      attemptLockManager={locks()}
      navigate={options.navigate ?? vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/games/new');
});

describe('CreateGamePage durable create recovery', () => {
  it('submits once, resolves the attempt and opens a normally created game', async () => {
    const command = deferred<GameCommandResult>();
    const createGame = vi.fn<AuthGateway['createGame']>().mockReturnValue(command.promise);
    const navigate = vi.fn();
    const user = userEvent.setup();
    page(createGame, { navigate });

    await screen.findByRole('option', { name: 'Селигерская' });
    const submit = screen.getByRole('button', { name: 'Создать игру' });
    await user.dblClick(submit);

    expect(createGame).toHaveBeenCalledOnce();
    expect(submit).toBeDisabled();
    expect(createGame.mock.calls[0]?.[0]).toMatchObject({
      title: 'Открытая игра',
      kind: 'FRIENDLY',
      visibility: 'PUBLIC',
      stationId,
      capacity: 4,
      paymentMode: 'NO_PAYMENT',
      waitlistEnabled: true,
      levelRange: null,
    });
    expect(createGame.mock.calls[0]?.[1]?.idempotencyKey).toMatch(/\S+/);

    command.resolve(result());
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(`/games/${gameId}?created=1&revision=1`),
    );
    const ledger = loadCreateGameAttemptLedger(principal, window.localStorage);
    expect(ledger.activeAttempt).toBeUndefined();
    expect(ledger.resolvedAttempts).toMatchObject([
      { state: 'RESOLVED', gameId, idempotencyKey: createGame.mock.calls[0]?.[1]?.idempotencyKey },
    ]);
    expect(window.localStorage.getItem(createGameAttemptStorageKey(principal))).not.toContain(
      '"payload":',
    );
  });

  it('retains one key after lost responses and uses it for manual replay recovery', async () => {
    const createGame = vi
      .fn<AuthGateway['createGame']>()
      .mockRejectedValueOnce(new TypeError('response lost'))
      .mockResolvedValueOnce(result({ replayed: true }));
    const navigate = vi.fn();
    const user = userEvent.setup();
    page(createGame, { navigate });

    await screen.findByRole('option', { name: 'Селигерская' });
    await user.click(screen.getByRole('button', { name: 'Создать игру' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('результат неизвестен');
    const firstKey = createGame.mock.calls[0]?.[1]?.idempotencyKey;
    expect(firstKey).toBeTruthy();
    expect(window.localStorage.getItem(createGameAttemptStorageKey(principal))).toContain(firstKey);

    await user.click(screen.getByRole('button', { name: 'Создать игру' }));
    await waitFor(() => expect(createGame).toHaveBeenCalledTimes(2));
    expect(createGame.mock.calls[1]?.[1]?.idempotencyKey).toBe(firstKey);
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(`/games/${gameId}?created=1&revision=1&recovered=1`),
    );
    const ledger = loadCreateGameAttemptLedger(principal, window.localStorage);
    expect(ledger.activeAttempt).toBeUndefined();
    expect(ledger.resolvedAttempts).toMatchObject([{ gameId, idempotencyKey: firstKey }]);
  });

  it('does not allocate K2 when another tab resolves mounted K1 before manual retry', async () => {
    const pending = await prepareCreateGameAttempt(
      principal,
      savedPayload(),
      window.localStorage,
      locks(),
      {
        createAttemptId: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        createIdempotencyKey: () => 'create-logical-attempt-key-0001',
      },
    );
    expect(pending.state).toBe('PENDING');
    if (pending.state !== 'PENDING') throw new Error('expected pending attempt');
    const createGame = vi
      .fn<AuthGateway['createGame']>()
      .mockRejectedValue(new TypeError('response lost'));
    const navigate = vi.fn();
    const user = userEvent.setup();
    page(createGame, { navigate });

    await screen.findByRole('option', { name: 'Селигерская' });
    await user.click(screen.getByRole('button', { name: 'Создать игру' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('результат неизвестен');
    expect(createGame).toHaveBeenCalledOnce();

    await resolveCreateGameAttempt(principal, pending, gameId, window.localStorage, locks());
    await user.click(screen.getByRole('button', { name: 'Создать игру' }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(`/games/${gameId}?created=1&recovered=1`),
    );
    expect(createGame).toHaveBeenCalledOnce();
    const ledger = loadCreateGameAttemptLedger(principal, window.localStorage);
    expect(ledger.activeAttempt).toBeUndefined();
    expect(ledger.resolvedAttempts).toMatchObject([
      { gameId, idempotencyKey: 'create-logical-attempt-key-0001' },
    ]);
  });

  it('reopens a resolved direct route at G1 without sending another create command', async () => {
    const pending = await prepareCreateGameAttempt(
      principal,
      savedPayload(),
      window.localStorage,
      locks(),
      {
        createAttemptId: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        createIdempotencyKey: () => 'create-logical-attempt-key-0001',
      },
    );
    if (pending.state !== 'PENDING') throw new Error('expected pending attempt');
    await resolveCreateGameAttempt(principal, pending, gameId, window.localStorage, locks());
    const createGame = vi.fn<AuthGateway['createGame']>();
    const navigate = vi.fn();

    page(createGame, { navigate });

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(`/games/${gameId}?created=1&recovered=1`),
    );
    expect(createGame).not.toHaveBeenCalled();
  });

  it('allocates K2 only for an explicit new intent and preserves resolved K1', async () => {
    const pending = await prepareCreateGameAttempt(
      principal,
      savedPayload(),
      window.localStorage,
      locks(),
      {
        createAttemptId: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        createIdempotencyKey: () => 'create-logical-attempt-key-0001',
      },
    );
    if (pending.state !== 'PENDING') throw new Error('expected pending attempt');
    await resolveCreateGameAttempt(principal, pending, gameId, window.localStorage, locks());
    window.history.replaceState({}, '', '/games/new?new=1');
    const secondGameId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const createGame = vi
      .fn<AuthGateway['createGame']>()
      .mockResolvedValue(result({ operation: { ...result().operation, gameId: secondGameId } }));
    const navigate = vi.fn();
    const user = userEvent.setup();
    page(createGame, { navigate });

    await screen.findByRole('option', { name: 'Селигерская' });
    await user.click(screen.getByRole('button', { name: 'Создать игру' }));
    await waitFor(() => expect(createGame).toHaveBeenCalledOnce());

    const secondKey = createGame.mock.calls[0]?.[1]?.idempotencyKey;
    expect(secondKey).toBeTruthy();
    expect(secondKey).not.toBe(pending.idempotencyKey);
    expect(loadCreateGameAttemptLedger(principal, window.localStorage).resolvedAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gameId, idempotencyKey: pending.idempotencyKey }),
        expect.objectContaining({ gameId: secondGameId, idempotencyKey: secondKey }),
      ]),
    );
    expect(window.location.pathname + window.location.search).toBe('/games/new');
  });

  it('consumes the real new-link intent so reload converges to cross-tab resolved K1', async () => {
    window.history.replaceState({}, '', '/games/new?new=1');
    const createGame = vi
      .fn<AuthGateway['createGame']>()
      .mockRejectedValue(new TypeError('response lost'));
    const firstNavigate = vi.fn();
    const user = userEvent.setup();
    const firstTab = page(createGame, { navigate: firstNavigate });

    await screen.findByRole('option', { name: 'Селигерская' });
    await waitFor(() =>
      expect(window.location.pathname + window.location.search).toBe('/games/new'),
    );
    await user.click(screen.getByRole('button', { name: 'Создать игру' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('результат неизвестен');
    const pending = loadCreateGameAttemptLedger(principal, window.localStorage).activeAttempt;
    expect(pending).toBeDefined();
    firstTab.unmount();
    if (!pending) throw new Error('expected pending attempt');

    await resolveCreateGameAttempt(principal, pending, gameId, window.localStorage, locks());
    const reloadNavigate = vi.fn();
    page(createGame, { navigate: reloadNavigate });

    await waitFor(() =>
      expect(reloadNavigate).toHaveBeenCalledWith(`/games/${gameId}?created=1&recovered=1`),
    );
    expect(createGame).toHaveBeenCalledOnce();
    expect(
      loadCreateGameAttemptLedger(principal, window.localStorage).activeAttempt,
    ).toBeUndefined();
  });

  it('restores exact fields and key after unmount plus tab-close style reopen', async () => {
    const createGame = vi
      .fn<AuthGateway['createGame']>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(result({ replayed: true }));
    const user = userEvent.setup();
    const first = page(createGame);

    await screen.findByRole('option', { name: 'Селигерская' });
    await user.clear(screen.getByLabelText('Название'));
    await user.type(screen.getByLabelText('Название'), 'Восстановим меня');
    await user.click(screen.getByRole('button', { name: 'Создать игру' }));
    await screen.findByRole('alert');
    const firstKey = createGame.mock.calls[0]?.[1]?.idempotencyKey;
    first.unmount();

    const navigate = vi.fn();
    page(createGame, { navigate });
    expect(await screen.findByDisplayValue('Восстановим меня')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Найдена незавершённая попытка');
    await user.click(screen.getByRole('button', { name: 'Создать игру' }));

    await waitFor(() => expect(createGame).toHaveBeenCalledTimes(2));
    expect(createGame.mock.calls[1]?.[1]?.idempotencyKey).toBe(firstKey);
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  });

  it('blocks changed payload while an unresolved attempt exists', async () => {
    const createGame = vi
      .fn<AuthGateway['createGame']>()
      .mockRejectedValue(new TypeError('offline'));
    const user = userEvent.setup();
    page(createGame);

    await screen.findByRole('option', { name: 'Селигерская' });
    await user.click(screen.getByRole('button', { name: 'Создать игру' }));
    await screen.findByText(/результат неизвестен/);
    await user.clear(screen.getByLabelText('Название'));
    await user.type(screen.getByLabelText('Название'), 'Другой замысел');
    await user.click(screen.getByRole('button', { name: 'Создать игру' }));

    expect(createGame).toHaveBeenCalledOnce();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Есть незавершённая попытка с другими параметрами',
    );
  });

  it('keeps invalid level bounds local and does not allocate or send a command', async () => {
    const createGame = vi.fn<AuthGateway['createGame']>();
    const user = userEvent.setup();
    page(createGame);

    await screen.findByRole('option', { name: 'Селигерская' });
    const levelSelectors = screen.getAllByRole('combobox');
    await user.selectOptions(levelSelectors[3]!, 'B');
    await user.selectOptions(levelSelectors[4]!, 'C');
    await user.click(screen.getByRole('button', { name: 'Создать игру' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Начальный уровень не может быть выше конечного.',
    );
    expect(createGame).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
  });

  it('clears a terminal no-commit rejection and labels it as not created', async () => {
    const createGame = vi
      .fn<AuthGateway['createGame']>()
      .mockRejectedValue(Object.assign(new Error('rejected'), { code: 'GAME_START_TIME_PASSED' }));
    const user = userEvent.setup();
    page(createGame);

    await screen.findByRole('option', { name: 'Селигерская' });
    await user.click(screen.getByRole('button', { name: 'Создать игру' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Игра не создана');
    expect(screen.getByRole('alert')).not.toHaveTextContent('результат неизвестен');
    const ledger = loadCreateGameAttemptLedger(principal, window.localStorage);
    expect(ledger.activeAttempt).toBeUndefined();
    expect(ledger.resolvedAttempts).toEqual([]);
    expect(screen.getByRole('button', { name: 'Создать игру' })).toBeEnabled();
  });

  it('retains K1 when an old or pre-lookup API returns generic INVALID_REQUEST', async () => {
    const createGame = vi
      .fn<AuthGateway['createGame']>()
      .mockRejectedValueOnce(
        Object.assign(new Error('old route rejection'), { code: 'INVALID_REQUEST' }),
      )
      .mockResolvedValueOnce(result({ replayed: true }));
    const navigate = vi.fn();
    const user = userEvent.setup();
    page(createGame, { navigate });

    await screen.findByRole('option', { name: 'Селигерская' });
    await user.click(screen.getByRole('button', { name: 'Создать игру' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('результат неизвестен');
    const firstKey = createGame.mock.calls[0]?.[1]?.idempotencyKey;
    expect(window.localStorage.getItem(createGameAttemptStorageKey(principal))).toContain(firstKey);

    await user.click(screen.getByRole('button', { name: 'Создать игру' }));
    await waitFor(() => expect(createGame).toHaveBeenCalledTimes(2));
    expect(createGame.mock.calls[1]?.[1]?.idempotencyKey).toBe(firstKey);
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(`/games/${gameId}?created=1&revision=1&recovered=1`),
    );
  });

  it('retains the attempt and distinct copy for an idempotency conflict', async () => {
    const createGame = vi
      .fn<AuthGateway['createGame']>()
      .mockRejectedValue(Object.assign(new Error('conflict'), { code: 'IDEMPOTENCY_KEY_REUSED' }));
    const user = userEvent.setup();
    page(createGame);

    await screen.findByRole('option', { name: 'Селигерская' });
    await user.click(screen.getByRole('button', { name: 'Создать игру' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Ключ незавершённой попытки');
    expect(window.localStorage.getItem(createGameAttemptStorageKey(principal))).not.toBeNull();
  });

  it('does not expose, submit or delete another principal attempt and restores it on return', async () => {
    const otherPrincipal = {
      tenantId: principal.tenantId,
      userId: '44444444-4444-4444-8444-444444444444',
    };
    await prepareCreateGameAttempt(
      principal,
      {
        title: 'Секретный черновик A',
        kind: 'FRIENDLY',
        visibility: 'PRIVATE',
        stationId,
        startsAt: '2027-08-15T15:00:00.000Z',
        endsAt: '2027-08-15T16:30:00.000Z',
        timezone: 'Europe/Moscow',
        capacity: 4,
        levelRange: null,
        paymentMode: 'NO_PAYMENT',
        waitlistEnabled: true,
      },
      window.localStorage,
      locks(),
      { createIdempotencyKey: () => 'create-logical-attempt-key-0001' },
    );
    const createGame = vi.fn<AuthGateway['createGame']>();
    const otherView = page(createGame, { currentPrincipal: otherPrincipal });

    expect(await screen.findByDisplayValue('Открытая игра')).toBeVisible();
    expect(screen.queryByDisplayValue('Секретный черновик A')).not.toBeInTheDocument();
    expect(screen.queryByText(/Найдена незавершённая попытка/)).not.toBeInTheDocument();
    expect(window.localStorage.getItem(createGameAttemptStorageKey(principal))).not.toBeNull();
    otherView.unmount();

    page(createGame);
    expect(await screen.findByDisplayValue('Секретный черновик A')).toBeVisible();
    expect(screen.getByText(/Найдена незавершённая попытка/)).toBeVisible();
  });

  it('does not expose another principal resolved game and recovers it on return', async () => {
    const otherPrincipal = {
      tenantId: principal.tenantId,
      userId: '44444444-4444-4444-8444-444444444444',
    };
    const pending = await prepareCreateGameAttempt(
      principal,
      savedPayload('Только для владельца'),
      window.localStorage,
      locks(),
      {
        createAttemptId: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        createIdempotencyKey: () => 'create-logical-attempt-key-0001',
      },
    );
    if (pending.state !== 'PENDING') throw new Error('expected pending attempt');
    await resolveCreateGameAttempt(principal, pending, gameId, window.localStorage, locks());
    const createGame = vi.fn<AuthGateway['createGame']>();
    const otherNavigate = vi.fn();
    const otherView = page(createGame, {
      currentPrincipal: otherPrincipal,
      navigate: otherNavigate,
    });

    expect(await screen.findByDisplayValue('Открытая игра')).toBeVisible();
    expect(otherNavigate).not.toHaveBeenCalled();
    expect(createGame).not.toHaveBeenCalled();
    otherView.unmount();

    const ownerNavigate = vi.fn();
    page(createGame, { navigate: ownerNavigate });
    await waitFor(() =>
      expect(ownerNavigate).toHaveBeenCalledWith(`/games/${gameId}?created=1&recovered=1`),
    );
    expect(createGame).not.toHaveBeenCalled();
  });

  it('fails closed with actionable copy for malformed persisted state', async () => {
    window.localStorage.setItem(
      createGameAttemptStorageKey(principal),
      JSON.stringify({ version: 1, token: 'must-not-be-used' }),
    );
    const createGame = vi.fn<AuthGateway['createGame']>();
    const user = userEvent.setup();
    page(createGame);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Сохранённую попытку нельзя безопасно проверить',
    );
    await screen.findByRole('option', { name: 'Селигерская' });
    await user.click(screen.getByRole('button', { name: 'Создать игру' }));
    expect(createGame).not.toHaveBeenCalled();
  });

  it('shows an explicit unavailable saved station while allowing exact recovery', async () => {
    await prepareCreateGameAttempt(
      principal,
      {
        title: 'Сохранённая игра',
        kind: 'FRIENDLY',
        visibility: 'PUBLIC',
        stationId,
        startsAt: '2027-08-15T15:00:00.000Z',
        endsAt: '2027-08-15T16:30:00.000Z',
        timezone: 'Europe/Moscow',
        capacity: 4,
        levelRange: null,
        paymentMode: 'NO_PAYMENT',
        waitlistEnabled: true,
      },
      window.localStorage,
      locks(),
      { createIdempotencyKey: () => 'create-logical-attempt-key-0001' },
    );
    const createGame = vi
      .fn<AuthGateway['createGame']>()
      .mockResolvedValue(result({ replayed: true }));
    const api = gateway(createGame, {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: 'Другая станция',
    });
    const user = userEvent.setup();
    page(createGame, { api });

    expect(await screen.findByText(/Сохранённая станция больше не отображается/)).toBeVisible();
    expect(screen.getByRole('option', { name: /Сохранённая станция/ })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Создать игру' }));
    await waitFor(() => expect(createGame).toHaveBeenCalledOnce());
  });
});
