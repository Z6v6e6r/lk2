// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AndroidLoginGate, type AndroidYandexPlugin } from './AndroidLoginGate.js';

afterEach(cleanup);
function fixture() {
  let changed: () => void = () => undefined;
  const transport = {
    startYandexLogin: vi.fn().mockResolvedValue({ state: 'waiting' }),
    yandexLoginStatus: vi.fn().mockResolvedValue({ state: 'idle' }),
    cancelYandexLogin: vi.fn().mockResolvedValue({ state: 'idle' }),
    addListener: vi.fn((_event, listener: () => void) => {
      changed = listener;
      return Promise.resolve({ remove: vi.fn() });
    }),
  } satisfies AndroidYandexPlugin;
  const mount = () =>
    render(
      <AndroidLoginGate transport={transport}>
        {(start) => (
          <button
            onClick={() => {
              void start({ publicOfferAccepted: true, personalDataPolicyAccepted: true });
            }}
          >
            Личный кабинет
          </button>
        )}
      </AndroidLoginGate>,
    );
  return { transport, mount, changed: () => act(() => changed()) };
}

it('starts only through the dedicated native method and waits for custody before opening the cabinet', async () => {
  const f = fixture();
  f.mount();
  const button = await screen.findByRole('button', { name: 'Личный кабинет' });
  f.transport.yandexLoginStatus.mockResolvedValue({ state: 'waiting' });
  fireEvent.click(button);
  expect(await screen.findByRole('button', { name: 'Отменить вход' })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Проверить вход' })).toBeEnabled());
  expect(f.transport.startYandexLogin).toHaveBeenCalledWith({
    publicOfferAccepted: true,
    personalDataPolicyAccepted: true,
  });
  expect(screen.queryByRole('button', { name: 'Личный кабинет' })).not.toBeInTheDocument();
  f.transport.yandexLoginStatus.mockResolvedValue({ state: 'complete' });
  f.changed();
  expect(await screen.findByRole('button', { name: 'Личный кабинет' })).toBeInTheDocument();
});

it('restores a pending browser attempt after process restart and supports explicit cancellation', async () => {
  const f = fixture();
  f.transport.yandexLoginStatus.mockResolvedValue({ state: 'waiting' });
  f.mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Отменить вход' }));
  expect(await screen.findByRole('button', { name: 'Личный кабинет' })).toBeInTheDocument();
  expect(f.transport.cancelYandexLogin).toHaveBeenCalledOnce();
  expect(f.transport.startYandexLogin).not.toHaveBeenCalled();
});

it('blocks account restoration while native recovery fails, then retries without a new login', async () => {
  const f = fixture();
  f.transport.yandexLoginStatus.mockRejectedValueOnce({ code: 'NATIVE_NETWORK_UNAVAILABLE' });
  f.mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось завершить вход');
  expect(screen.queryByRole('button', { name: 'Отменить вход' })).not.toBeInTheDocument();
  f.transport.yandexLoginStatus.mockResolvedValue({ state: 'complete' });
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  expect(await screen.findByRole('button', { name: 'Личный кабинет' })).toBeInTheDocument();
  expect(f.transport.startYandexLogin).not.toHaveBeenCalled();
});

it('does not silently cancel an exchange that may already have committed', async () => {
  const f = fixture();
  f.transport.yandexLoginStatus.mockResolvedValue({ state: 'waiting' });
  f.transport.cancelYandexLogin.mockRejectedValueOnce({ code: 'NATIVE_OAUTH_FINISH_REQUIRED' });
  f.mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Отменить вход' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Вход уже подтверждён');
  expect(screen.queryByRole('button', { name: 'Личный кабинет' })).not.toBeInTheDocument();
});

it('shows an expired attempt as a fresh sign-in without an automatic provider retry', async () => {
  const f = fixture();
  f.transport.yandexLoginStatus.mockRejectedValueOnce({ code: 'NATIVE_OAUTH_EXPIRED' });
  f.mount();
  expect(await screen.findByRole('button', { name: 'Личный кабинет' })).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Время входа истекло');
  expect(f.transport.startYandexLogin).not.toHaveBeenCalled();
});
