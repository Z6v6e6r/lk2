// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';
import type * as CapacitorCore from '@capacitor/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IOSAuthApp } from './IOSAuthApp.js';
import type { QuarterCustody } from '../../../web/src/quarter-create-attempt.js';
import type { IOSSessionPlugin } from './session.js';
import {
  fixtureReply,
  homeDashboard,
  game,
  nativeResult,
  syntheticSession,
  viewerId,
  config,
} from './testing/cabinet-fixtures.js';

const nativePush = vi.hoisted(() => ({
  status: vi.fn(
    async () =>
      await Promise.resolve({
        configured: false,
        installationId: 'synthetic-installation',
        pendingRevoke: false,
        state: 'unsupported',
      }),
  ),
  suspend: vi.fn(
    async () =>
      await Promise.resolve({ installationId: 'synthetic-installation', pendingRevoke: false }),
  ),
  takeOpened: vi.fn(async () => await Promise.resolve({})),
  addListener: vi.fn(async () => await Promise.resolve({ remove: async () => {} })),
}));
vi.mock('@capacitor/core', async (importOriginal) => {
  const original = await importOriginal<typeof CapacitorCore>();
  return {
    ...original,
    registerPlugin: (name: string) =>
      name === 'PadlHubIOSPush' ? nativePush : original.registerPlugin(name),
  };
});

// Transform the shared lazy-loaded screens before the UI assertions' one-second budget.
beforeAll(async () => {
  await import('./IOSCabinet.js');
});

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn());
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('iOS cabinet with the real shared screens and one native session', () => {
  it('restores home, navigates profile/bookings/games/location, and logs out without browser or provider commands', async () => {
    let markDashboardRequested!: () => void;
    const dashboardRequested = new Promise<void>((resolve) => {
      markDashboardRequested = resolve;
    });
    let resolveDashboard!: (reply: ReturnType<typeof nativeResult>) => void;
    const dashboardReply = new Promise<ReturnType<typeof nativeResult>>((resolve) => {
      resolveDashboard = resolve;
    });
    const request = vi.fn<IOSSessionPlugin['request']>(async (input) => {
      if (input.operation === 'read' && input.resource === 'home') {
        markDashboardRequested();
        return await dashboardReply;
      }
      return await Promise.resolve(fixtureReply(input));
    });
    const session = syntheticSession(request);
    await session.restore();
    render(<IOSAuthApp session={session} />);
    // Home replaces its loading Page; query navigation only after that replacement.
    await screen.findByRole('main', { name: 'Главная' });
    const nav = screen.getByRole('navigation', { name: 'Основная навигация' });
    expect(nav).toBeInTheDocument();
    expect(within(nav).getAllByRole('link')).toHaveLength(3);
    expect(screen.queryByRole('link', { name: 'Создать игру' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Чаты' })).toBeNull();
    fireEvent.click(within(nav).getByRole('link', { name: 'Профиль' }));
    // Home and Profile share the name heading; await a region unique to the destination.
    const subscriptions = await screen.findByRole('region', { name: 'Подписки и абонементы' });
    expect(window.location.pathname).toBe('/profile');
    expect(screen.getByRole('heading', { name: 'Анна Петрова' })).toBeVisible();
    expect(within(subscriptions).getByRole('status')).toHaveTextContent(
      'Загружаем действующие подписки…',
    );
    await act(async () => {
      await dashboardRequested;
      resolveDashboard(nativeResult(homeDashboard));
      await dashboardReply;
    });
    expect(within(subscriptions).getByText('Лето · Падел · Спорт')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Предпочтения/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    expect(
      within(dialog)
        .getAllByRole('checkbox')
        .every((input) => (input as HTMLInputElement).disabled),
    ).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    // Route away also unmounts any open settings sheet.
    act(() => {
      window.history.pushState(null, '', '/bookings');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('heading', { name: 'Мои записи' });
    await screen.findByText('Американо · уровень C');
    fireEvent.click(screen.getByRole('link', { name: 'Найти игру' }));
    await screen.findByText(game.title);
    expect(screen.queryByRole('button', { name: 'Вступить в игру' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Вступить в игру' })).toBeNull();
    act(() => {
      window.history.pushState(null, '', `/locations/${game.station.id}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('heading', { name: 'Хаб Селигерская' });
    fireEvent.click(screen.getByRole('link', { name: 'Профиль' }));
    await screen.findByRole('heading', { name: 'Анна Петрова' });
    nativePush.suspend.mockRejectedValueOnce(new Error('SYNTHETIC_REVOKE_UNAVAILABLE'));
    fireEvent.click(screen.getByRole('button', { name: 'Выйти из аккаунта' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось отключить уведомления перед выходом',
    );
    expect(request.mock.calls.some(([input]) => input.operation === 'logout')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Выйти из аккаунта' }));
    await screen.findByLabelText('Номер телефона');
    expect(screen.queryByText('Анна Петрова')).toBeNull();
    expect(
      request.mock.calls.every(([input]) =>
        ['refresh', 'read', 'logout'].includes(input.operation),
      ),
    ).toBe(true);
    expect(request.mock.calls.filter(([input]) => input.operation === 'refresh')).toHaveLength(1);
  });

  it('keeps unavailable bookings distinct from an empty list and permits a retry', async () => {
    let unavailable = true;
    const session = syntheticSession(
      async (input) =>
        await Promise.resolve(
          input.resource === 'bookings' && unavailable
            ? nativeResult({ state: 'UNAVAILABLE', items: [] })
            : fixtureReply(input),
        ),
    );
    await session.restore();
    render(<IOSAuthApp session={session} />);
    await screen.findByRole('main', { name: 'Главная' });
    fireEvent.click(screen.getByRole('link', { name: 'Записи' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось загрузить');
    expect(screen.queryByText('Ближайших записей нет.')).toBeNull();
    unavailable = false;
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await screen.findByText('Американо · уровень C');
  });

  it('uses a canonical HTTPS profile share link and fails closed for unimplemented routes', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const request = vi.fn<IOSSessionPlugin['request']>(
      async (input) => await Promise.resolve(fixtureReply(input)),
    );
    const session = syntheticSession(request);
    await session.restore();
    render(<IOSAuthApp session={session} />);
    await screen.findByRole('main', { name: 'Главная' });
    fireEvent.click(screen.getByRole('link', { name: 'Профиль' }));
    await screen.findByRole('heading', { name: 'Анна Петрова' });
    fireEvent.click(screen.getByRole('button', { name: 'поделиться' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${config.apiBaseUrl}/profile/${viewerId}`),
    );
    const before = request.mock.calls.length;
    act(() => {
      window.history.pushState(null, '', '/tournaments?new=1');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('heading', { name: 'Раздел пока недоступен' });
    expect(request.mock.calls).toHaveLength(before);
  });
});

describe('native quarter CREATE through the actual cabinet and session', () => {
  it('retains original UNKNOWN across cold restore and sends only explicit same-key reconciliation', async () => {
    const { webcrypto } = await import('node:crypto');
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('navigator', {
      ...navigator,
      locks: {
        request: async (_n: unknown, _o: unknown, fn: () => unknown) => {
          await Promise.resolve();
          return fn();
        },
      },
    });
    const { quarterStorageKey, quarterOperationId, quarterDraftId } =
      await import('../../../web/src/quarter-create-attempt.js');
    const { auth } = await import('./testing/cabinet-fixtures.js');
    const principal = { tenantId: auth.context.tenantId, userId: auth.context.userId };
    const id = '11111111-1111-4111-8111-111111111111';
    let confirmed = false;
    const request = vi.fn<IOSSessionPlugin['request']>(async (input) => {
      await Promise.resolve();
      if (input.operation === 'read' && input.resource === 'home')
        return nativeResult({
          ...homeDashboard,
          subscriptions: [{ id, title: 'Тестовая подписка' }],
        });
      if (input.operation !== 'quarterCreate') return fixtureReply(input);
      if (input.resource === 'capability')
        return nativeResult({ contractVersion: 1, available: true });
      if (input.resource === 'locations')
        return nativeResult({
          items: [
            { stationId: id, courtId: id, stationTitle: 'Тестовая станция', courtName: 'Корт 1' },
          ],
        });
      const raw = localStorage.getItem(quarterStorageKey(principal));
      if (!raw) throw new Error('Custody must precede HTTP');
      const c = JSON.parse(raw) as QuarterCustody;
      if (input.resource === 'reconcile') confirmed = true;
      const h = Array.from(
        new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(c.key))),
      )
        .map((x) => x.toString(16).padStart(2, '0'))
        .join('');
      return nativeResult({
        contractVersion: 1,
        request: c.request,
        keySha256: 'sha256:' + h,
        operation: {
          id: await quarterOperationId(c),
          draftId: await quarterDraftId(c),
          status: confirmed ? 'CONFIRMED' : 'UNKNOWN',
        },
        gameProjection: {
          status: confirmed ? 'AVAILABLE' : 'PENDING',
          gameId: confirmed ? game.id : null,
        },
        registration: { status: 'UNKNOWN', asOf: null },
        reason: null,
      });
    });
    const open = async () => {
      const session = syntheticSession(request);
      await session.restore();
      render(<IOSAuthApp session={session} />);
      fireEvent.click(await screen.findByRole('link', { name: 'Игра по подписке' }));
      await screen.findByRole('heading', { name: 'Игра по подписке' });
      return session;
    };
    localStorage.clear();
    await open();
    await waitFor(() => expect(screen.getByLabelText('Корт')).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText('Корт'), { target: { value: id } });
    fireEvent.change(screen.getByLabelText(/Начало — ваше местное время/), {
      target: { value: '2030-01-01T12:00' },
    });
    await screen.findByRole('option', { name: 'Тестовая подписка' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Выберите подписку' }), {
      target: { value: id },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Создать игру по подписке' }));
    await screen.findByText('Результат ещё неизвестен. Сохранён исходный запрос.');
    const original = localStorage.getItem(quarterStorageKey(principal));
    cleanup();
    await open();
    await screen.findByText('Результат ещё неизвестен. Сохранён исходный запрос.');
    expect(request.mock.calls.filter(([x]) => x.resource === 'create')).toHaveLength(1);
    expect(localStorage.getItem(quarterStorageKey(principal))).toBe(original);
    fireEvent.click(screen.getByRole('button', { name: 'Продолжить исходную операцию' }));
    await screen.findByText('Создание игры подтверждено.');
    const calls = request.mock.calls.map(([x]) => x),
      first = calls.find((x) => x.resource === 'create')!,
      recovery = calls.find((x) => x.resource === 'reconcile')!;
    expect(recovery.headers['idempotency-key']).toBe(first.headers['idempotency-key']);
    expect(recovery.body).toBe(first.body);
    expect(calls.filter((x) => x.resource === 'create')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Открыть игру' }));
    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([x]) => x.operation === 'read' && x.resource === 'game' && x.resourceId === game.id,
        ),
      ).toBe(true),
    );
    expect(
      screen.queryByRole('button', { name: /Вступить|Отменить игру/ }),
    ).not.toBeInTheDocument();
    localStorage.clear();
  });
});

it('tournament A pending custody cannot leak into tournament B after native route change', async () => {
  const a = '11111111-1111-4111-8111-111111111111',
    b = '22222222-2222-4222-8222-222222222222';
  vi.stubGlobal('crypto', webcrypto);
  localStorage.clear();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback(),
    },
  });
  const request = vi.fn<IOSSessionPlugin['request']>((input) => {
    if (input.operation !== 'tournamentChat') return Promise.resolve(fixtureReply(input));
    const tournamentId = input.resourceId;
    if (input.resource === 'history')
      return Promise.resolve(
        nativeResult({
          contractVersion: 'tournament-chat.v1',
          tournamentId,
          streamId: null,
          throughSequence: 0,
          messages: [],
          hasMore: false,
          nextCursor: null,
        }),
      );
    if (input.resource === 'position')
      return Promise.resolve(
        nativeResult({
          contractVersion: 'tournament-chat-read.v1',
          tournamentId,
          streamId: null,
          witnessHash: null,
          baselineSequence: 0,
          readThroughSequence: 0,
          publishedSequence: 0,
        }),
      );
    return Promise.resolve(
      nativeResult({
        contractVersion: 'tournament-chat.v1',
        tournamentId,
        requestId: input.requestId,
        status: 'UNKNOWN',
      }),
    );
  });
  const session = syntheticSession(request);
  await session.restore();
  render(<IOSAuthApp session={session} />);
  await screen.findByRole('main', { name: 'Главная' });
  const navigate = async (id: string) => {
    await act(async () => {
      window.history.pushState(null, '', `/tournaments/${id}/chat`);
      window.dispatchEvent(new PopStateEvent('popstate'));
      await Promise.resolve();
    });
  };
  await navigate(a);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Сообщение' }), {
    target: { value: 'original A' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
  await screen.findByText('Не удалось подтвердить отправку. Проверьте статус сообщения.');
  await navigate(b);
  await waitFor(() =>
    expect(
      request.mock.calls.some(
        ([v]) => v.operation === 'tournamentChat' && v.resource === 'history' && v.resourceId === b,
      ),
    ).toBe(true),
  );
  expect(screen.getByRole('button', { name: 'Проверить статус' })).toBeDisabled();
  fireEvent.change(await screen.findByRole('textbox', { name: 'Сообщение' }), {
    target: { value: 'independent B' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
  await waitFor(() =>
    expect(
      request.mock.calls.filter(([v]) => v.operation === 'tournamentChat' && v.resource === 'send'),
    ).toHaveLength(2),
  );
  const sends = request.mock.calls
    .filter(([v]) => v.operation === 'tournamentChat' && v.resource === 'send')
    .map(([v]) => v);
  expect(sends.map((v) => v.resourceId)).toEqual([a, b]);
  expect(sends[0]?.requestId).not.toBe(sends[1]?.requestId);
  await navigate(a);
  await waitFor(() =>
    expect(
      request.mock.calls.some(
        ([v]) =>
          v.resource === 'status' && v.resourceId === a && v.requestId === sends[0]?.requestId,
      ),
    ).toBe(true),
  );
  expect(request.mock.calls.filter(([v]) => v.resource === 'send')).toHaveLength(2);
  localStorage.clear();
});
