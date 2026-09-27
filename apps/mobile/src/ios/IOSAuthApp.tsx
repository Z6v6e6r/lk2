import { ApiClientError } from '@phub/api-sdk';
import { maskPhone, normalizePhoneE164 } from '@phub/auth';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { FormEvent, ReactNode } from 'react';

import logo from '../assets/padlhub-logo.svg';
import './styles.css';
import { getIOSSession } from './session.js';
import type { IOSSession } from './session.js';

function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === 'AUTH_CODE_INVALID') return 'Код не подошёл. Попробуйте ещё раз.';
    if (error.code === 'AUTH_CODE_EXPIRED') return 'Код устарел. Получите новый код.';
    if (error.code === 'AUTH_RATE_LIMITED') return 'Слишком много попыток. Попробуйте чуть позже.';
  }
  return 'Не удалось подключиться. Проверьте связь и попробуйте ещё раз.';
}

function Frame({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <div className="login-page">
      <main className="login-layout">
        <section className="login-layout__intro" aria-label="ПадлХАБ">
          <div className="login-layout__intro-inner">
            <div className="desktop-logo">
              <img className="ph-logo" src={logo} alt="ПадлХАБ" />
            </div>
            <h1 className="intro-title">
              Играй.
              <br />
              Записывайся.
              <br />
              Участвуй.
            </h1>
            <p className="intro-text">
              игры, турниры и тренировки
              <br />в одном кабинете.
            </p>
          </div>
        </section>
        <section className="login-layout__auth" aria-label="Личный кабинет">
          <div className="auth-card">
            <div className="mobile-logo">
              <img className="ph-logo" src={logo} alt="ПадлХАБ" />
            </div>
            {children}
          </div>
        </section>
      </main>
    </div>
  );
}

function SignedOutForm({ session }: { readonly session: IOSSession }): React.JSX.Element {
  const [phone, setPhone] = useState('+7');
  const [code, setCode] = useState('');
  const [offer, setOffer] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [challenge, setChallenge] = useState<{ id: string; phone: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || !offer || !privacy) return;
    const normalized = normalizePhoneE164(phone);
    if (!normalized) {
      setError('Проверьте номер телефона.');
      return;
    }
    if (challenge && !/^\d{4}$/.test(code)) return;
    setBusy(true);
    setError(null);
    try {
      if (challenge) await session.verify(challenge.id, code);
      else {
        const result = await session.requestCode(normalized);
        setChallenge({ id: result.challengeId, phone: normalized });
      }
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="auth-badge">Войти в личный кабинет</h1>
      <form className="auth-step" onSubmit={(event) => void submit(event)} aria-busy={busy}>
        {challenge ? (
          <>
            <p className="auth-step__description">
              Введите код из сообщения на {maskPhone(challenge.phone)}.
            </p>
            <label className="field-label" htmlFor="ios-code">
              Код из сообщения
            </label>
            <input
              id="ios-code"
              className="auth-input auth-input--code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={4}
              pattern="[0-9]{4}"
              value={code}
              required
              disabled={busy}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 4))}
            />
          </>
        ) : (
          <>
            <p className="auth-step__description">
              Введите номер телефона — отправим одноразовый код.
            </p>
            <label className="field-label" htmlFor="ios-phone">
              Номер телефона
            </label>
            <input
              id="ios-phone"
              className="auth-input"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              disabled={busy}
              required
            />
            <div className="auth-consents">
              <label className="consent-row">
                <input
                  type="checkbox"
                  checked={offer}
                  onChange={(event) => setOffer(event.target.checked)}
                  disabled={busy}
                />
                <span>
                  Принимаю условия{' '}
                  <a
                    href={`${session.configuration.apiBaseUrl}/offer`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    публичной оферты
                  </a>
                </span>
              </label>
              <label className="consent-row">
                <input
                  type="checkbox"
                  checked={privacy}
                  onChange={(event) => setPrivacy(event.target.checked)}
                  disabled={busy}
                />
                <span>
                  Даю согласие на{' '}
                  <a
                    href={`${session.configuration.apiBaseUrl}/privacy`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    обработку персональных данных
                  </a>
                </span>
              </label>
            </div>
          </>
        )}
        <button
          className="form-button"
          type="submit"
          disabled={busy || !offer || !privacy || (challenge !== null && code.length !== 4)}
        >
          {busy ? 'Подождите…' : challenge ? 'Войти' : 'Получить код'}
        </button>
        {challenge ? (
          <button
            className="back-button"
            type="button"
            disabled={busy}
            onClick={() => {
              setChallenge(null);
              setCode('');
              setError(null);
            }}
          >
            Изменить номер или получить новый код
          </button>
        ) : null}
        {error ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </>
  );
}

function SessionScreen({ session }: { readonly session: IOSSession }): React.JSX.Element {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [contextMessage, setContextMessage] = useState<string | null>(null);
  const [checkingContext, setCheckingContext] = useState(false);

  async function checkContext(): Promise<void> {
    setCheckingContext(true);
    setContextMessage(null);
    try {
      await session.checkContext();
      setContextMessage('Подключение к личному кабинету работает.');
    } catch (error) {
      setContextMessage(errorMessage(error));
    } finally {
      setCheckingContext(false);
    }
  }

  if (state.status === 'checking') return <p role="status">Проверяем сессию…</p>;
  if (state.status === 'signed-out') return <SignedOutForm session={session} />;
  if (state.status === 'offline')
    return (
      <>
        <h1 className="auth-badge">Нет подключения</h1>
        <p className="auth-step__description" role="alert">
          {state.retry === 'logout'
            ? 'Выход ещё не завершён. Восстановите связь, чтобы завершить его.'
            : 'Не удалось проверить сохранённую сессию. Попробуйте ещё раз.'}
        </p>
        <button
          className="form-button"
          onClick={() => void (state.retry === 'logout' ? session.logout() : session.restore())}
        >
          Повторить
        </button>
      </>
    );
  return (
    <>
      <h1 className="auth-badge">Вы вошли</h1>
      <p className="auth-success">Здравствуйте, {state.session.user.displayName}.</p>
      <button
        className="form-button"
        disabled={checkingContext}
        onClick={() => void checkContext()}
      >
        Проверить подключение
      </button>
      <button
        className="back-button"
        disabled={checkingContext}
        onClick={() => void session.logout()}
      >
        Выйти
      </button>
      {contextMessage ? (
        <p className="auth-step__description" role="status">
          {contextMessage}
        </p>
      ) : null}
    </>
  );
}

export function IOSAuthApp({
  session: initial,
}: {
  readonly session?: IOSSession;
}): React.JSX.Element {
  const [session, setSession] = useState(initial);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (initial) return;
    let active = true;
    void getIOSSession().then(
      (value) => {
        if (active) setSession(value);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [initial]);
  return (
    <Frame>
      {session ? (
        <SessionScreen session={session} />
      ) : failed ? (
        <>
          <h1 className="auth-badge">Подключение пока недоступно</h1>
          <p className="auth-step__description" role="alert">
            Эта сборка приложения ещё не подключена к личному кабинету.
          </p>
        </>
      ) : (
        <p role="status">Загружаем приложение…</p>
      )}
    </Frame>
  );
}
