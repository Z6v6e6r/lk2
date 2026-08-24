import { normalizePhoneE164 } from '@phub/auth';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import type { MobileAuthApi, OAuthProvider } from './auth-api.js';
import { createMobileAuthApi } from './auth-api.js';
import {
  CODE_EXPIRED_MESSAGE,
  CODE_INVALID_MESSAGE,
  LEGAL_ACCEPTANCE_MESSAGE,
  messageForAuthError,
  PHONE_INVALID_MESSAGE,
} from './auth-errors.js';
import type { AuthNavigation } from './auth-navigation.js';
import { createBrowserAuthNavigation } from './auth-navigation.js';
import padlHubLogoUrl from './assets/padlhub-logo.svg';
import vkIconUrl from './assets/vk-auth.svg';
import yandexIconUrl from './assets/yandex-auth.svg';

type AuthView = 'welcome' | 'phone' | 'code' | 'signed-in';
type BusyAction = 'oauth' | 'challenge' | 'verification';

interface PhoneChallengeState {
  readonly id: string;
  readonly phone: string;
}

export interface MobileAuthAppProps {
  readonly api?: MobileAuthApi;
  readonly navigation?: AuthNavigation;
}

const acceptedLegalTerms = {
  publicOfferAccepted: true,
  personalDataPolicyAccepted: true,
} as const;

function VkIcon(): React.JSX.Element {
  return <img className="social-icon" src={vkIconUrl} alt="" aria-hidden="true" />;
}

function YandexIcon(): React.JSX.Element {
  return (
    <img
      className="social-icon social-icon--yandex"
      src={yandexIconUrl}
      alt=""
      aria-hidden="true"
    />
  );
}

function PadlHubLogo(): React.JSX.Element {
  return <img className="ph-logo" src={padlHubLogoUrl} alt="ПадлХАБ" />;
}

function busyMessage(action: BusyAction | null): string | null {
  switch (action) {
    case 'oauth':
      return 'Открываем выбранный способ входа…';
    case 'challenge':
      return 'Отправляем код…';
    case 'verification':
      return 'Проверяем код…';
    default:
      return null;
  }
}

export function MobileAuthApp({
  api: apiOverride,
  navigation: navigationOverride,
}: MobileAuthAppProps): React.JSX.Element {
  const api = useMemo(() => apiOverride ?? createMobileAuthApi(), [apiOverride]);
  const navigation = useMemo(
    () => navigationOverride ?? createBrowserAuthNavigation(),
    [navigationOverride],
  );
  const [offerAccepted, setOfferAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [view, setView] = useState<AuthView>('welcome');
  const [phone, setPhone] = useState('+7');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<PhoneChallengeState | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedInName, setSignedInName] = useState<string | null>(null);
  const requestInFlight = useRef(false);
  const authTitleRef = useRef<HTMLHeadingElement>(null);
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);
  const successRef = useRef<HTMLParagraphElement>(null);
  const canContinue = offerAccepted && privacyAccepted;
  const busy = busyAction !== null;

  useEffect(() => {
    const target =
      view === 'welcome'
        ? authTitleRef.current
        : view === 'phone'
          ? phoneInputRef.current
          : view === 'code'
            ? codeInputRef.current
            : successRef.current;
    target?.focus();
  }, [view]);

  function requireLegalAcceptance(): boolean {
    if (canContinue) return true;
    setError(LEGAL_ACCEPTANCE_MESSAGE);
    return false;
  }

  function beginRequest(action: BusyAction): boolean {
    if (requestInFlight.current) return false;
    requestInFlight.current = true;
    setBusyAction(action);
    setError(null);
    return true;
  }

  function finishRequest(): void {
    requestInFlight.current = false;
    setBusyAction(null);
  }

  async function handleOAuthLogin(provider: OAuthProvider): Promise<void> {
    if (!requireLegalAcceptance() || !beginRequest('oauth')) return;
    let redirectStarted = false;
    try {
      const result = await api.createVivaOAuthAuthorization({
        provider,
        acceptance: acceptedLegalTerms,
      });
      navigation.redirect(result.redirectUrl);
      redirectStarted = true;
    } catch (requestError) {
      setError(messageForAuthError(requestError));
    } finally {
      if (!redirectStarted) finishRequest();
    }
  }

  function handlePhoneLogin(): void {
    if (!requireLegalAcceptance()) return;
    setError(null);
    setView('phone');
  }

  async function requestPhoneCode(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const phoneE164 = normalizePhoneE164(phone);
    if (!phoneE164) {
      setError(PHONE_INVALID_MESSAGE);
      return;
    }
    if (!beginRequest('challenge')) return;

    try {
      const result = await api.createAuthChallenge({ method: 'phone_otp', phone: phoneE164 });
      setChallenge({ id: result.challengeId, phone: phoneE164 });
      setPhone(phoneE164);
      setCode('');
      setView('code');
    } catch (requestError) {
      setError(messageForAuthError(requestError));
    } finally {
      finishRequest();
    }
  }

  async function verifyPhoneCode(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!challenge) {
      returnToPhone();
      return;
    }
    if (code.length !== 4) {
      setError('Введите 4 цифры кода.');
      return;
    }
    if (!beginRequest('verification')) return;

    try {
      const session = await api.verifyAuthChallenge(challenge.id, {
        code,
        acceptance: acceptedLegalTerms,
      });
      setSignedInName(session.user.displayName);
      setView('signed-in');
    } catch (requestError) {
      setError(messageForAuthError(requestError));
    } finally {
      finishRequest();
    }
  }

  function returnToWelcome(): void {
    setError(null);
    setChallenge(null);
    setCode('');
    setView('welcome');
  }

  function returnToPhone(): void {
    setError(null);
    setChallenge(null);
    setCode('');
    setView('phone');
  }

  return (
    <div className="login-page">
      <div className="login-page__bg" aria-hidden="true">
        <div className="ring ring--top" />
        <div className="ring ring--bottom" />
        <div className="racket-outline">
          <div className="racket-outline__head" />
          <div className="racket-outline__handle" />
        </div>
        <div className="ball-hero" />
        <div className="court-net" />
        <div className="court-perspective" />
      </div>

      <main className="login-layout">
        <section className="login-layout__intro" aria-label="ПадлХАБ">
          <div className="login-layout__intro-inner">
            <div className="desktop-logo">
              <PadlHubLogo />
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

        <section className="login-layout__auth" aria-labelledby="auth-title">
          <div className="auth-card" aria-busy={busy}>
            <div className="mobile-logo">
              <PadlHubLogo />
            </div>
            <h1 id="auth-title" className="auth-badge" ref={authTitleRef} tabIndex={-1}>
              Войти в личный кабинет
            </h1>

            {view === 'welcome' ? (
              <>
                <div className="auth-actions" aria-label="Способ входа">
                  <button
                    type="button"
                    className="social-button"
                    disabled={busy}
                    aria-label="Войти через VK ID или Mail.ru"
                    onClick={() => void handleOAuthLogin('vkid')}
                  >
                    <VkIcon />
                    <span>VK ID или Mail.ru</span>
                  </button>
                  <button
                    type="button"
                    className="social-button"
                    disabled={busy}
                    aria-label="Войти через Yandex"
                    onClick={() => void handleOAuthLogin('yandex')}
                  >
                    <YandexIcon />
                    <span>Yandex</span>
                  </button>
                </div>

                <fieldset className="auth-consents">
                  <legend className="visually-hidden">Юридические согласия</legend>
                  <label className="consent-row">
                    <input
                      type="checkbox"
                      checked={offerAccepted}
                      onChange={(event) => setOfferAccepted(event.target.checked)}
                    />
                    <span>
                      Принимаю условия{' '}
                      <a href="/offer" target="_blank" rel="noreferrer">
                        публичной оферты
                      </a>
                    </span>
                  </label>
                  <label className="consent-row">
                    <input
                      type="checkbox"
                      checked={privacyAccepted}
                      onChange={(event) => setPrivacyAccepted(event.target.checked)}
                    />
                    <span>
                      Даю согласие на{' '}
                      <a href="/privacy" target="_blank" rel="noreferrer">
                        обработку персональных данных
                      </a>
                    </span>
                  </label>
                </fieldset>

                <button
                  type="button"
                  className="phone-login"
                  disabled={busy}
                  onClick={handlePhoneLogin}
                >
                  Войти по номеру телефона
                </button>
              </>
            ) : null}

            {view === 'phone' ? (
              <form className="auth-step" onSubmit={(event) => void requestPhoneCode(event)}>
                <p className="auth-step__description">
                  Введите номер телефона — отправим одноразовый код.
                </p>
                <label className="field-label" htmlFor="phone">
                  Номер телефона
                </label>
                <input
                  ref={phoneInputRef}
                  id="phone"
                  className="auth-input"
                  type="tel"
                  inputMode="tel"
                  enterKeyHint="send"
                  autoComplete="tel"
                  aria-describedby={error ? 'auth-error' : undefined}
                  aria-invalid={error === PHONE_INVALID_MESSAGE}
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  required
                />
                <button className="form-button" type="submit" disabled={busy}>
                  {busyAction === 'challenge' ? 'Отправляем…' : 'Получить код'}
                </button>
                <button
                  className="back-button"
                  type="button"
                  disabled={busy}
                  onClick={returnToWelcome}
                >
                  Назад
                </button>
              </form>
            ) : null}

            {view === 'code' ? (
              <form className="auth-step" onSubmit={(event) => void verifyPhoneCode(event)}>
                <p className="auth-step__description">
                  Введите код из сообщения, отправленного на {challenge?.phone}.
                </p>
                <label className="field-label" htmlFor="code">
                  Код из сообщения
                </label>
                <input
                  ref={codeInputRef}
                  id="code"
                  className="auth-input auth-input--code"
                  type="text"
                  inputMode="numeric"
                  enterKeyHint="done"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={4}
                  aria-describedby={error ? 'auth-error' : undefined}
                  aria-invalid={
                    error === CODE_INVALID_MESSAGE ||
                    error === CODE_EXPIRED_MESSAGE ||
                    error === 'Введите 4 цифры кода.'
                  }
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 4))}
                  required
                />
                <button className="form-button" type="submit" disabled={busy || code.length !== 4}>
                  {busyAction === 'verification' ? 'Проверяем…' : 'Войти'}
                </button>
                <button
                  className="back-button"
                  type="button"
                  disabled={busy}
                  onClick={returnToPhone}
                >
                  Изменить номер
                </button>
              </form>
            ) : null}

            {view === 'signed-in' ? (
              <p className="auth-success" ref={successRef} tabIndex={-1} role="status">
                Готово, {signedInName ?? 'вы вошли'}.
              </p>
            ) : null}
            {busyMessage(busyAction) ? (
              <p className="auth-status" role="status" aria-live="polite">
                {busyMessage(busyAction)}
              </p>
            ) : null}
            {error ? (
              <p id="auth-error" className="auth-error" role="alert" aria-live="assertive">
                {error}
              </p>
            ) : null}
          </div>
        </section>
      </main>
    </div>
  );
}
