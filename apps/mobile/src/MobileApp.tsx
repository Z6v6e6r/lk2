import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { App } from '../../web/src/App.js';
import { createBrowserAuthGateway } from '../../web/src/auth-gateway.js';
import { createNativeApiFetch, type NativeReadFailure } from './native-api-fetch.js';
import { installMobileNavigation } from './navigation.js';
import type { MobileRuntimeConfig } from './runtime-config.js';
import { MobileCacheNotice } from './MobileCacheNotice.js';
import { sessionFailureDetails } from './session-failure.js';
import { AndroidLoginGate, type StartAndroidYandexLogin } from './AndroidLoginGate.js';
import { createAndroidPushController, initialAndroidPushState } from './android-push.js';
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
  const [restoreFailure, setRestoreFailure] = useState<ReturnType<typeof sessionFailureDetails>>();
  const [staleReads, setStaleReads] = useState<StaleMobileReads>({});
  const [readDiagnostics, setReadDiagnostics] = useState<{
    failures: Partial<Record<'profile' | 'bookings', NativeReadFailure>>;
    expanded: boolean;
  }>({ failures: {}, expanded: false });
  const readFailures = readDiagnostics.failures;
  const [dataGeneration, setDataGeneration] = useState(0);
  const [devicePush, setDevicePush] = useState(initialAndroidPushState);
  const { gateway, push } = useMemo(() => {
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
      controller?.sessionExpired();
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
            fetchImplementation: createNativeApiFetch(
              config,
              undefined,
              expire,
              reads.observe,
              ({ section, failure }) => {
                if (expired) return;
                setReadDiagnostics((current) => {
                  const next = { ...current.failures };
                  if (failure) next[section] = failure;
                  else delete next[section];
                  return {
                    failures: next,
                    expanded: Object.keys(next).length > 0 && current.expanded,
                  };
                });
              },
            ),
          }
        : {}),
    });
    if (!native) return { gateway: service, push: undefined };
    const nativeGateway = {
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
      async verifyCode(input: Parameters<typeof service.verifyCode>[0]) {
        const result = await service.verifyCode(input);
        controller?.sessionReady();
        return result;
      },
      listLocations: () => reads.read(root + '/locations', () => service.listLocations()),
      async restoreSession() {
        try {
          const result = await service.restoreSession();
          if (result) controller?.sessionReady();
          return result;
        } catch (error) {
          setRestoreFailure(sessionFailureDetails(error));
          setBlocked('restore');
          throw error;
        }
      },
      async logout() {
        // Hide account data immediately; an interrupted revoke must be retried, never called success.
        setBlocked('logout');
        setReadDiagnostics({ failures: {}, expanded: false });
        setPending(true);
        try {
          await controller?.beforeLogout();
          await service.logout();
          expire();
        } finally {
          setPending(false);
        }
      },
    };
    const controller: ReturnType<typeof createAndroidPushController> = createAndroidPushController(
      nativeGateway,
      setDevicePush,
    );
    return { gateway: nativeGateway, push: controller };
  }, [config, native, onSessionExpired, startYandexLogin]);
  useEffect(() => {
    return push?.mount();
  }, [push]);
  if (blocked) {
    return (
      <main className="mobile-status">
        <h1>ПадлХАБ</h1>
        <p role={pending ? 'status' : 'alert'}>
          {pending
            ? 'Завершаем выход…'
            : blocked === 'logout'
              ? 'Выход ещё не завершён. Проверьте подключение и повторите попытку.'
              : restoreFailure?.message}
        </p>
        {blocked === 'restore' && restoreFailure && (
          <p className="mobile-error-code">Код ошибки: {restoreFailure.code}</p>
        )}
        <button
          className="viva-login-button"
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
      {Object.keys(readFailures).length > 0 && (
        <aside className="mobile-cache-notice" role="note" aria-label="Сведения об ошибке загрузки">
          <button
            type="button"
            aria-expanded={readDiagnostics.expanded}
            aria-controls="mobile-read-diagnostics"
            onClick={() =>
              setReadDiagnostics((current) => ({ ...current, expanded: !current.expanded }))
            }
          >
            Сведения об ошибке загрузки
          </button>
          <div id="mobile-read-diagnostics">
            {readDiagnostics.expanded && (
              <ul>
                {Object.entries(readFailures).map(([section, failure]) => (
                  <li key={section}>
                    <strong>{section === 'profile' ? 'Профиль' : 'Мои записи'}</strong>
                    <p className="mobile-error-code">
                      {failure.status === undefined ? '' : `HTTP ${failure.status}; `}
                      Код ошибки: {failure.code}
                    </p>
                    {failure.correlationId && (
                      <p className="mobile-error-code">Код запроса: {failure.correlationId}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      )}
      <App
        key={dataGeneration}
        gateway={gateway}
        tenantKey={config.tenantKey}
        clientPlatform={native ? 'android' : 'web'}
        androidYandexLogin={native && Boolean(startYandexLogin)}
        {...(native ? { realtimeBaseUrl: config.apiBaseUrl } : {})}
        {...(push
          ? {
              devicePush: {
                enabled: devicePush.enabled,
                state: devicePush.state,
                busy: devicePush.busy,
                ...(devicePush.error ? { error: devicePush.error } : {}),
                enable: () => {
                  void push.enable().catch(() => undefined);
                },
                disable: () => {
                  void push.disable().catch(() => undefined);
                },
              },
            }
          : {})}
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
