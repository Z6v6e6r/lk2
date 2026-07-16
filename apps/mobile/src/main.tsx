import { Capacitor } from '@capacitor/core';
import { ApiClientError, PadlHubApiClient } from '@phub/api-sdk';
import { StrictMode, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { createRoot } from 'react-dom/client';

import padlHubLogoUrl from './assets/padlhub-logo.svg';
import vkIconUrl from './assets/vk-auth.svg';
import yandexIconUrl from './assets/yandex-auth.svg';
import './styles.css';

type AuthView = 'welcome' | 'phone' | 'code' | 'signed-in';
type OAuthProvider = 'vkid' | 'yandex';

interface PhoneChallengeState {
  readonly id: string;
  readonly phone: string;
}

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

function platform(): 'web' | 'ios' | 'android' {
  const current = Capacitor.getPlatform();
  return current === 'ios' || current === 'android' ? current : 'web';
}

function messageFor(error: unknown): string {
  if (error instanceof ApiClientError) {
    switch (error.code) {
      case 'LEGAL_ACCEPTANCE_REQUIRED':
        return 'Подтвердите публичную оферту и обработку персональных данных.';
      case 'AUTH_PHONE_INVALID':
        return 'Проверьте номер телефона.';
      case 'AUTH_CODE_INVALID':
        return 'Код не подошёл. Попробуйте ещё раз.';
      case 'AUTH_CODE_EXPIRED':
        return 'Срок действия кода истёк. Получите новый код.';
      case 'AUTH_PROVIDER_UNAVAILABLE':
        return 'Этот способ входа сейчас недоступен. Выберите номер телефона.';
      default:
        return 'Не удалось выполнить вход. Проверьте связь и попробуйте ещё раз.';
    }
  }
  return 'Не удалось выполнить вход. Проверьте связь и попробуйте ещё раз.';
}

function MobileApp(): React.JSX.Element {
  const [offerAccepted, setOfferAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [view, setView] = useState<AuthView>('welcome');
  const [phone, setPhone] = useState('+7');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<PhoneChallengeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedInName, setSignedInName] = useState<string | null>(null);
  const canContinue = offerAccepted && privacyAccepted;

  const api = useMemo(() => {
    const baseUrl = (import.meta.env.VITE_PHUB_API_BASE_URL ?? window.location.origin).replace(
      /\/$/,
      '',
    );
    const tenantKey = import.meta.env.VITE_PHUB_TENANT_KEY ?? 'local-padel';
    return new PadlHubApiClient({
      baseUrl,
      tenantKey,
      platform: platform(),
      appVersion: import.meta.env.VITE_APP_VERSION ?? 'development',
    });
  }, []);

  function requireLegalAcceptance(): boolean {
    if (canContinue) return true;
    setError('Подтвердите публичную оферту и обработку персональных данных.');
    return false;
  }

  async function handleOAuthLogin(provider: OAuthProvider): Promise<void> {
    if (!requireLegalAcceptance()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.createVivaOAuthAuthorization({
        provider,
        acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
      });
      window.location.assign(result.redirectUrl);
    } catch (requestError) {
      setError(messageFor(requestError));
      setBusy(false);
    }
  }

  function handlePhoneLogin(): void {
    if (!requireLegalAcceptance()) return;
    setError(null);
    setView('phone');
  }

  async function requestPhoneCode(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.createAuthChallenge({ method: 'phone_otp', phone });
      setChallenge({ id: result.challengeId, phone });
      setCode('');
      setView('code');
    } catch (requestError) {
      setError(messageFor(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function verifyPhoneCode(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!challenge) {
      setView('phone');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await api.verifyAuthChallenge(challenge.id, { code });
      setSignedInName(session.user.displayName);
      setView('signed-in');
    } catch (requestError) {
      setError(messageFor(requestError));
    } finally {
      setBusy(false);
    }
  }

  function returnToWelcome(): void {
    setError(null);
    setView('welcome');
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
          <div className="auth-card">
            <div className="mobile-logo">
              <PadlHubLogo />
            </div>
            <h1 id="auth-title" className="auth-badge">
              Войти в личный кабинет
            </h1>

            {view === 'welcome' ? (
              <>
                <div className="auth-actions" aria-label="Способ входа">
                  <button
                    type="button"
                    className="social-button"
                    disabled={busy}
                    onClick={() => void handleOAuthLogin('vkid')}
                  >
                    <VkIcon />
                    <span>VK ID или Mail.ru</span>
                  </button>
                  <button
                    type="button"
                    className="social-button"
                    disabled={busy}
                    onClick={() => void handleOAuthLogin('yandex')}
                  >
                    <YandexIcon />
                    <span>Yandex</span>
                  </button>
                </div>

                <div className="auth-consents">
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
                </div>

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
                  id="phone"
                  className="auth-input"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  required
                />
                <button className="form-button" type="submit" disabled={busy}>
                  {busy ? 'Отправляем…' : 'Получить код'}
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
                  id="code"
                  className="auth-input auth-input--code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                  required
                />
                <button className="form-button" type="submit" disabled={busy || code.length === 0}>
                  {busy ? 'Проверяем…' : 'Войти'}
                </button>
                <button
                  className="back-button"
                  type="button"
                  disabled={busy}
                  onClick={() => setView('phone')}
                >
                  Изменить номер
                </button>
              </form>
            ) : null}

            {view === 'signed-in' ? (
              <p className="auth-success">Готово, {signedInName ?? 'вы вошли'}.</p>
            ) : null}
            {error ? (
              <p className="auth-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </section>
      </main>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Mobile mount element was not found');
createRoot(root).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>,
);
