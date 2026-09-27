// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ restore: vi.fn(), logout: vi.fn() }));
vi.mock('../../web/src/auth-gateway.js', () => ({
  createBrowserAuthGateway: () => ({ restoreSession: calls.restore, logout: calls.logout }),
}));
vi.mock('../../web/src/App.js', () => ({
  App: ({
    gateway,
  }: {
    gateway: { restoreSession(): Promise<unknown>; logout(): Promise<void> };
  }) => {
    const [ready, setReady] = useState(false);
    useEffect(() => {
      void gateway
        .restoreSession()
        .then(() => setReady(true))
        .catch(() => undefined);
    }, [gateway]);
    return ready ? (
      <div>
        <p>Личные данные тестового аккаунта</p>
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
