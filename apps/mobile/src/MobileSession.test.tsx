// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { NativeCacheObservation } from './native-api-fetch.js';
import type { ReactNode } from 'react';
import type { StartAndroidYandexLogin } from './AndroidLoginGate.js';
vi.mock('./AndroidLoginGate.js', () => ({
  AndroidLoginGate: ({ children }: { children: (start: StartAndroidYandexLogin) => ReactNode }) =>
    children(() => Promise.resolve()),
}));
const calls = vi.hoisted(() => ({
  restore: vi.fn(),
  logout: vi.fn(),
  home: vi.fn(),
  locations: vi.fn(),
  observe: undefined as ((observation: NativeCacheObservation) => void) | undefined,
}));
vi.mock('./native-api-fetch.js', () => ({
  createNativeApiFetch: (
    _config: unknown,
    _plugin: unknown,
    _expired: unknown,
    observe: typeof calls.observe,
  ) => {
    calls.observe = observe;
    return vi.fn();
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
