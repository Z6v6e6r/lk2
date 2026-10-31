// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type * as CapacitorCore from '@capacitor/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IOSAuthApp } from './IOSAuthApp.js';
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
  vi.restoreAllMocks();
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
    expect(session.tournamentPrincipal()).not.toBeNull();
    nativePush.suspend.mockRejectedValueOnce(new Error('SYNTHETIC_REVOKE_UNAVAILABLE'));
    fireEvent.click(screen.getByRole('button', { name: 'Выйти из аккаунта' }));
    expect(session.tournamentPrincipal()).toBeNull();
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
      window.history.pushState(null, '', '/games/new?new=1');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('heading', { name: 'Раздел пока недоступен' });
    expect(request.mock.calls).toHaveLength(before);
  });
});

describe('iOS concrete tournament consumer', () => {
  const id = '11111111-1111-4111-8111-111111111111',
    operation = '22222222-2222-4222-8222-222222222222';
  const summary = {
    id,
    title: 'Synthetic iOS tournament',
    format: 'Мексикано',
    startsAt: '2099-11-02T15:00:00Z',
    endsAt: '2099-11-02T17:00:00Z',
    venue: 'Synthetic station',
    trainerName: null,
    levelRange: null,
    organizer: null,
    capacity: { total: 8, registered: 0, open: 8, waitlist: 0 },
    status: 'REGISTRATION',
    route: '/tournaments?event=' + id,
  };
  function tournamentFixture() {
    let current: unknown = null;
    const request = vi.fn<IOSSessionPlugin['request']>(async (input) => {
      await Promise.resolve();
      if (input.operation !== 'tournament') return fixtureReply(input);
      if (input.resource === 'list') return nativeResult({ items: [summary] });
      if (input.resource === 'summary') return nativeResult(summary);
      if (input.resource === 'participants')
        return nativeResult({ items: [], refreshedAt: '2099-11-01T10:00:00Z' });
      if (input.resource === 'status')
        return nativeResult({ commandsEnabled: true, result: current });
      const action =
        input.resource === 'retry'
          ? 'JOIN'
          : (JSON.parse(input.body!) as { action: 'JOIN' | 'LEAVE' }).action;
      const status =
        input.resource === 'retry' ? 'REGISTERED' : action === 'JOIN' ? 'UNKNOWN' : 'LEFT';
      current = {
        tournamentId: id,
        operation: {
          id: action === 'JOIN' ? operation : id,
          action,
          status,
          reason: status === 'UNKNOWN' ? null : status,
          generation: status === 'UNKNOWN' ? null : operation,
        },
        registration: {
          status:
            status === 'UNKNOWN'
              ? 'UNKNOWN'
              : status === 'REGISTERED'
                ? 'REGISTERED'
                : 'NOT_REGISTERED_BY_OPERATION',
          asOf: null,
        },
        retryAfterSeconds: status === 'UNKNOWN' ? 15 : null,
      };
      return nativeResult(current);
    });
    return { request, session: syntheticSession(request) };
  }
  function locks() {
    vi.stubGlobal(
      'navigator',
      Object.create(navigator, {
        locks: {
          value: { request: async (_n: string, _o: unknown, cb: () => unknown) => await cb() },
          configurable: true,
        },
      }),
    );
  }
  async function openTournament(session: ReturnType<typeof syntheticSession>) {
    render(<IOSAuthApp session={session} />);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Турниры' })).toBeVisible());
    fireEvent.click(screen.getByRole('link', { name: 'Турниры' }));
    fireEvent.click(await screen.findByRole('link', { name: summary.title }));
    await screen.findByRole('heading', { name: summary.title });
  }
  it('actual IOSSession/SDK bridge: directory → UNKNOWN → remount → original retry → LEAVE', async () => {
    locks();
    const f = tournamentFixture();
    await f.session.restore();
    await openTournament(f.session);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Записаться на турнир' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Записаться на турнир' }));
    await screen.findByText('Операция ожидает подтверждения. Сохранён исходный запрос.');
    const original = f.request.mock.calls.find(
      ([x]) => x.operation === 'tournament' && x.resource === 'command',
    )![0];
    expect(original.body).toBe('{"action":"JOIN"}');
    expect(original.headers['idempotency-key']).toBeTruthy();
    cleanup();
    const restored = syntheticSession(f.request);
    await restored.restore();
    await openTournament(restored);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Повторить исходную операцию' })).toBeEnabled(),
    );
    expect(
      f.request.mock.calls.filter(
        ([x]) => x.operation === 'tournament' && x.resource === 'command',
      ),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Повторить исходную операцию' }));
    await screen.findByText('Запись подтверждена.');
    expect(f.request.mock.calls.find(([x]) => x.resource === 'retry')![0]).toMatchObject({
      operationId: operation,
      headers: { 'idempotency-key': operation },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Выйти из турнира' }));
    await screen.findByText('Вы вышли из исходной регистрации.');
    expect(f.request.mock.calls.filter(([x]) => x.resource === 'command').at(-1)![0].body).toBe(
      JSON.stringify({ action: 'LEAVE', originalJoinOperationId: operation }),
    );
    const publicRead = f.request.mock.calls.find(([x]) => x.resource === 'list')![0];
    expect(publicRead.headers).not.toHaveProperty('authorization');
    expect(publicRead.headers).not.toHaveProperty('cookie');
  });
  it.each(['locks', 'randomUUID', 'storage'] as const)(
    'missing %s has zero mutation POST, without native fallback',
    async (missing) => {
      locks();
      if (missing === 'locks')
        vi.stubGlobal('navigator', Object.create(navigator, { locks: { value: undefined } }));
      else if (missing === 'randomUUID')
        vi.stubGlobal('crypto', Object.create(crypto, { randomUUID: { value: undefined } }));
      else
        vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
          throw new DOMException('denied', 'SecurityError');
        });
      const f = tournamentFixture();
      await f.session.restore();
      await openTournament(f.session);
      const button = screen.getByRole('button', { name: 'Записаться на турнир' });
      if (missing === 'randomUUID') {
        await waitFor(() => expect(button).toBeEnabled());
        fireEvent.click(button);
        await screen.findByRole('alert');
      } else await waitFor(() => expect(button).toBeDisabled());
      expect(
        f.request.mock.calls.filter(([x]) => x.resource === 'command' || x.resource === 'retry'),
      ).toHaveLength(0);
    },
  );
});
