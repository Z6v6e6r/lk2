// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { NativeCacheObservation, NativeReadObservation } from './native-api-fetch.js';
import type { ReactNode } from 'react';
import type { StartAndroidYandexLogin } from './AndroidLoginGate.js';
import { sanitizedNativeSessionError } from './session-failure.js';
vi.mock('./android-push.js', () => ({
  initialAndroidPushState: { enabled: false, state: 'unsupported', busy: false },
  createAndroidPushController: () => ({
    mount: () => () => undefined,
    navigationReady: () => undefined,
    sessionReady: () => undefined,
    sessionExpired: () => undefined,
    beforeLogout: () => calls.beforeLogout(),
  }),
}));
vi.mock('./AndroidLoginGate.js', () => ({
  AndroidLoginGate: ({ children }: { children: (start: StartAndroidYandexLogin) => ReactNode }) =>
    children(() => Promise.resolve()),
}));
const calls = vi.hoisted(() => ({
  cancelBookings: vi.fn(),
  beforeLogout: vi.fn<() => Promise<void>>(),
  restore: vi.fn(),
  logout: vi.fn(),
  home: vi.fn(),
  locations: vi.fn(),
  observe: undefined as ((observation: NativeCacheObservation) => void) | undefined,
  observeRead: undefined as ((observation: NativeReadObservation) => void) | undefined,
}));
vi.mock('./native-api-fetch.js', () => ({
  createNativeApiFetch: (
    _config: unknown,
    _plugin: unknown,
    _expired: unknown,
    observe: typeof calls.observe,
    observeRead: typeof calls.observeRead,
  ) => {
    calls.observe = observe;
    calls.observeRead = observeRead;
    return Object.assign(vi.fn(), { cancelUpcomingBookingsRefresh: calls.cancelBookings });
  },
}));
vi.mock('../../web/src/auth-gateway.js', () => ({
  createBrowserAuthGateway: () => ({
    restoreSession: calls.restore,
    logout: calls.logout,
    getHomeBase: calls.home,
    listLocations: calls.locations,
  }),
}));
vi.mock('../../web/src/App.js', () => ({
  App: ({
    gateway,
  }: {
    gateway: {
      restoreSession(): Promise<unknown>;
      logout(): Promise<void>;
      getHomeBase(): Promise<unknown>;
    };
  }) => {
    const [ready, setReady] = useState(false);
    const [snapshot, setSnapshot] = useState(false);
    useEffect(() => {
      void gateway
        .restoreSession()
        .then(() => setReady(true))
        .catch(() => undefined);
    }, [gateway]);
    return ready ? (
      <div>
        <p>Личные данные тестового аккаунта</p>
        {snapshot && <p>Ранее загруженная Главная</p>}
        <button
          onClick={() => {
            void gateway.getHomeBase().then(
              () => setSnapshot(true),
              () => undefined,
            );
          }}
        >
          Загрузить снимок
        </button>
        <button
          onClick={() => {
            void gateway.logout().catch(() => undefined);
          }}
        >
          Выйти
        </button>
      </div>
    ) : (
      <p>Проверка</p>
    );
  },
}));
import { MobileApp } from './MobileApp.js';
const config = {
  apiBaseUrl: 'https://lk2.padlhub.su',
  tenantKey: 'local-padel',
  appVersion: 'test',
};
beforeEach(() => {
  calls.cancelBookings.mockReset().mockResolvedValue(undefined);
  calls.beforeLogout.mockReset().mockResolvedValue(undefined);
  calls.observe = undefined;
  calls.observeRead = undefined;
  calls.restore.mockReset().mockResolvedValue(null);
  calls.logout.mockReset().mockResolvedValue(undefined);
  calls.home.mockReset().mockResolvedValue({});
  calls.locations.mockReset().mockResolvedValue({ items: [] });
});
afterEach(cleanup);

it('hides account data immediately and retries failed logout without remounting the account', async () => {
  let reject!: (reason: Error) => void;
  calls.logout.mockImplementationOnce(
    () =>
      new Promise((_, failure) => {
        reject = failure;
      }),
  );
  render(<MobileApp config={config} native />);
  fireEvent.click(await screen.findByRole('button', { name: 'Выйти' }));
  expect(await screen.findByText('Завершаем выход…')).toBeInTheDocument();
  expect(screen.queryByText('Личные данные тестового аккаунта')).not.toBeInTheDocument();
  await waitFor(() => expect(calls.logout).toHaveBeenCalledOnce());
  reject(new Error('network unavailable'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Выход ещё не завершён');
  expect(calls.restore).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  await waitFor(() => expect(calls.logout).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(calls.restore).toHaveBeenCalledTimes(2));
});

it('offers restoration retry while preserving a transient storage/network error', async () => {
  calls.restore.mockRejectedValueOnce(new Error('storage unavailable'));
  render(<MobileApp config={config} native />);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Не удалось проверить сохранённый вход',
  );
  expect(screen.queryByText('Личные данные тестового аккаунта')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  expect(await screen.findByText('Личные данные тестового аккаунта')).toBeInTheDocument();
});

it('shows a safe storage diagnostic, hides account data and retries without logout', async () => {
  calls.restore.mockRejectedValueOnce(
    sanitizedNativeSessionError({ code: 'NATIVE_STORAGE_UNAVAILABLE', message: 'private' }),
  );
  render(<MobileApp config={config} native />);
  expect(await screen.findByRole('alert')).toHaveTextContent('защищённые данные');
  expect(screen.getByText('Код ошибки: NATIVE_STORAGE_UNAVAILABLE')).toBeInTheDocument();
  expect(screen.queryByText('Личные данные тестового аккаунта')).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent('private');
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  expect(await screen.findByText('Личные данные тестового аккаунта')).toBeInTheDocument();
  expect(calls.logout).not.toHaveBeenCalled();
  expect(calls.restore).toHaveBeenCalledTimes(2);
});

it('discards retained screen state after a denied cached read without revoking the account', async () => {
  render(<MobileApp config={config} native />);
  act(() =>
    calls.observe?.({
      path: '/user/api/v1/local-padel/home/base',
      state: 'stale',
      savedAt: Date.now(),
    }),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Загрузить снимок' }));
  expect(await screen.findByText('Ранее загруженная Главная')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('сохранённая копия');
  act(() =>
    calls.observe?.({
      path: '/user/api/v1/local-padel/home/base',
      state: 'unavailable',
      invalidate: true,
    }),
  );
  await screen.findByRole('button', { name: 'Загрузить снимок' });
  expect(screen.queryByText('Ранее загруженная Главная')).not.toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(calls.logout).not.toHaveBeenCalled();
  expect(calls.restore).toHaveBeenCalledTimes(2);
});

it('clears a retained snapshot after SDK parsing fails on a malformed HTTP 200, without a retry loop', async () => {
  render(<MobileApp config={config} native />);
  act(() =>
    calls.observe?.({
      path: '/user/api/v1/local-padel/home/base',
      state: 'stale',
      savedAt: Date.now(),
    }),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Загрузить снимок' }));
  await screen.findByText('Ранее загруженная Главная');
  calls.home.mockRejectedValue(new TypeError('Malformed HomeBase: communities.value is absent'));
  act(() => calls.observe?.({ path: '/user/api/v1/local-padel/home/base', state: 'live' }));
  expect(screen.getByRole('status')).toHaveTextContent('сохранённая копия');
  fireEvent.click(screen.getByRole('button', { name: 'Загрузить снимок' }));
  await waitFor(() => expect(calls.restore).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('Ранее загруженная Главная')).not.toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole('button', { name: 'Загрузить снимок' }));
  await waitFor(() => expect(calls.home).toHaveBeenCalledTimes(3));
  expect(calls.restore).toHaveBeenCalledTimes(2);
  expect(calls.logout).not.toHaveBeenCalled();
});

it('reveals diagnostics only on request and clears each section independently', async () => {
  render(<MobileApp config={config} native />);
  await screen.findByRole('button', { name: 'Выйти' });
  const correlationId = '00000000-0000-4000-8000-000000000003';
  act(() => {
    calls.observeRead?.({
      section: 'profile',
      failure: { status: 503, code: 'PROFILE_PROJECTION_STALE', correlationId },
    });
    calls.observeRead?.({
      section: 'bookings',
      failure: { status: 200, code: 'BOOKINGS_UNAVAILABLE' },
    });
  });
  const details = screen.getByRole('button', { name: 'Сведения об ошибке загрузки' });
  expect(details).toHaveAttribute('aria-expanded', 'false');
  expect(document.getElementById(details.getAttribute('aria-controls')!)).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent('PROFILE_PROJECTION_STALE');
  expect(document.body).not.toHaveTextContent(correlationId);
  fireEvent.click(details);
  expect(details).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('HTTP 503; Код ошибки: PROFILE_PROJECTION_STALE')).toBeInTheDocument();
  expect(screen.getByText('HTTP 200; Код ошибки: BOOKINGS_UNAVAILABLE')).toBeInTheDocument();
  expect(screen.getByText(`Код запроса: ${correlationId}`)).toBeInTheDocument();
  act(() => calls.observeRead?.({ section: 'profile', failure: null }));
  expect(document.body).not.toHaveTextContent('PROFILE_PROJECTION_STALE');
  expect(document.body).toHaveTextContent('BOOKINGS_UNAVAILABLE');
  act(() => calls.observeRead?.({ section: 'bookings', failure: null }));
  expect(screen.queryByRole('note')).not.toBeInTheDocument();
  act(() =>
    calls.observeRead?.({ section: 'profile', failure: { code: 'NATIVE_NETWORK_UNAVAILABLE' } }),
  );
  expect(screen.getByRole('button', { name: 'Сведения об ошибке загрузки' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  expect(document.body).not.toHaveTextContent('NATIVE_NETWORK_UNAVAILABLE');
  expect(calls.restore).toHaveBeenCalledOnce();
  expect(calls.logout).not.toHaveBeenCalled();
});

it('keeps successful read metadata collapsed without claiming that the screen rendered', async () => {
  render(<MobileApp config={config} native />);
  await screen.findByRole('button', { name: 'Выйти' });
  act(() =>
    calls.observeRead?.({
      section: 'profile',
      failure: null,
      complete: true,
      path: '/profile',
      trace: [
        {
          stage: 'initial-get',
          observedAt: '2026-10-12T21:00:00.000Z',
          source: 'network',
          outcome: 'http',
          status: 200,
          shape: 'object',
          fields: ['displayName', 'userId'],
          headers: {
            contentType: 'application/json',
            cacheControl: 'private, no-store',
            retryAfter: 'ABSENT',
          },
        },
      ],
    }),
  );
  const details = screen.getByRole('button', { name: 'Сведения о загрузке' });
  expect(details).toHaveAttribute('aria-expanded', 'false');
  expect(document.body).not.toHaveTextContent('HTTP 200');
  fireEvent.click(details);
  expect(document.body).toHaveTextContent('HTTP 200');
  expect(document.body).toHaveTextContent('Cache-Control: private, no-store');
  expect(document.body).toHaveTextContent('поля: displayName, userId');
  expect(document.body).toHaveTextContent('Показ экрана: не подтверждён');
  expect(document.body).not.toHaveTextContent('Код ошибки:');
  act(() => calls.observeRead?.({ section: 'profile', failure: null, complete: true, trace: [] }));
  expect(screen.queryByRole('note')).not.toBeInTheDocument();
  expect(calls.restore).toHaveBeenCalledOnce();
});

it('retains the prior failure during pending diagnostics and clears bounded observations on logout', async () => {
  render(<MobileApp config={config} native />);
  await screen.findByRole('button', { name: 'Выйти' });
  const oldObserve = calls.observeRead;
  const trace = [
    {
      stage: 'initial-get',
      observedAt: '2026-10-12T21:00:00.000Z',
      source: 'network',
      outcome: 'http',
      status: 503,
    },
  ] as const;
  act(() =>
    calls.observeRead?.({ section: 'bookings', failure: { code: 'BOOKINGS_PROJECTION_STALE' } }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Сведения об ошибке загрузки' }));
  act(() =>
    calls.observeRead?.({
      section: 'bookings',
      failure: null,
      complete: false,
      trace,
      path: '/bookings/upcoming',
    }),
  );
  expect(document.body).toHaveTextContent('BOOKINGS_PROJECTION_STALE');
  expect(document.body).toHaveTextContent('HTTP 503');
  fireEvent.click(screen.getByRole('button', { name: 'Выйти' }));
  expect(screen.queryByRole('note')).not.toBeInTheDocument();
  act(() =>
    oldObserve?.({
      section: 'bookings',
      failure: null,
      complete: true,
      trace,
      path: '/bookings/upcoming',
    }),
  );
  expect(screen.queryByRole('note')).not.toBeInTheDocument();
});

it('clears expanded diagnostics immediately on logout and on the subsequent session remount', async () => {
  let reject!: (reason: Error) => void;
  calls.logout.mockImplementationOnce(
    () =>
      new Promise((_, failure) => {
        reject = failure;
      }),
  );
  render(<MobileApp config={config} native />);
  await screen.findByRole('button', { name: 'Выйти' });
  const oldObserveRead = calls.observeRead;
  act(() =>
    calls.observeRead?.({
      section: 'profile',
      failure: { status: 503, code: 'PROFILE_PROJECTION_STALE' },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Сведения об ошибке загрузки' }));
  expect(document.body).toHaveTextContent('PROFILE_PROJECTION_STALE');
  fireEvent.click(screen.getByRole('button', { name: 'Выйти' }));
  expect(screen.queryByRole('note')).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent('PROFILE_PROJECTION_STALE');
  await waitFor(() => expect(calls.logout).toHaveBeenCalledOnce());
  reject(new Error('network unavailable'));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  await waitFor(() => expect(calls.restore).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('note')).not.toBeInTheDocument();
  act(() =>
    oldObserveRead?.({ section: 'profile', failure: { code: 'PROFILE_PROJECTION_STALE' } }),
  );
  expect(screen.queryByRole('note')).not.toBeInTheDocument();
  act(() =>
    calls.observeRead?.({ section: 'bookings', failure: { code: 'BOOKINGS_UNAVAILABLE' } }),
  );
  expect(screen.getByRole('button', { name: 'Сведения об ошибке загрузки' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  expect(document.body).not.toHaveTextContent('BOOKINGS_UNAVAILABLE');
});

it('does not attach native read diagnostics to the browser session', async () => {
  render(<MobileApp config={config} native={false} />);
  await screen.findByRole('button', { name: 'Выйти' });
  expect(calls.observeRead).toBeUndefined();
  expect(screen.queryByRole('note')).not.toBeInTheDocument();
});

it('retires native bookings before push cleanup or session logout can wait', async () => {
  let cancelled!: () => void;
  calls.cancelBookings.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        cancelled = resolve;
      }),
  );
  render(<MobileApp config={config} native />);
  fireEvent.click(await screen.findByRole('button', { name: 'Выйти' }));
  await waitFor(() => expect(calls.cancelBookings).toHaveBeenCalledOnce());
  expect(screen.queryByText('Личные данные тестового аккаунта')).not.toBeInTheDocument();
  expect(calls.beforeLogout).not.toHaveBeenCalled();
  expect(calls.logout).not.toHaveBeenCalled();
  act(() => cancelled());
  await waitFor(() => expect(calls.logout).toHaveBeenCalledOnce());
  expect(calls.beforeLogout).toHaveBeenCalledOnce();
  expect(calls.cancelBookings.mock.invocationCallOrder[0]).toBeLessThan(
    calls.beforeLogout.mock.invocationCallOrder[0]!,
  );
  expect(calls.beforeLogout.mock.invocationCallOrder[0]).toBeLessThan(
    calls.logout.mock.invocationCallOrder[0]!,
  );
});
