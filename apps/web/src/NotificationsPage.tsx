import type { NotificationInboxPage, WebPushConfiguration } from './auth-gateway.js';
import type { WebPushBrowserState } from './web-push-client.js';

interface NotificationsPageProps {
  readonly page: NotificationInboxPage;
  readonly webPush: WebPushConfiguration;
  readonly browserState: WebPushBrowserState;
  readonly busy: boolean;
  readonly error?: string | null;
  readonly onEnableWebPush: () => void;
  readonly onDisableWebPush: () => void;
  readonly onMarkAllRead: () => void;
}

function pushStatus(
  configuration: WebPushConfiguration,
  browserState: WebPushBrowserState,
): string {
  if (!configuration.enabled) return 'Push пока не включён для этой организации.';
  if (browserState === 'unsupported') return 'Этот браузер не поддерживает Web Push.';
  if (browserState === 'denied') return 'Уведомления запрещены в настройках браузера.';
  if (browserState === 'subscribed') return 'Push-оповещения включены на этом устройстве.';
  return 'Включите push, чтобы получать оповещения при закрытом кабинете.';
}

function safeDeepLink(value: string | undefined): string {
  return value?.startsWith('/') && !value.startsWith('//') && !value.includes('\\')
    ? value
    : '/notifications';
}

export function NotificationsPage({
  page,
  webPush,
  browserState,
  busy,
  error,
  onEnableWebPush,
  onDisableWebPush,
  onMarkAllRead,
}: NotificationsPageProps): React.JSX.Element {
  const canEnable =
    webPush.enabled &&
    browserState !== 'unsupported' &&
    browserState !== 'denied' &&
    browserState !== 'subscribed';

  return (
    <main className="notifications-page">
      <header className="notifications-toolbar">
        <a href="/" aria-label="Вернуться на Главную">
          ‹
        </a>
        <h1>Оповещения</h1>
        <span>{page.unreadCount}</span>
      </header>

      <section className="notifications-push-card" aria-labelledby="web-push-title">
        <div>
          <small>Web Push</small>
          <h2 id="web-push-title">Оповещения на устройстве</h2>
          <p>{pushStatus(webPush, browserState)}</p>
        </div>
        {browserState === 'subscribed' ? (
          <button type="button" disabled={busy} onClick={onDisableWebPush}>
            {busy ? 'Отключаем…' : 'Отключить'}
          </button>
        ) : (
          <button type="button" disabled={busy || !canEnable} onClick={onEnableWebPush}>
            {busy ? 'Включаем…' : 'Включить'}
          </button>
        )}
      </section>

      {error ? (
        <p className="notifications-error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="notifications-list" aria-label="Лента оповещений">
        <header>
          <h2>Последние</h2>
          {page.unreadCount > 0 && page.items.length > 0 ? (
            <button type="button" disabled={busy} onClick={onMarkAllRead}>
              Прочитать все
            </button>
          ) : null}
        </header>
        {page.items.length === 0 ? (
          <div className="notifications-empty">
            <strong>Пока тихо</strong>
            <p>Новые события появятся здесь.</p>
          </div>
        ) : (
          page.items.map((item) => (
            <a
              className={item.readAt ? 'notification-item is-read' : 'notification-item'}
              href={safeDeepLink(item.deepLink)}
              key={item.id}
            >
              <span aria-hidden="true" />
              <div>
                <small>{item.category}</small>
                <strong>{item.title}</strong>
                <p>{item.body}</p>
                <time dateTime={item.createdAt}>
                  {new Intl.DateTimeFormat('ru-RU', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  }).format(new Date(item.createdAt))}
                </time>
              </div>
            </a>
          ))
        )}
      </section>
    </main>
  );
}
