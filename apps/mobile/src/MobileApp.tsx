import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { App } from '../../web/src/App.js';
import { createBrowserAuthGateway } from '../../web/src/auth-gateway.js';
import { createNativeApiFetch } from './native-api-fetch.js';
import { installMobileNavigation } from './navigation.js';
import type { MobileRuntimeConfig } from './runtime-config.js';
import { MobileCacheNotice } from './MobileCacheNotice.js';
import { AndroidLoginGate, type StartAndroidYandexLogin } from './AndroidLoginGate.js';
import {
  createMobileReadState,
  observeMobileCache,
  type StaleMobileReads,
} from './mobile-read-cache.js';

interface MobileAppProps {
  readonly config: MobileRuntimeConfig;
  readonly native: boolean;
}

function MobileSession({
  config,
  native,
  onSessionExpired,
  startYandexLogin,
}: MobileAppProps & {
  readonly onSessionExpired: () => void;
  readonly startYandexLogin?: StartAndroidYandexLogin;
}): React.JSX.Element {
  const [blocked, setBlocked] = useState<'restore' | 'logout' | null>(null);
  const [pending, setPending] = useState(false);
  const [staleReads, setStaleReads] = useState<StaleMobileReads>({});
  const [dataGeneration, setDataGeneration] = useState(0);
  const gateway = useMemo(() => {
    let expired = false;
    const root = `/user/api/v1/${config.tenantKey}`;
    const reads = createMobileReadState(
      (observation) => setStaleReads((current) => observeMobileCache(current, observation)),
      () => {
        setStaleReads({});
        setDataGeneration((current) => current + 1);
      },
    );
    const expire = (): void => {
      if (expired) return;
      expired = true;
      window.history.replaceState({}, '', '/');
      onSessionExpired();
    };
    const service = createBrowserAuthGateway({
      baseUrl: config.apiBaseUrl,
      tenantKey: config.tenantKey,
      appVersion: config.appVersion,
      platform: native ? 'android' : 'web',
      nativeSessionTransport: native,
      ...(native
        ? {
            fetchImplementation: createNativeApiFetch(config, undefined, expire, reads.observe),
          }
        : {}),
    });
    if (!native) return service;
    return {
      ...service,
      ...(startYandexLogin
        ? {
            startVivaOAuth: async (input: Parameters<typeof service.startVivaOAuth>[0]) => {
              if (input.provider !== 'yandex')
                throw new Error('Native identity provider unavailable');
              await startYandexLogin(input.acceptance);
            },
          }
        : {}),
      getHomeBase: () => reads.read(root + '/home/base', () => service.getHomeBase()),
      listLocations: () => reads.read(root + '/locations', () => service.listLocations()),
      async restoreSession() {
        try {
          return await service.restoreSession();
        } catch (error) {
          setBlocked('restore');
          throw error;
        }
      },
      async logout() {
        // Hide account data immediately; an interrupted revoke must be retried, never called success.
        setBlocked('logout');
        setPending(true);
        try {
          await service.logout();
          expire();
        } finally {
          setPending(false);
        }
      },
    };
  }, [config, native, onSessionExpired, startYandexLogin]);
  if (blocked) {
    return (
      <main className="mobile-status">
        <h1>ПадлХАБ</h1>
        <p role={pending ? 'status' : 'alert'}>
          {pending
            ? 'Завершаем выход…'
            : blocked === 'logout'
              ? 'Выход ещё не завершён. Проверьте подключение и повторите попытку.'
              : 'Не удалось проверить сохранённый вход. Проверьте подключение и повторите попытку.'}
        </p>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (blocked === 'logout') void gateway.logout().catch(() => undefined);
            else onSessionExpired();
          }}
        >
          Повторить
        </button>
      </main>
    );
  }
  return (
    <>
      <MobileCacheNotice stale={staleReads} />
      <App
        key={dataGeneration}
        gateway={gateway}
        tenantKey={config.tenantKey}
        clientPlatform={native ? 'android' : 'web'}
        androidYandexLogin={native && Boolean(startYandexLogin)}
      />
    </>
  );
}

export function MobileApp(props: MobileAppProps): React.JSX.Element {
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const expire = useCallback(() => setSessionGeneration((value) => value + 1), []);
  useEffect(() => installMobileNavigation(document, window), []);
  return (
    <Suspense
      fallback={
        <main className="mobile-status" role="status">
          Открываем личный кабинет…
        </main>
      }
    >
      {props.native ? (
        <AndroidLoginGate key={sessionGeneration}>
          {(startYandexLogin) => (
            <MobileSession
              {...props}
              startYandexLogin={startYandexLogin}
              onSessionExpired={expire}
            />
          )}
        </AndroidLoginGate>
      ) : (
        <MobileSession key={sessionGeneration} {...props} onSessionExpired={expire} />
      )}
    </Suspense>
  );
}
