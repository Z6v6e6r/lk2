import { normalizePhoneE164 } from '@phub/auth';
import { PrimaryButton } from '@phub/ui';
import { useEffect, useReducer, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';

import type {
  AuthGateway,
  AuthenticatedSession,
  PhoneChallenge,
  VivaOAuthProvider,
} from './auth-gateway.js';

type View = 'restoring' | 'oauth' | 'phone' | 'otp' | 'home';
type BusyAction = 'start-viva' | 'request-code' | 'verify-code' | 'logout' | null;

interface AuthState {
  readonly view: View;
  readonly busy: BusyAction;
  readonly phoneInput: string;
  readonly phoneE164: string | null;
  readonly code: string;
  readonly challenge: PhoneChallenge | null;
  readonly session: AuthenticatedSession | null;
  readonly error: string | null;
  readonly notice: string | null;
  readonly publicOfferAccepted: boolean;
  readonly personalDataPolicyAccepted: boolean;
}

type AuthAction =
  | { readonly type: 'restore-completed'; readonly session: AuthenticatedSession | null }
  | { readonly type: 'restore-failed'; readonly message: string }
  | { readonly type: 'oauth-view' }
  | { readonly type: 'phone-changed'; readonly value: string }
  | { readonly type: 'acceptance-toggled'; readonly acceptance: 'public-offer' | 'personal-data' }
  | { readonly type: 'code-changed'; readonly value: string }
  | { readonly type: 'oauth-started' }
  | { readonly type: 'request-started' }
  | {
      readonly type: 'request-completed';
      readonly phoneE164: string;
      readonly challenge: PhoneChallenge;
    }
  | { readonly type: 'operation-failed'; readonly message: string }
  | { readonly type: 'verify-started' }
  | { readonly type: 'verify-completed'; readonly session: AuthenticatedSession }
  | { readonly type: 'edit-phone' }
  | { readonly type: 'logout-started' }
  | { readonly type: 'logout-failed'; readonly message: string }
  | { readonly type: 'logout-completed'; readonly message?: string };

const initialState: AuthState = {
  view: 'restoring',
  busy: null,
  phoneInput: '+7',
  phoneE164: null,
  code: '',
  challenge: null,
  session: null,
  error: null,
  notice: null,
  publicOfferAccepted: false,
  personalDataPolicyAccepted: false,
};

function reducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case 'restore-completed':
      return action.session
        ? { ...state, view: 'home', session: action.session, error: null }
        : { ...state, view: 'oauth', session: null, error: null };
    case 'restore-failed':
      return { ...state, view: 'oauth', error: action.message };
    case 'oauth-view':
      return { ...state, view: 'oauth', busy: null, error: null, notice: null };
    case 'phone-changed':
      return { ...state, phoneInput: action.value, error: null };
    case 'acceptance-toggled':
      return action.acceptance === 'public-offer'
        ? { ...state, publicOfferAccepted: !state.publicOfferAccepted, error: null }
        : { ...state, personalDataPolicyAccepted: !state.personalDataPolicyAccepted, error: null };
    case 'code-changed':
      return { ...state, code: action.value, error: null };
    case 'oauth-started':
      return { ...state, busy: 'start-viva', error: null, notice: null };
    case 'request-started':
      return { ...state, busy: 'request-code', error: null, notice: null };
    case 'request-completed':
      return {
        ...state,
        view: 'otp',
        busy: null,
        phoneE164: action.phoneE164,
        challenge: action.challenge,
        code: '',
        error: null,
        notice: `Код отправлен на номер ${action.challenge.maskedPhone}`,
      };
    case 'operation-failed':
      return {
        ...state,
        busy: null,
        code: state.view === 'otp' ? '' : state.code,
        error: action.message,
      };
    case 'verify-started':
      return { ...state, busy: 'verify-code', error: null, notice: null };
    case 'verify-completed':
      return {
        ...state,
        view: 'home',
        busy: null,
        code: '',
        challenge: null,
        session: action.session,
        error: null,
        notice: null,
      };
    case 'edit-phone':
      return {
        ...state,
        view: 'phone',
        busy: null,
        code: '',
        challenge: null,
        phoneE164: null,
        error: null,
        notice: null,
      };
    case 'logout-started':
      return { ...state, busy: 'logout', error: null, notice: null };
    case 'logout-failed':
      return { ...state, busy: null, error: action.message, notice: null };
    case 'logout-completed':
      return {
        ...initialState,
        view: 'oauth',
        phoneInput: state.phoneInput,
        error: action.message ?? null,
        notice: action.message ? null : 'Вы вышли из аккаунта',
      };
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function userMessage(
  error: unknown,
  operation: 'restore' | 'request' | 'verify' | 'oauth' | 'logout',
): string {
  switch (errorCode(error)) {
    case 'PHONE_INVALID':
    case 'AUTH_PHONE_INVALID':
      return 'Проверьте номер телефона.';
    case 'OTP_INVALID':
    case 'AUTH_CODE_INVALID':
      return 'Код не подошёл. Попробуйте ещё раз.';
    case 'OTP_EXPIRED':
    case 'AUTH_CODE_EXPIRED':
      return 'Срок действия кода истёк. Получите новый код.';
    case 'OTP_ATTEMPTS_EXHAUSTED':
      return 'Слишком много попыток. Получите новый код.';
    case 'RATE_LIMIT_EXCEEDED':
    case 'AUTH_RATE_LIMITED':
      return 'Слишком много запросов. Подождите немного и попробуйте снова.';
    case 'AUTH_REQUIRED':
    case 'AUTH_TOKEN_INVALID':
      return 'Сессия завершилась. Войдите ещё раз.';
    case 'AUTH_PROVIDER_UNAVAILABLE':
      return 'Вход через Viva сейчас недоступен. Проверьте настройку OAuth или повторите позже.';
    case 'LEGAL_ACCEPTANCE_REQUIRED':
      return 'Подтвердите публичную оферту и обработку персональных данных.';
  }

  if (operation === 'restore') {
    return 'Не удалось проверить сессию. Войдите по номеру телефона.';
  }
  if (operation === 'logout') {
    return 'Не удалось выйти: сессия осталась активной. Проверьте связь и повторите.';
  }
  if (operation === 'oauth') {
    return 'Не удалось открыть вход через Viva. Попробуйте ещё раз.';
  }
  return operation === 'request'
    ? 'Не удалось отправить код. Проверьте связь и попробуйте снова.'
    : 'Не удалось войти. Проверьте связь и попробуйте снова.';
}

function Brand(): React.JSX.Element {
  return (
    <div className="brand" aria-label="PadlHub">
      <span className="brand-mark" aria-hidden="true">
        P
      </span>
      <span>PadlHub</span>
    </div>
  );
}

function BusyStatus({ action }: { readonly action: BusyAction }): React.JSX.Element {
  const message =
    action === 'start-viva'
      ? 'Открываем вход через Viva…'
      : action === 'request-code'
        ? 'Отправляем код…'
        : action === 'verify-code'
          ? 'Проверяем код…'
          : action === 'logout'
            ? 'Завершаем сессию…'
            : '';
  return (
    <p className="sr-only" role="status" aria-live="polite">
      {message}
    </p>
  );
}

function VivaProviderIcon({
  provider,
}: {
  readonly provider: VivaOAuthProvider;
}): React.JSX.Element {
  return provider === 'vkid' ? (
    <span className="viva-provider-icon viva-provider-icon--vk" aria-hidden="true">
      VK
    </span>
  ) : (
    <span className="viva-provider-icon viva-provider-icon--yandex" aria-hidden="true">
      Я
    </span>
  );
}

export interface AppProps {
  readonly gateway: AuthGateway;
  readonly tenantKey: string;
}

export function App({ gateway, tenantKey }: AppProps): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const phoneInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void gateway.restoreSession().then(
      (session) => {
        if (active) dispatch({ type: 'restore-completed', session });
      },
      (error: unknown) => {
        if (active) dispatch({ type: 'restore-failed', message: userMessage(error, 'restore') });
      },
    );
    return () => {
      active = false;
    };
  }, [gateway]);

  useEffect(() => {
    if (state.busy) return;
    if (state.view === 'phone') phoneInput.current?.focus();
    if (state.view === 'otp') codeInput.current?.focus();
  }, [state.busy, state.view]);

  useEffect(() => {
    if (state.view !== 'otp' || !state.challenge) return;
    const interval = window.setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [state.challenge, state.view]);

  function requestCode(phoneE164: string): void {
    dispatch({ type: 'request-started' });
    void gateway.requestCode(phoneE164).then(
      (challenge) => dispatch({ type: 'request-completed', phoneE164, challenge }),
      (error: unknown) => {
        dispatch({ type: 'operation-failed', message: userMessage(error, 'request') });
      },
    );
  }

  function handlePhoneSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const phoneE164 = normalizePhoneE164(state.phoneInput);
    if (!phoneE164) {
      dispatch({ type: 'operation-failed', message: 'Введите российский номер в формате +7.' });
      return;
    }
    requestCode(phoneE164);
  }

  function handleCodeSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!state.challenge || state.code.length !== 4) {
      dispatch({ type: 'operation-failed', message: 'Введите код из четырёх цифр.' });
      return;
    }
    dispatch({ type: 'verify-started' });
    void gateway.verifyCode({ challengeId: state.challenge.challengeId, code: state.code }).then(
      (session) => dispatch({ type: 'verify-completed', session }),
      (error: unknown) => {
        dispatch({ type: 'operation-failed', message: userMessage(error, 'verify') });
      },
    );
  }

  function handlePhoneChange(event: ChangeEvent<HTMLInputElement>): void {
    dispatch({ type: 'phone-changed', value: event.currentTarget.value });
  }

  function startVivaOAuth(provider: VivaOAuthProvider): void {
    if (!state.publicOfferAccepted || !state.personalDataPolicyAccepted) {
      dispatch({
        type: 'operation-failed',
        message: 'Подтвердите публичную оферту и согласие на обработку персональных данных.',
      });
      return;
    }
    dispatch({ type: 'oauth-started' });
    void gateway
      .startVivaOAuth({
        provider,
        acceptance: {
          publicOfferAccepted: state.publicOfferAccepted,
          personalDataPolicyAccepted: state.personalDataPolicyAccepted,
        },
      })
      .catch((error: unknown) => {
        dispatch({
          type: 'operation-failed',
          message: userMessage(error, 'oauth'),
        });
      });
  }

  function handleCodeChange(event: ChangeEvent<HTMLInputElement>): void {
    const code = event.currentTarget.value.replace(/\D/g, '').slice(0, 4);
    dispatch({ type: 'code-changed', value: code });
  }

  function handleLogout(): void {
    dispatch({ type: 'logout-started' });
    void gateway.logout().then(
      () => dispatch({ type: 'logout-completed' }),
      (error: unknown) => {
        dispatch({ type: 'logout-failed', message: userMessage(error, 'logout') });
      },
    );
  }

  if (state.view === 'restoring') {
    return (
      <main className="app-shell app-shell-loading" aria-labelledby="restore-title">
        <Brand />
        <section className="loading-card" aria-busy="true">
          <span className="loader" aria-hidden="true" />
          <h1 id="restore-title">Открываем личный кабинет</h1>
          <p role="status">Проверяем сессию…</p>
        </section>
      </main>
    );
  }

  if (state.view === 'home' && state.session) {
    const { context } = state.session;
    return (
      <main className="app-shell home-shell" aria-labelledby="home-title">
        <header className="topbar">
          <Brand />
          <span className="tenant-chip">{context.tenant.name}</span>
        </header>

        <section className="home-card">
          <div className="home-copy">
            <span className="eyebrow">Личный кабинет</span>
            <h1 id="home-title">{context.user.displayName}</h1>
            <p>Вы вошли в PadlHub. Профиль и контекст клуба загружены из защищённого API.</p>
          </div>

          <dl className="context-list" aria-label="Данные аккаунта">
            <div>
              <dt>Клуб</dt>
              <dd>{context.tenant.name}</dd>
            </div>
            <div>
              <dt>Профиль</dt>
              <dd>{context.user.phoneMasked ?? 'Номер подтверждён'}</dd>
            </div>
          </dl>

          <button
            className="secondary-button logout-button"
            type="button"
            disabled={state.busy === 'logout'}
            aria-busy={state.busy === 'logout'}
            onClick={handleLogout}
          >
            {state.busy === 'logout' ? 'Выходим…' : 'Выйти'}
          </button>
          {state.error ? (
            <p className="error-message" role="alert">
              {state.error}
            </p>
          ) : null}
          <BusyStatus action={state.busy} />
        </section>
      </main>
    );
  }

  const isRequesting = state.busy === 'request-code';
  const isVerifying = state.busy === 'verify-code';
  const isStartingViva = state.busy === 'start-viva';
  const resendSeconds = state.challenge
    ? Math.max(0, Math.ceil((Date.parse(state.challenge.resendAt) - currentTime) / 1000))
    : 0;
  const errorId = state.error ? 'auth-error' : undefined;

  return (
    <main className="auth-layout" aria-labelledby="auth-title">
      <section className="auth-intro" aria-label="PadlHub">
        <Brand />
        <div>
          <span className="eyebrow">Всё для игры</span>
          <p className="intro-title">Ваш падел в одном месте</p>
          <p className="intro-copy">Один аккаунт для клуба, игр и турниров.</p>
        </div>
        <span className="tenant-note">{tenantKey}</span>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          {state.view === 'oauth' ? (
            <>
              <span className="step-label">Вход через Viva</span>
              <h1 id="auth-title">Войти в личный кабинет</h1>
              <p className="form-lead">
                Используйте привычный аккаунт Viva. После входа мы безопасно откроем ваш кабинет
                ПадлХАБ.
              </p>

              <div className="viva-login-options" aria-label="Способ входа через Viva">
                <button
                  className="viva-login-button"
                  type="button"
                  disabled={isStartingViva}
                  onClick={() => startVivaOAuth('vkid')}
                >
                  <VivaProviderIcon provider="vkid" />
                  <span>VK ID или Mail.ru</span>
                </button>
                <button
                  className="viva-login-button"
                  type="button"
                  disabled={isStartingViva}
                  onClick={() => startVivaOAuth('yandex')}
                >
                  <VivaProviderIcon provider="yandex" />
                  <span>Yandex</span>
                </button>
              </div>

              <div className="legal-acceptances">
                <label className="legal-acceptance">
                  <input
                    type="checkbox"
                    checked={state.publicOfferAccepted}
                    disabled={isStartingViva}
                    onChange={() =>
                      dispatch({ type: 'acceptance-toggled', acceptance: 'public-offer' })
                    }
                  />
                  <span>
                    Принимаю условия{' '}
                    <a href="/documents/public-offer" target="_blank" rel="noreferrer">
                      публичной оферты
                    </a>
                  </span>
                </label>
                <label className="legal-acceptance">
                  <input
                    type="checkbox"
                    checked={state.personalDataPolicyAccepted}
                    disabled={isStartingViva}
                    onChange={() =>
                      dispatch({ type: 'acceptance-toggled', acceptance: 'personal-data' })
                    }
                  />
                  <span>
                    Даю согласие на{' '}
                    <a href="/documents/personal-data-policy" target="_blank" rel="noreferrer">
                      обработку персональных данных
                    </a>
                  </span>
                </label>
              </div>

              {state.error ? (
                <p id="auth-error" className="error-message" role="alert">
                  {state.error}
                </p>
              ) : null}
              <button
                className="text-button auth-alternative"
                type="button"
                disabled={isStartingViva}
                onClick={() => dispatch({ type: 'edit-phone' })}
              >
                Войти по номеру телефона
              </button>
            </>
          ) : state.view === 'phone' ? (
            <>
              <span className="step-label">Шаг 1 из 2</span>
              <h1 id="auth-title">Вход по номеру</h1>
              <p className="form-lead">Мы отправим короткий код для подтверждения.</p>

              <form onSubmit={handlePhoneSubmit} noValidate aria-busy={isRequesting}>
                <label htmlFor="phone">Номер телефона</label>
                <input
                  ref={phoneInput}
                  id="phone"
                  name="phone"
                  className="text-input"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={state.phoneInput}
                  placeholder="+7 999 000-00-01"
                  aria-describedby={`phone-help${errorId ? ` ${errorId}` : ''}`}
                  aria-invalid={Boolean(state.error)}
                  disabled={isRequesting}
                  required
                  onChange={handlePhoneChange}
                />
                <p id="phone-help" className="field-help">
                  Укажите российский номер с кодом +7.
                </p>

                {state.error ? (
                  <p id="auth-error" className="error-message" role="alert">
                    {state.error}
                  </p>
                ) : null}
                {state.notice ? (
                  <p className="notice-message" role="status" aria-live="polite">
                    {state.notice}
                  </p>
                ) : null}

                <PrimaryButton
                  className="primary-button"
                  type="submit"
                  disabled={isRequesting}
                  aria-busy={isRequesting}
                >
                  {isRequesting ? 'Отправляем…' : 'Получить код'}
                </PrimaryButton>
              </form>

              {import.meta.env.DEV ? (
                <p className="dev-hint">Тестовый вход: +79990000001 / 0000</p>
              ) : null}
              <button
                className="text-button auth-alternative"
                type="button"
                onClick={() => dispatch({ type: 'oauth-view' })}
              >
                ← Войти через Viva
              </button>
            </>
          ) : (
            <>
              <span className="step-label">Шаг 2 из 2</span>
              <h1 id="auth-title">Введите код</h1>
              <p className="form-lead">
                Код из четырёх цифр отправлен на {state.challenge?.maskedPhone}.
              </p>

              <form onSubmit={handleCodeSubmit} noValidate aria-busy={isVerifying || isRequesting}>
                <label htmlFor="otp">Код из СМС</label>
                <input
                  ref={codeInput}
                  id="otp"
                  name="otp"
                  className="text-input otp-input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{4}"
                  maxLength={4}
                  value={state.code}
                  aria-describedby={`otp-help${errorId ? ` ${errorId}` : ''}`}
                  aria-invalid={Boolean(state.error)}
                  disabled={isVerifying || isRequesting}
                  required
                  onChange={handleCodeChange}
                />
                <p id="otp-help" className="field-help">
                  Можно вставить код целиком.
                </p>

                {state.error ? (
                  <p id="auth-error" className="error-message" role="alert">
                    {state.error}
                  </p>
                ) : null}
                {state.notice ? (
                  <p className="notice-message" role="status" aria-live="polite">
                    {state.notice}
                  </p>
                ) : null}

                <PrimaryButton
                  className="primary-button"
                  type="submit"
                  disabled={isVerifying || isRequesting}
                  aria-busy={isVerifying}
                >
                  {isVerifying ? 'Проверяем…' : 'Войти'}
                </PrimaryButton>
              </form>

              <div className="form-actions">
                <button
                  className="text-button"
                  type="button"
                  disabled={isVerifying || isRequesting}
                  onClick={() => dispatch({ type: 'edit-phone' })}
                >
                  Изменить номер
                </button>
                <button
                  className="text-button"
                  type="button"
                  disabled={isVerifying || isRequesting || !state.phoneE164 || resendSeconds > 0}
                  onClick={() => {
                    if (state.phoneE164) requestCode(state.phoneE164);
                  }}
                >
                  {isRequesting
                    ? 'Отправляем…'
                    : resendSeconds > 0
                      ? `Новый код через ${resendSeconds} с`
                      : 'Получить новый код'}
                </button>
              </div>
            </>
          )}
          <BusyStatus action={state.busy} />
        </div>
      </section>
    </main>
  );
}
