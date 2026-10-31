// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type * as CapacitorCore from '@capacitor/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IOSAuthApp } from './IOSAuthApp.js';
import type { IOSSessionPlugin } from './session.js';
import { chatFixture } from './testing/chat-fixtures.js';
import { getChatsUnreadCount } from '../../../web/src/chats-unread.js';
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
  it('opens existing chats without direct-create permission and clears unread on logout', async () => {
    const fixture = chatFixture();
    const request = vi.fn<IOSSessionPlugin['request']>(
      async (input) => await Promise.resolve(fixture.reply(input)),
    );
    const session = syntheticSession(request);
    await session.restore();
    render(<IOSAuthApp session={session} />);
    await screen.findByRole('main', { name: 'Главная' });
    const link = await screen.findByRole('link', { name: 'Чаты, непрочитанных сообщений: 5' });
    fireEvent.click(link);
    await screen.findByRole('heading', { name: 'Чаты' });
    await screen.findByText('Тестовая игра');
    expect(screen.queryByRole('link', { name: 'Создать игру' })).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'Профиль' }));
    await screen.findByRole('heading', { name: 'Анна Петрова' });
    fireEvent.click(screen.getByRole('button', { name: 'Выйти из аккаунта' }));
    await screen.findByLabelText('Номер телефона');
    expect(getChatsUnreadCount()).toBe(0);
  });
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
    expect(within(nav).getAllByRole('link')).toHaveLength(4);
    expect(screen.queryByRole('link', { name: 'Создать игру' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Чаты' })).toHaveAttribute('href', '/chats');
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
      window.history.pushState(null, '', '/games/new?new=1');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('heading', { name: 'Раздел пока недоступен' });
    expect(request.mock.calls).toHaveLength(before);
  });
});
