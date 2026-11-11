import type { WebPushConfiguration } from './auth-gateway.js';
import type { WebPushBrowserState } from './web-push-client.js';

export interface PushOptInPageProps {
  readonly webPush: WebPushConfiguration | null;
  readonly browserState: WebPushBrowserState;
  readonly busy: boolean;
  readonly error: string | null;
  readonly ios: boolean;
  /** Community URL from the authenticated PadlHub page; null for direct visits. */
  readonly returnTo: string | null;
  readonly onEnable: () => void;
}

function statusText(browserState: WebPushBrowserState): string | null {
  switch (browserState) {
    case 'denied':
      return 'Браузер запретил уведомления. Разрешите их в настройках сайта и обновите страницу.';
    case 'subscribed':
      return 'Уведомления включены на этом устройстве.';
    case 'unsupported':
      return null;
    case 'default':
    case 'ready':
      return null;
    default:
      return null;
  }
}

/**
 * Exhibition return point for Web Push: the subscription is created on the LK2
 * origin (the only origin allowed to host the service worker) and then the
 * visitor returns to the community page in the existing LK1 UI.
 */
export function PushOptInPage({
  webPush,
  browserState,
  busy,
  error,
  ios,
  returnTo,
  onEnable,
}: PushOptInPageProps): React.JSX.Element {
  const enabled = webPush?.enabled === true && Boolean(webPush.publicKey);
  const subscribed = browserState === 'subscribed';
  const status = enabled ? statusText(browserState) : null;
  const unsupported = browserState === 'unsupported';
  const canEnable = enabled && !subscribed && !unsupported && browserState !== 'denied';
  return (
    <main className="push-opt-in-page">
      <header className="push-opt-in-header">
        <h1>Уведомления о результатах</h1>
      </header>
      <section className="push-opt-in-content" aria-busy={busy}>
        <article className="push-opt-in-card">
          <p className="push-opt-in-lead">
            Включите уведомления — пришлём результаты выставки, приглашение на командную тренировку
            и информацию о розыгрыше подписок.
          </p>

          {!webPush ? (
            <p className="push-opt-in-status" role="status">
              Проверяем доступность уведомлений…
            </p>
          ) : !enabled ? (
            <p className="push-opt-in-status" role="status">
              Уведомления пока недоступны для этой организации. Результаты выставки будут в
              сообществе.
            </p>
          ) : subscribed ? (
            <p className="push-opt-in-status push-opt-in-status--success" role="status">
              Уведомления включены на этом устройстве.
            </p>
          ) : (
            <>
              {status ? (
                <p
                  className={
                    browserState === 'denied' ? 'push-opt-in-status' : 'push-opt-in-status'
                  }
                  role={browserState === 'denied' ? 'alert' : 'status'}
                >
                  {status}
                </p>
              ) : null}
              {unsupported ? (
                <div className="push-opt-in-hint" role="status">
                  <strong>
                    {ios
                      ? 'На iPhone уведомления работают только из приложения на экране «Домой»'
                      : 'Этот браузер не поддерживает уведомления'}
                  </strong>
                  <span>
                    {ios
                      ? 'Откройте сайт в Safari, нажмите «Поделиться» → «На экран Домой», затем откройте сайт с иконки и включите уведомления здесь.'
                      : 'Откройте эту страницу в современном браузере (Chrome, Safari, Firefox), чтобы включить уведомления.'}
                  </span>
                </div>
              ) : canEnable ? (
                <button
                  className="push-opt-in-primary"
                  type="button"
                  disabled={busy}
                  onClick={onEnable}
                >
                  {busy ? 'Подключаем…' : 'Включить уведомления'}
                </button>
              ) : null}
            </>
          )}

          {error ? (
            <p className="push-opt-in-error" role="alert">
              {error}
            </p>
          ) : null}

          {returnTo ? (
            <a className="push-opt-in-link" href={returnTo}>
              Вернуться в сообщество
            </a>
          ) : (
            <a className="push-opt-in-link" href="/notifications">
              Перейти к уведомлениям
            </a>
          )}
          <p className="push-opt-in-note">Уведомления приходят только на это устройство.</p>
        </article>
      </section>
    </main>
  );
}
