import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

interface Acceptance {
  readonly publicOfferAccepted: boolean;
  readonly personalDataPolicyAccepted: boolean;
}
interface LoginStatus {
  readonly state: 'idle' | 'waiting' | 'complete';
}
export interface AndroidYandexPlugin {
  startYandexLogin(input: Acceptance): Promise<LoginStatus>;
  yandexLoginStatus(): Promise<LoginStatus>;
  cancelYandexLogin(): Promise<LoginStatus>;
  addListener(event: 'yandexLoginChanged', listener: () => void): Promise<PluginListenerHandle>;
}
const plugin = registerPlugin<AndroidYandexPlugin>('PadlHubAndroidSession');
export type StartAndroidYandexLogin = (acceptance: Acceptance) => Promise<void>;

/** Only state crosses the bridge. The native journal owns codes, verifier and session recovery. */
export function AndroidLoginGate({
  children,
  transport = plugin,
}: {
  readonly children: (start: StartAndroidYandexLogin) => ReactNode;
  readonly transport?: AndroidYandexPlugin;
}): React.JSX.Element {
  const [phase, setPhase] = useState<'checking' | 'idle' | 'waiting' | 'retry'>('checking');
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const checkRef = useRef<() => Promise<void>>(() => Promise.resolve());
  useEffect(() => {
    let alive = true;
    let running = false;
    let again = false;
    const check = async (): Promise<void> => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      do {
        again = false;
        if (alive) setWorking(true);
        try {
          const result = await transport.yandexLoginStatus();
          if (alive) setPhase(result.state === 'waiting' ? 'waiting' : 'idle');
        } catch (error) {
          if (alive) {
            const expired =
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              error.code === 'NATIVE_OAUTH_EXPIRED';
            setMessage(
              expired
                ? 'Время входа истекло. Начните вход заново.'
                : 'Не удалось завершить вход. Проверьте подключение и повторите попытку.',
            );
            setPhase(expired ? 'idle' : 'retry');
          }
        }
      } while (again && alive);
      running = false;
      if (alive) setWorking(false);
    };
    checkRef.current = check;
    const listener = transport.addListener('yandexLoginChanged', () => {
      void check();
    });
    void listener.then(
      () => check(),
      () => {
        if (alive) {
          setPhase('retry');
          setMessage('Не удалось подготовить вход. Повторите попытку.');
        }
      },
    );
    return () => {
      alive = false;
      void listener.then(
        (handle) => handle.remove(),
        () => undefined,
      );
    };
  }, [transport]);

  const start = useCallback(
    async (acceptance: Acceptance): Promise<void> => {
      setMessage('');
      setPhase('waiting');
      setWorking(true);
      try {
        await transport.startYandexLogin(acceptance);
      } catch {
        setMessage('Не удалось открыть Яндекс. Повторите попытку.');
      } finally {
        await checkRef.current();
      }
    },
    [transport],
  );

  if (phase === 'idle')
    return (
      <>
        {message && (
          <p className="mobile-cache-notice" role="alert">
            {message}
          </p>
        )}
        {children(start)}
      </>
    );
  return (
    <main className="mobile-status mobile-oauth-status" aria-labelledby="yandex-login-title">
      <h1 id="yandex-login-title">Вход через Яндекс</h1>
      <p role={message ? 'alert' : 'status'}>
        {message ||
          (phase === 'checking' || working
            ? 'Проверяем вход…'
            : 'Завершите вход в браузере. После подтверждения вы вернётесь в приложение.')}
      </p>
      <button
        className="viva-login-button"
        type="button"
        disabled={working}
        onClick={() => {
          void checkRef.current();
        }}
      >
        {phase === 'waiting' ? 'Проверить вход' : 'Повторить'}
      </button>
      {phase === 'waiting' && (
        <button
          className="text-button"
          type="button"
          disabled={working}
          onClick={() => {
            setWorking(true);
            void transport
              .cancelYandexLogin()
              .then(
                () => {
                  setMessage('');
                  setPhase('idle');
                },
                () => {
                  setMessage('Вход уже подтверждён. Завершите его проверку.');
                  setPhase('retry');
                },
              )
              .finally(() => setWorking(false));
          }}
        >
          Отменить вход
        </button>
      )}
    </main>
  );
}
