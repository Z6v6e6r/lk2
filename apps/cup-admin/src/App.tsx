import { ApiClientError } from '@phub/api-sdk';
import type { AuthenticatedSession } from '@phub/api-sdk';
import { useEffect, useMemo, useState } from 'react';

import { LocationsWorkspace } from './LocationsWorkspace.js';
import {
  createNotificationAdminClient,
  type AdminNotificationCampaignAccepted,
  type AdminNotificationCapabilities,
  type AdminNotificationChannel,
  type AdminNotificationRecipientResolution,
} from './notification-admin-client.js';

const tenantKey = import.meta.env.VITE_PHUB_TENANT_KEY ?? 'local-padel';
const client = createNotificationAdminClient({
  baseUrl: import.meta.env.VITE_PHUB_API_URL ?? '',
  tenantKey,
  appVersion: import.meta.env.VITE_PHUB_APP_VERSION ?? '0.1.0',
  ...(import.meta.env.VITE_PHUB_APP_BUILD ? { appBuild: import.meta.env.VITE_PHUB_APP_BUILD } : {}),
});

const channelCopy: Readonly<
  Record<
    AdminNotificationChannel,
    { readonly title: string; readonly description: string; readonly icon: string }
  >
> = {
  WEB_PUSH: {
    title: 'Web Push',
    description: 'Браузеры с активной подпиской ПаделХАБ',
    icon: 'W',
  },
  ANDROID_PUSH: {
    title: 'Android',
    description: 'Push через Firebase Cloud Messaging',
    icon: 'A',
  },
  IOS_PUSH: {
    title: 'iOS',
    description: 'Push через Apple Push Notification service',
    icon: 'i',
  },
  IN_APP: {
    title: 'Центр уведомлений',
    description: 'Сообщение останется в личном кабинете',
    icon: 'Ц',
  },
};

const reasonCopy: Readonly<Record<string, string>> = {
  GLOBAL_RUNTIME_DISABLED: 'Web Push выключен на сервере',
  TENANT_RUNTIME_DISABLED: 'Канал выключен для организации',
  PROVIDER_NOT_CONFIGURED: 'Не настроена учётная запись провайдера',
  FCM_ADAPTER_NOT_IMPLEMENTED: 'FCM ещё не подключён',
  APNS_ADAPTER_NOT_IMPLEMENTED: 'APNs ещё не подключён',
};

function parsePhones(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .split(/[\n,;]+/)
        .map((phone) => phone.trim())
        .filter(Boolean),
    ),
  ];
}

function errorText(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Не удалось выполнить операцию.';
}

function LoginScreen(props: {
  readonly denied: boolean;
  readonly error?: string;
  readonly onAuthorized: (session: AuthenticatedSession) => void;
}): React.JSX.Element {
  const [phone, setPhone] = useState('+7');
  const [challengeId, setChallengeId] = useState<string>();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  async function requestCode(): Promise<void> {
    setBusy(true);
    setMessage(undefined);
    try {
      const challenge = await client.requestCode(phone);
      setChallengeId(challenge.challengeId);
      setMessage('Код отправлен. Введите четыре цифры.');
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(): Promise<void> {
    if (!challengeId) return;
    setBusy(true);
    setMessage(undefined);
    try {
      props.onAuthorized(await client.verifyCode(challengeId, code));
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-mark">PH</div>
        <p className="eyebrow">PadlHub ЦУП</p>
        <h1>Операционный контур</h1>
        <p className="muted">Войдите под учётной записью с доступом в ЦУП.</p>
        {props.denied ? (
          <div className="notice danger">
            Доступ в ЦУП не выдан. Нужны роль admin и административное право.
          </div>
        ) : null}
        {props.error ? <div className="notice danger">{props.error}</div> : null}
        <label>
          Номер телефона
          <input
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="+7 999 000-00-01"
          />
        </label>
        {challengeId ? (
          <label>
            Код
            <input
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 4))}
              inputMode="numeric"
              placeholder="0000"
            />
          </label>
        ) : null}
        <button
          className="primary-button"
          type="button"
          disabled={busy || (challengeId ? code.length !== 4 : phone.length < 5)}
          onClick={() => void (challengeId ? verifyCode() : requestCode())}
        >
          {busy ? 'Подождите…' : challengeId ? 'Войти в ЦУП' : 'Получить код'}
        </button>
        {message ? <p className="form-message">{message}</p> : null}
      </section>
    </main>
  );
}

function ChannelCard(props: {
  readonly channel: AdminNotificationChannel;
  readonly capabilities?: AdminNotificationCapabilities;
  readonly selected: boolean;
  readonly onChange: (selected: boolean) => void;
}): React.JSX.Element {
  const copy = channelCopy[props.channel];
  const capability = props.capabilities?.channels.find(
    (candidate) => candidate.channel === props.channel,
  );
  const enabled = capability?.enabled ?? false;
  return (
    <label
      className={`channel-card ${props.selected ? 'selected' : ''} ${!enabled ? 'disabled' : ''}`}
    >
      <input
        type="checkbox"
        checked={props.selected}
        disabled={!enabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span className="channel-icon">{copy.icon}</span>
      <span className="channel-copy">
        <strong>{copy.title}</strong>
        <small>
          {enabled ? copy.description : (reasonCopy[capability?.reason ?? ''] ?? 'Недоступно')}
        </small>
      </span>
      <span className={`status-dot ${enabled ? 'ready' : ''}`} aria-hidden="true" />
    </label>
  );
}

function NotificationWorkspace(props: {
  readonly session: AuthenticatedSession;
  readonly onLogout: () => void;
}): React.JSX.Element {
  const [activeArea, setActiveArea] = useState<'notifications' | 'settings'>('settings');
  const [capabilities, setCapabilities] = useState<AdminNotificationCapabilities>();
  const [phonesText, setPhonesText] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [deepLink, setDeepLink] = useState('/notifications');
  const [selectedChannels, setSelectedChannels] = useState<Set<AdminNotificationChannel>>(
    () => new Set(['WEB_PUSH', 'IN_APP']),
  );
  const [resolution, setResolution] = useState<AdminNotificationRecipientResolution>();
  const [result, setResult] = useState<AdminNotificationCampaignAccepted>();
  const [busy, setBusy] = useState<'preview' | 'send'>();
  const [error, setError] = useState<string>();
  const phones = useMemo(() => parsePhones(phonesText), [phonesText]);

  useEffect(() => {
    void client
      .getCapabilities()
      .then((value) => {
        setCapabilities(value);
        setSelectedChannels((current) => {
          const next = new Set(
            [...current].filter(
              (channel) => value.channels.find((item) => item.channel === channel)?.enabled,
            ),
          );
          if (next.size === 0) {
            const fallback = value.channels.find((item) => item.enabled)?.channel;
            if (fallback) next.add(fallback);
          }
          return next;
        });
      })
      .catch((loadError: unknown) => setError(errorText(loadError)));
  }, []);

  function toggleChannel(channel: AdminNotificationChannel, selected: boolean): void {
    setSelectedChannels((current) => {
      const next = new Set(current);
      if (selected) next.add(channel);
      else next.delete(channel);
      return next;
    });
    setResult(undefined);
  }

  async function preview(): Promise<void> {
    setBusy('preview');
    setError(undefined);
    setResult(undefined);
    try {
      setResolution(await client.resolveRecipients(phones));
    } catch (previewError) {
      setResolution(undefined);
      setError(errorText(previewError));
    } finally {
      setBusy(undefined);
    }
  }

  async function send(): Promise<void> {
    setBusy('send');
    setError(undefined);
    setResult(undefined);
    try {
      const accepted = await client.createCampaign({
        phones,
        title,
        body,
        ...(deepLink.trim() ? { deepLink: deepLink.trim() } : {}),
        channels: [...selectedChannels],
      });
      setResult(accepted);
    } catch (sendError) {
      setError(errorText(sendError));
    } finally {
      setBusy(undefined);
    }
  }

  const canPreview = phones.length > 0 && !busy;
  const canSend =
    Boolean(resolution?.matched.length) &&
    title.trim().length > 0 &&
    body.trim().length > 0 &&
    selectedChannels.size > 0 &&
    !busy;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <div className="brand">
            <span className="brand-mark small">PH</span>
            <span>
              <strong>PadlHub</strong>
              <small>Центр управления</small>
            </span>
          </div>
          <nav aria-label="Разделы ЦУП">
            <button type="button" className="nav-item">
              <span>⌂</span> Обзор
            </button>
            <button
              type="button"
              className={`nav-item ${activeArea === 'notifications' ? 'active' : ''}`}
              onClick={() => setActiveArea('notifications')}
            >
              <span>↗</span> Отправка уведомлений
            </button>
            <button
              type="button"
              className={`nav-item ${activeArea === 'settings' ? 'active' : ''}`}
              onClick={() => setActiveArea('settings')}
            >
              <span>⚙</span> Настройки
            </button>
          </nav>
        </div>
        <div className="operator-card">
          <span className="operator-avatar">
            {props.session.user.displayName.slice(0, 1).toUpperCase()}
          </span>
          <span>
            <strong>{props.session.user.displayName}</strong>
            <small>{tenantKey}</small>
          </span>
          <button type="button" onClick={props.onLogout} aria-label="Выйти">
            ↪
          </button>
        </div>
      </aside>

      {activeArea === 'settings' ? (
        <LocationsWorkspace client={client} />
      ) : (
        <main className="workspace">
          <header className="workspace-header">
            <div>
              <p className="eyebrow">Оповещения</p>
              <h1>Отправка уведомлений</h1>
              <p className="muted">Выберите получателей, канал и подготовьте сообщение.</p>
            </div>
            <span className="environment-badge">LOCAL · DOCKER</span>
          </header>

          <section className="composer-grid">
            <div className="panel form-panel">
              <div className="section-heading">
                <span className="step">1</span>
                <div>
                  <h2>Получатели</h2>
                  <p>До 100 номеров, каждый с новой строки или через запятую.</p>
                </div>
              </div>
              <label>
                Номера телефонов
                <textarea
                  className="phones-input"
                  value={phonesText}
                  onChange={(event) => {
                    setPhonesText(event.target.value);
                    setResolution(undefined);
                    setResult(undefined);
                  }}
                  placeholder={'+7 999 123-45-67\n+7 999 765-43-21'}
                />
              </label>
              <div className="input-meta">
                <span>{phones.length} номеров</span>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!canPreview}
                  onClick={() => void preview()}
                >
                  {busy === 'preview' ? 'Проверяем…' : 'Проверить получателей'}
                </button>
              </div>

              <div className="section-heading separated">
                <span className="step">2</span>
                <div>
                  <h2>Способ отправки</h2>
                  <p>Недоступные провайдеры нельзя выбрать.</p>
                </div>
              </div>
              <div className="channel-grid">
                {(['WEB_PUSH', 'ANDROID_PUSH', 'IOS_PUSH', 'IN_APP'] as const).map((channel) => (
                  <ChannelCard
                    key={channel}
                    channel={channel}
                    {...(capabilities ? { capabilities } : {})}
                    selected={selectedChannels.has(channel)}
                    onChange={(selected) => toggleChannel(channel, selected)}
                  />
                ))}
              </div>

              <div className="section-heading separated">
                <span className="step">3</span>
                <div>
                  <h2>Сообщение</h2>
                  <p>Текст будет одинаковым для выбранных каналов.</p>
                </div>
              </div>
              <label>
                Заголовок
                <input
                  value={title}
                  maxLength={300}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Изменение времени игры"
                />
              </label>
              <label>
                Текст уведомления
                <textarea
                  value={body}
                  maxLength={8_000}
                  onChange={(event) => setBody(event.target.value)}
                  placeholder="Ваша игра перенесена на 19:30. Откройте приложение, чтобы посмотреть детали."
                />
              </label>
              <label>
                Ссылка внутри ПаделХАБ
                <input
                  value={deepLink}
                  onChange={(event) => setDeepLink(event.target.value)}
                  placeholder="/notifications"
                />
              </label>
            </div>

            <aside className="preview-column">
              <section className="panel preview-panel">
                <div className="section-heading compact">
                  <div>
                    <h2>Проверка получателей</h2>
                    <p>Номера не сохраняются в кампании.</p>
                  </div>
                </div>
                {!resolution ? (
                  <div className="empty-state">
                    <span>◎</span>
                    <p>Добавьте номера и запустите проверку.</p>
                  </div>
                ) : (
                  <>
                    <div className="summary-row">
                      <span className="summary success">
                        <strong>{resolution.matched.length}</strong> найдено
                      </span>
                      <span className="summary warning">
                        <strong>{resolution.unresolvedPhones.length}</strong> не найдено
                      </span>
                    </div>
                    <div className="recipient-list">
                      {resolution.matched.map((recipient) => (
                        <div className="recipient" key={recipient.userId}>
                          <span className="recipient-avatar">
                            {recipient.displayName.slice(0, 1).toUpperCase()}
                          </span>
                          <span>
                            <strong>{recipient.displayName}</strong>
                            <small>{recipient.phoneMasked}</small>
                          </span>
                          <span className="recipient-channels">
                            {recipient.availableChannels.map((channel) => (
                              <small key={channel}>{channelCopy[channel].title}</small>
                            ))}
                          </span>
                        </div>
                      ))}
                    </div>
                    {resolution.unresolvedPhones.length ? (
                      <div className="notice warning">
                        Не найдены или неоднозначны: {resolution.unresolvedPhones.join(', ')}
                      </div>
                    ) : null}
                  </>
                )}
              </section>

              <section className="panel send-panel">
                <h2>Готово к отправке</h2>
                <dl>
                  <div>
                    <dt>Получателей</dt>
                    <dd>{resolution?.matched.length ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Каналов</dt>
                    <dd>{selectedChannels.size}</dd>
                  </div>
                </dl>
                <button
                  className="primary-button"
                  type="button"
                  disabled={!canSend}
                  onClick={() => void send()}
                >
                  {busy === 'send' ? 'Создаём кампанию…' : 'Отправить уведомление'}
                </button>
                <p className="send-hint">Операция идемпотентна и записывается в аудит.</p>
                {error ? <div className="notice danger">{error}</div> : null}
                {result ? (
                  <div className="notice success">
                    Кампания принята. Inbox: {result.inAppCreatedCount}, Web Push в очереди:{' '}
                    {result.pushQueuedCount}. ID: {result.campaignId.slice(0, 8)}
                  </div>
                ) : null}
              </section>
            </aside>
          </section>
        </main>
      )}
    </div>
  );
}

export function App(): React.JSX.Element {
  const [session, setSession] = useState<AuthenticatedSession>();
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void client
      .restoreSession()
      .then((restored) => {
        if (restored) setSession(restored);
      })
      .catch((restoreError: unknown) => {
        if (
          restoreError instanceof ApiClientError &&
          restoreError.code === 'AUTH_ADMIN_ACCESS_DENIED'
        ) {
          setDenied(true);
        } else {
          setError(errorText(restoreError));
        }
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <main className="loading-screen">
        <div className="brand-mark">PH</div>
        <p>Подключаем ЦУП…</p>
      </main>
    );
  }
  if (!session) {
    return (
      <LoginScreen
        denied={denied}
        {...(error ? { error } : {})}
        onAuthorized={(authorized) => {
          setDenied(false);
          setError(undefined);
          setSession(authorized);
        }}
      />
    );
  }
  return (
    <NotificationWorkspace
      session={session}
      onLogout={() => {
        void client.logout().finally(() => setSession(undefined));
      }}
    />
  );
}
