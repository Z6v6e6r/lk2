// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiClientError } from '@phub/api-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MobileAuthApi } from './auth-api.js';
import {
  LEGAL_ACCEPTANCE_MESSAGE,
  messageForAuthError,
  UNKNOWN_AUTH_ERROR_MESSAGE,
} from './auth-errors.js';
import { createBrowserAuthNavigation } from './auth-navigation.js';
import type { AuthNavigation } from './auth-navigation.js';
import { AuthErrorBoundary } from './AuthErrorBoundary.js';
import { MobileAuthApp } from './MobileAuthApp.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function createHarness(overrides: Partial<MobileAuthApi> = {}): {
  readonly api: MobileAuthApi;
  readonly createAuthChallenge: ReturnType<typeof vi.fn>;
  readonly verifyAuthChallenge: ReturnType<typeof vi.fn>;
  readonly createVivaOAuthAuthorization: ReturnType<typeof vi.fn>;
  readonly redirect: ReturnType<typeof vi.fn>;
  readonly navigation: AuthNavigation;
} {
  const createAuthChallenge = vi.fn(() => Promise.resolve({ challengeId: 'challenge-1' }));
  const verifyAuthChallenge = vi.fn(() => Promise.resolve({ user: { displayName: 'Анна' } }));
  const createVivaOAuthAuthorization = vi.fn(() =>
    Promise.resolve({ redirectUrl: 'https://auth.example/authorize' }),
  );
  const redirect = vi.fn();

  return {
    api: {
      createAuthChallenge,
      verifyAuthChallenge,
      createVivaOAuthAuthorization,
      ...overrides,
    },
    createAuthChallenge,
    verifyAuthChallenge,
    createVivaOAuthAuthorization,
    redirect,
    navigation: { redirect },
  };
}

async function acceptLegalTerms(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('checkbox', { name: /публичной оферты/i }));
  await user.click(screen.getByRole('checkbox', { name: /обработку персональных данных/i }));
}

async function openPhoneStep(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await acceptLegalTerms(user);
  await user.click(screen.getByRole('button', { name: 'Войти по номеру телефона' }));
}

async function requestCode(
  user: ReturnType<typeof userEvent.setup>,
  phone = '89991234567',
): Promise<void> {
  await openPhoneStep(user);
  const input = screen.getByRole('textbox', { name: 'Номер телефона' });
  await user.clear(input);
  await user.type(input, phone);
  await user.click(screen.getByRole('button', { name: 'Получить код' }));
  await screen.findByRole('textbox', { name: 'Код из сообщения' });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('MobileAuthApp', () => {
  it('renders the welcome screen', () => {
    const harness = createHarness();
    render(<MobileAuthApp api={harness.api} navigation={harness.navigation} />);

    expect(screen.getByRole('heading', { name: 'Войти в личный кабинет' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Войти через VK ID или Mail.ru' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Войти через Yandex' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Войти по номеру телефона' })).toBeEnabled();
  });

  it('blocks every login method until both legal terms are accepted', async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    render(<MobileAuthApp api={harness.api} navigation={harness.navigation} />);

    await user.click(screen.getByRole('button', { name: 'Войти через VK ID или Mail.ru' }));
    expect(screen.getByRole('alert')).toHaveTextContent(LEGAL_ACCEPTANCE_MESSAGE);
    await user.click(screen.getByRole('button', { name: 'Войти через Yandex' }));
    await user.click(screen.getByRole('button', { name: 'Войти по номеру телефона' }));

    await user.click(screen.getByRole('checkbox', { name: /публичной оферты/i }));
    await user.click(screen.getByRole('button', { name: 'Войти через Yandex' }));

    expect(harness.createVivaOAuthAuthorization).not.toHaveBeenCalled();
    expect(harness.createAuthChallenge).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Номер телефона' })).not.toBeInTheDocument();
  });

  it('moves from welcome to the phone step and focuses the phone field', async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    render(<MobileAuthApp api={harness.api} navigation={harness.navigation} />);

    await openPhoneStep(user);

    expect(screen.getByRole('textbox', { name: 'Номер телефона' })).toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'Номер телефона' })).toHaveAttribute(
      'autocomplete',
      'tel',
    );
  });

  it('normalizes the phone and creates a challenge', async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    render(<MobileAuthApp api={harness.api} navigation={harness.navigation} />);

    await requestCode(user);

    expect(harness.createAuthChallenge).toHaveBeenCalledWith({
      method: 'phone_otp',
      phone: '+79991234567',
    });
    expect(screen.getByText(/отправленного на \+79991234567/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Код из сообщения' })).toHaveFocus();
  });

  it('shows a challenge error and permits a retry', async () => {
    const user = userEvent.setup();
    const error = new ApiClientError('invalid phone', 400, 'AUTH_PHONE_INVALID', 'corr-1');
    const harness = createHarness({
      createAuthChallenge: vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ challengeId: 'challenge-2' }),
    });
    render(<MobileAuthApp api={harness.api} navigation={harness.navigation} />);

    await openPhoneStep(user);
    const phone = screen.getByRole('textbox', { name: 'Номер телефона' });
    await user.clear(phone);
    await user.type(phone, '89991234567');
    await user.click(screen.getByRole('button', { name: 'Получить код' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Проверьте номер телефона.');

    await user.click(screen.getByRole('button', { name: 'Получить код' }));
    expect(await screen.findByRole('textbox', { name: 'Код из сообщения' })).toBeInTheDocument();
  });

  it('keeps only the first four OTP digits', async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    render(<MobileAuthApp api={harness.api} navigation={harness.navigation} />);
    await requestCode(user);

    const code = screen.getByRole('textbox', { name: 'Код из сообщения' });
    await user.type(code, 'a1b23456');

    expect(code).toHaveValue('1234');
    expect(code).toHaveAttribute('maxlength', '4');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
  });

  it('verifies OTP and renders the signed-in state', async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    render(<MobileAuthApp api={harness.api} navigation={harness.navigation} />);
    await requestCode(user);

    await user.type(screen.getByRole('textbox', { name: 'Код из сообщения' }), '1234');
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(harness.verifyAuthChallenge).toHaveBeenCalledWith('challenge-1', {
      code: '1234',
      acceptance: {
        publicOfferAccepted: true,
        personalDataPolicyAccepted: true,
      },
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Готово, Анна.');
  });

  it.each([
    ['AUTH_CODE_INVALID', 'Код не подошёл. Попробуйте ещё раз.'],
    ['AUTH_CODE_EXPIRED', 'Срок действия кода истёк. Получите новый код.'],
  ])('shows %s and keeps verification retryable', async (errorCode, message) => {
    const user = userEvent.setup();
    const verifyAuthChallenge = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError('OTP failed', 400, errorCode, 'corr-otp'))
      .mockResolvedValueOnce({ user: { displayName: 'Анна' } });
    const harness = createHarness({ verifyAuthChallenge });
    render(<MobileAuthApp api={harness.api} navigation={harness.navigation} />);
    await requestCode(user);
    await user.type(screen.getByRole('textbox', { name: 'Код из сообщения' }), '1234');

    await user.click(screen.getByRole('button', { name: 'Войти' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('textbox', { name: 'Код из сообщения' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByText('Готово, Анна.')).toBeInTheDocument();
    expect(verifyAuthChallenge).toHaveBeenCalledTimes(2);
  });

  it('prevents double challenge submission before React rerenders', async () => {
    const user = userEvent.setup();
    const pending = deferred<{ challengeId: string }>();
    const createAuthChallenge = vi.fn(() => pending.promise);
    const harness = createHarness({ createAuthChallenge });
    render(<MobileAuthApp api={harness.api} navigation={harness.navigation} />);
    await openPhoneStep(user);
    const input = screen.getByRole('textbox', { name: 'Номер телефона' });
    await user.clear(input);
    await user.type(input, '89991234567');
    const form = screen.getByRole('button', { name: 'Получить код' }).closest('form');

    fireEvent.submit(form!);
    fireEvent.submit(form!);

    expect(createAuthChallenge).toHaveBeenCalledTimes(1);
    pending.resolve({ challengeId: 'challenge-1' });
    await screen.findByRole('textbox', { name: 'Код из сообщения' });
  });

  it('prevents double OTP verification before React rerenders', async () => {
    const user = userEvent.setup();
    const pending = deferred<{ user: { displayName: string } }>();
    const verifyAuthChallenge = vi.fn(() => pending.promise);
    const harness = createHarness({ verifyAuthChallenge });
    render(<MobileAuthApp api={harness.api} navigation={harness.navigation} />);
    await requestCode(user);
    await user.type(screen.getByRole('textbox', { name: 'Код из сообщения' }), '1234');
    const form = screen.getByRole('button', { name: 'Войти' }).closest('form');

    fireEvent.submit(form!);
    fireEvent.submit(form!);

    expect(verifyAuthChallenge).toHaveBeenCalledTimes(1);
    pending.resolve({ user: { displayName: 'Анна' } });
    await screen.findByText('Готово, Анна.');
  });

  it.each([
    ['Войти через VK ID или Mail.ru', 'vkid'],
    ['Войти через Yandex', 'yandex'],
  ] as const)('creates an OAuth authorization for %s', async (buttonName, provider) => {
    const user = userEvent.setup();
    const harness = createHarness();
    render(<MobileAuthApp api={harness.api} navigation={harness.navigation} />);
    await acceptLegalTerms(user);

    await user.click(screen.getByRole('button', { name: buttonName }));

    expect(harness.createVivaOAuthAuthorization).toHaveBeenCalledWith({
      provider,
      acceptance: {
        publicOfferAccepted: true,
        personalDataPolicyAccepted: true,
      },
    });
    expect(harness.redirect).toHaveBeenCalledWith('https://auth.example/authorize');
  });

  it('prevents duplicate OAuth authorization requests', async () => {
    const user = userEvent.setup();
    const pending = deferred<{ redirectUrl: string }>();
    const createVivaOAuthAuthorization = vi.fn(() => pending.promise);
    const harness = createHarness({ createVivaOAuthAuthorization });
    render(<MobileAuthApp api={harness.api} navigation={harness.navigation} />);
    await acceptLegalTerms(user);
    const button = screen.getByRole('button', { name: 'Войти через VK ID или Mail.ru' });

    fireEvent.click(button);
    fireEvent.click(button);

    expect(createVivaOAuthAuthorization).toHaveBeenCalledTimes(1);
    pending.resolve({ redirectUrl: 'https://auth.example/authorize' });
    await waitFor(() => expect(harness.redirect).toHaveBeenCalledTimes(1));

    fireEvent.click(button);
    expect(createVivaOAuthAuthorization).toHaveBeenCalledTimes(1);
  });

  it('releases the OAuth guard after an error so the user can retry', async () => {
    const user = userEvent.setup();
    const createVivaOAuthAuthorization = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiClientError('provider unavailable', 503, 'AUTH_PROVIDER_UNAVAILABLE', 'corr-oauth'),
      )
      .mockResolvedValueOnce({ redirectUrl: 'https://auth.example/authorize' });
    const harness = createHarness({ createVivaOAuthAuthorization });
    render(<MobileAuthApp api={harness.api} navigation={harness.navigation} />);
    await acceptLegalTerms(user);
    const button = screen.getByRole('button', { name: 'Войти через Yandex' });

    await user.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Этот способ входа сейчас недоступен. Выберите номер телефона.',
    );
    await user.click(button);

    expect(createVivaOAuthAuthorization).toHaveBeenCalledTimes(2);
    expect(harness.redirect).toHaveBeenCalledWith('https://auth.example/authorize');
  });

  it('recovers after a network failure without remounting', async () => {
    const user = userEvent.setup();
    const createAuthChallenge = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce({ challengeId: 'challenge-2' });
    const harness = createHarness({ createAuthChallenge });
    render(<MobileAuthApp api={harness.api} navigation={harness.navigation} />);
    await openPhoneStep(user);
    const input = screen.getByRole('textbox', { name: 'Номер телефона' });
    await user.clear(input);
    await user.type(input, '89991234567');

    await user.click(screen.getByRole('button', { name: 'Получить код' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(UNKNOWN_AUTH_ERROR_MESSAGE);
    await user.click(screen.getByRole('button', { name: 'Получить код' }));

    expect(await screen.findByRole('textbox', { name: 'Код из сообщения' })).toBeInTheDocument();
  });

  it('clears challenge request state when returning to the phone step', async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    render(<MobileAuthApp api={harness.api} navigation={harness.navigation} />);
    await requestCode(user);
    await user.type(screen.getByRole('textbox', { name: 'Код из сообщения' }), '1234');

    await user.click(screen.getByRole('button', { name: 'Изменить номер' }));

    expect(screen.getByRole('textbox', { name: 'Номер телефона' })).toHaveFocus();
    expect(screen.queryByRole('textbox', { name: 'Код из сообщения' })).not.toBeInTheDocument();
  });
});

describe('auth error mapping', () => {
  it.each([
    ['LEGAL_ACCEPTANCE_REQUIRED', LEGAL_ACCEPTANCE_MESSAGE],
    ['AUTH_PHONE_INVALID', 'Проверьте номер телефона.'],
    ['AUTH_CODE_INVALID', 'Код не подошёл. Попробуйте ещё раз.'],
    ['AUTH_CODE_EXPIRED', 'Срок действия кода истёк. Получите новый код.'],
    ['AUTH_PROVIDER_UNAVAILABLE', 'Этот способ входа сейчас недоступен. Выберите номер телефона.'],
  ])('maps %s', (code, expected) => {
    expect(messageForAuthError(new ApiClientError('server message', 400, code, 'corr-map'))).toBe(
      expected,
    );
  });

  it('uses the safe generic message for unknown server and network errors', () => {
    expect(
      messageForAuthError(new ApiClientError('private server detail', 500, 'UNKNOWN', 'corr-map')),
    ).toBe(UNKNOWN_AUTH_ERROR_MESSAGE);
    expect(messageForAuthError(new TypeError('network detail'))).toBe(UNKNOWN_AUTH_ERROR_MESSAGE);
  });
});

describe('auth navigation', () => {
  it('delegates the redirect without navigating jsdom', () => {
    const assign = vi.fn();
    const location = { assign } as unknown as Location;

    createBrowserAuthNavigation(location).redirect('https://auth.example/callback');

    expect(assign).toHaveBeenCalledWith('https://auth.example/callback');
  });
});

describe('AuthErrorBoundary', () => {
  it('renders a restartable fallback after a render error', async () => {
    const user = userEvent.setup();
    let shouldThrow = true;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    function UnstableAuth(): React.JSX.Element {
      if (shouldThrow) throw new Error('render failed');
      return <p>Экран входа восстановлен</p>;
    }

    render(
      <AuthErrorBoundary>
        <UnstableAuth />
      </AuthErrorBoundary>,
    );
    expect(screen.getByRole('heading', { name: 'Не удалось открыть экран входа' })).toBeVisible();
    shouldThrow = false;

    await user.click(screen.getByRole('button', { name: 'Начать вход заново' }));

    expect(screen.getByText('Экран входа восстановлен')).toBeVisible();
  });
});
