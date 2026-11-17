import { useEffect, useId, useRef, useState } from 'react';

import type { AppProps } from './App.js';
import type { AuthGateway, WebPushConfiguration } from './auth-gateway.js';
import {
  enableWebPush,
  getWebPushBrowserState,
  type WebPushBrowserState,
} from './web-push-client.js';
import styles from './HomePushPrompt.module.css';

interface HomePushPromptProps {
  readonly gateway: AuthGateway;
  readonly clientPlatform: 'web' | 'android';
  readonly devicePush?: AppProps['devicePush'];
}

/** Home-only invitation. Reading state never requests permission or registers an endpoint. */
export function HomePushPrompt({ gateway, clientPlatform, devicePush }: HomePushPromptProps) {
  const [configuration, setConfiguration] = useState<WebPushConfiguration | null>(null);
  const [browserState, setBrowserState] = useState<WebPushBrowserState>('unsupported');
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabling = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const serviceWorkerUrl =
    window.__PHUB_BOOTSTRAP__?.serviceWorkerUrl ?? '/phub-notification-sw.js';

  useEffect(() => {
    if (clientPlatform === 'android') return;
    let active = true;
    const check = () => {
      if (enabling.current || document.visibilityState === 'hidden') return;
      void Promise.all([
        gateway.getWebPushConfiguration(),
        getWebPushBrowserState(serviceWorkerUrl),
      ]).then(
        ([config, state]) => {
          if (!active || enabling.current) return;
          setConfiguration(config);
          setBrowserState(state);
        },
        () => {
          // An unavailable check is not evidence that notifications are disabled.
        },
      );
    };
    check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      active = false;
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [gateway, clientPlatform, serviceWorkerUrl]);

  const state = clientPlatform === 'android' ? devicePush?.state : browserState;
  const available =
    clientPlatform === 'android'
      ? devicePush?.enabled === true
      : configuration?.enabled === true && Boolean(configuration.publicKey);
  const pending = busy || Boolean(devicePush?.busy);
  const visible =
    !dismissed &&
    available &&
    state !== undefined &&
    state !== 'unsupported' &&
    state !== 'subscribed';

  useEffect(() => {
    if (!visible) return;
    const element = dialog.current;
    const opener = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element?.showModal();
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [visible]);

  function enable() {
    if (pending || enabling.current) return;
    if (clientPlatform === 'android') {
      devicePush?.enable();
      return;
    }
    if (!configuration?.enabled || !configuration.publicKey) return;
    enabling.current = true;
    setBusy(true);
    setError(null);
    // Called directly from the click so the browser retains the user's activation.
    void enableWebPush({ gateway, publicKey: configuration.publicKey, serviceWorkerUrl })
      .then(
        () => setBrowserState('subscribed'),
        () => {
          if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
            setBrowserState('denied');
          }
          setError('Не удалось включить уведомления. Проверьте разрешение и попробуйте снова.');
        },
      )
      .finally(() => {
        enabling.current = false;
        setBusy(false);
      });
  }

  if (!visible) return null;
  const canEnable = state === 'default' || state === 'ready';
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={() => setDismissed(true)}
    >
      <div className={styles.content} aria-busy={pending}>
        <span className={styles.icon} aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path
              d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <h2 id={titleId}>Включите уведомления</h2>
        <p id={descriptionId}>Узнавайте вовремя об играх, записях и новых сообщениях.</p>
        {state === 'needs_install' ? (
          <p className={styles.hint}>
            На iPhone откройте сайт в Safari, нажмите «Поделиться» → «На экран Домой». Затем
            откройте приложение с иконки и включите уведомления.
          </p>
        ) : state === 'denied' ? (
          <p className={styles.hint}>
            {clientPlatform === 'android'
              ? 'Разрешите уведомления для ПадлхАБ в настройках телефона и вернитесь в приложение.'
              : 'Разрешите уведомления в настройках сайта в браузере и вернитесь на главную.'}
          </p>
        ) : null}
        {devicePush?.error || error ? (
          <p className={styles.error} role="alert">
            {devicePush?.error ?? error}
          </p>
        ) : null}
        {canEnable ? (
          <button className={styles.primary} type="button" disabled={pending} onClick={enable}>
            {pending ? 'Подключаем…' : 'Включить уведомления'}
          </button>
        ) : null}
        <button className={styles.later} type="button" onClick={() => setDismissed(true)}>
          {canEnable ? 'Позже' : 'Понятно'}
        </button>
        <small>Уведомления включаются для этого устройства.</small>
      </div>
    </dialog>
  );
}
