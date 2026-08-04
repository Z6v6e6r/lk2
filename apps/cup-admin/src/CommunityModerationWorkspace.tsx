import { ApiClientError } from '@phub/api-sdk';
import { useEffect, useState } from 'react';

import type {
  AdminCommunityDirectInviteQuotaGrant,
  AdminCommunityJoinRequest,
  AdminCommunityPendingPost,
  NotificationAdminClient,
} from './notification-admin-client.js';

function errorText(error: unknown): string {
  if (error instanceof ApiClientError || error instanceof Error) return error.message;
  return 'Не удалось выполнить операцию.';
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function ModerationMediaPreview({
  client,
  communityId,
  mediaId,
}: {
  readonly client: NotificationAdminClient;
  readonly communityId: string;
  readonly mediaId: string;
}): React.JSX.Element {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void client.getCommunityModerationMediaUrl(communityId, mediaId, 'THUMBNAIL').then(
      (grant) => {
        if (active) setUrl(grant.url);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [client, communityId, mediaId]);
  if (failed) return <span className="moderation-media-failed">Превью недоступно</span>;
  return url ? (
    <img className="moderation-media-preview" src={url} alt="Изображение публикации" />
  ) : (
    <span className="moderation-media-loading">Загружаем превью…</span>
  );
}

export function CommunityModerationWorkspace({
  client,
}: {
  readonly client: NotificationAdminClient;
}): React.JSX.Element {
  const [communityId, setCommunityId] = useState('');
  const [items, setItems] = useState<readonly AdminCommunityJoinRequest[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [contentItems, setContentItems] = useState<readonly AdminCommunityPendingPost[]>([]);
  const [contentNextCursor, setContentNextCursor] = useState<string>();
  const [contentBusy, setContentBusy] = useState(false);
  const [contentReasonCodes, setContentReasonCodes] = useState<Record<string, string>>({});
  const [reasonCodes, setReasonCodes] = useState<Record<string, string>>({});
  const [grantCommunityId, setGrantCommunityId] = useState('');
  const [grantReasonCode, setGrantReasonCode] = useState('');
  const [grantTicketId, setGrantTicketId] = useState('');
  const [grantResult, setGrantResult] = useState<AdminCommunityDirectInviteQuotaGrant>();
  const [busy, setBusy] = useState<string | undefined>('load');
  const [error, setError] = useState<string>();

  async function load(cursor?: string): Promise<void> {
    setBusy(cursor ? 'more' : 'load');
    setError(undefined);
    try {
      const page = await client.listPendingCommunityJoinRequests({
        ...(communityId.trim() ? { communityId: communityId.trim() } : {}),
        ...(cursor ? { cursor } : {}),
        limit: 20,
      });
      setItems((current) => (cursor ? [...current, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setBusy(undefined);
    }
  }

  async function loadContent(cursor?: string): Promise<void> {
    setContentBusy(true);
    setError(undefined);
    try {
      const page = await client.listPendingCommunityContent({
        ...(communityId.trim() ? { communityId: communityId.trim() } : {}),
        ...(cursor ? { cursor } : {}),
        limit: 20,
      });
      setContentItems((current) => (cursor ? [...current, ...page.items] : page.items));
      setContentNextCursor(page.nextCursor);
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setContentBusy(false);
    }
  }

  useEffect(() => {
    let active = true;
    void client
      .listPendingCommunityJoinRequests({ limit: 20 })
      .then(
        (page) => {
          if (!active) return;
          setItems(page.items);
          setNextCursor(page.nextCursor);
        },
        (loadError: unknown) => {
          if (active) setError(errorText(loadError));
        },
      )
      .finally(() => {
        if (active) setBusy(undefined);
      });
    return () => {
      active = false;
    };
  }, [client]);

  useEffect(() => {
    let active = true;
    void client.listPendingCommunityContent({ limit: 20 }).then(
      (page) => {
        if (!active) return;
        setContentItems(page.items);
        setContentNextCursor(page.nextCursor);
      },
      (loadError: unknown) => {
        if (active) setError(errorText(loadError));
      },
    );
    return () => {
      active = false;
    };
  }, [client]);

  async function decide(item: AdminCommunityJoinRequest, decision: 'approve' | 'reject') {
    setBusy(item.requestId);
    setError(undefined);
    try {
      if (decision === 'approve') {
        await client.approveCommunityJoinRequest(item.requestId, {
          expectedMembershipRevision: item.membershipRevision,
          expectedRequestRevision: item.requestRevision,
        });
      } else {
        const reasonCode = reasonCodes[item.requestId]?.trim();
        if (!reasonCode || !/^[A-Z][A-Z0-9_]{1,63}$/.test(reasonCode)) {
          setError('Для отклонения укажите код причины латиницей, например PROFILE_INCOMPLETE.');
          return;
        }
        await client.rejectCommunityJoinRequest(item.requestId, {
          expectedMembershipRevision: item.membershipRevision,
          expectedRequestRevision: item.requestRevision,
          reasonCode,
        });
      }
      setItems((current) => current.filter((candidate) => candidate.requestId !== item.requestId));
    } catch (decisionError) {
      setError(errorText(decisionError));
    } finally {
      setBusy(undefined);
    }
  }

  async function createQuotaGrant(): Promise<void> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        grantCommunityId,
      ) ||
      !/^[A-Z][A-Z0-9_]{1,63}$/.test(grantReasonCode) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(grantTicketId)
    ) {
      setError('Для исключения нужны Community UUID, код причины и ticket ID.');
      return;
    }
    setBusy('quota-grant');
    setError(undefined);
    setGrantResult(undefined);
    try {
      setGrantResult(
        await client.createCommunityDirectInviteQuotaGrant(grantCommunityId, {
          reasonCode: grantReasonCode,
          ticketId: grantTicketId,
        }),
      );
    } catch (grantError) {
      setError(errorText(grantError));
    } finally {
      setBusy(undefined);
    }
  }

  async function approveContent(item: AdminCommunityPendingPost): Promise<void> {
    setContentBusy(true);
    setError(undefined);
    try {
      await client.approveCommunityPost(item.post.communityId, item.post.id, item.post.revision);
      setContentItems((current) =>
        current.filter((candidate) => candidate.post.id !== item.post.id),
      );
    } catch (approvalError) {
      setError(errorText(approvalError));
    } finally {
      setContentBusy(false);
    }
  }

  async function rejectContent(item: AdminCommunityPendingPost): Promise<void> {
    const reasonCode = contentReasonCodes[item.post.id]?.trim();
    if (!reasonCode || !/^[A-Z][A-Z0-9_]{1,63}$/.test(reasonCode)) {
      setError('Для отклонения публикации укажите код причины, например CONTENT_POLICY_VIOLATION.');
      return;
    }
    setContentBusy(true);
    setError(undefined);
    try {
      await client.rejectCommunityPost(item.post.communityId, item.post.id, {
        expectedRevision: item.post.revision,
        reasonCode,
      });
      setContentItems((current) =>
        current.filter((candidate) => candidate.post.id !== item.post.id),
      );
    } catch (rejectionError) {
      setError(errorText(rejectionError));
    } finally {
      setContentBusy(false);
    }
  }

  return (
    <main className="workspace community-moderation-workspace">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">Сообщества</p>
          <h1>Заявки на вступление</h1>
          <p className="muted">
            Каноническая очередь JOIN и REJOIN. Решение применяется доменом Communities и попадает в
            аудит.
          </p>
        </div>
        <span className="environment-badge">ЦУП · AUDITED</span>
      </header>

      <section className="panel invite-quota-grant-panel">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Контролируемое исключение</p>
            <h2>Исключение из quota DIRECT-приглашений</h2>
            <p>
              ЦУП создаёт одноразовый grant на 24 часа. Приглашение по-прежнему создаёт ACTIVE
              OWNER/ADMIN; причина и ticket сохраняются в аудите.
            </p>
          </div>
        </div>
        <div className="invite-quota-grant-grid">
          <label>
            Community UUID
            <input
              value={grantCommunityId}
              onChange={(event) => setGrantCommunityId(event.target.value.trim())}
              placeholder="11111111-1111-4111-8111-111111111111"
            />
          </label>
          <label>
            Код причины
            <input
              value={grantReasonCode}
              onChange={(event) =>
                setGrantReasonCode(
                  event.target.value
                    .toUpperCase()
                    .replace(/[^A-Z0-9_]/g, '')
                    .slice(0, 64),
                )
              }
              placeholder="OPERATIONS_EXCEPTION"
            />
          </label>
          <label>
            Ticket ID
            <input
              value={grantTicketId}
              onChange={(event) =>
                setGrantTicketId(event.target.value.replace(/[^A-Za-z0-9._:/-]/g, '').slice(0, 128))
              }
              placeholder="CUP-1842"
            />
          </label>
        </div>
        <div className="moderation-actions">
          <small className="muted">
            Grant будет погашен первым успешным ISSUE или истечёт через 24 часа.
          </small>
          <button
            className="primary-button"
            type="button"
            disabled={Boolean(busy)}
            onClick={() => void createQuotaGrant()}
          >
            {busy === 'quota-grant' ? 'Создаём…' : 'Создать quota grant'}
          </button>
        </div>
        {grantResult ? (
          <div className="notice success invite-quota-grant-result">
            <strong>Quota grant создан.</strong>
            <span>Статус: {grantResult.status}</span>
            <small>Истекает {new Date(grantResult.expiresAt).toLocaleString('ru-RU')}.</small>
          </div>
        ) : null}
      </section>

      <section className="panel moderation-filter-panel">
        <label>
          Community UUID — необязательно
          <input
            value={communityId}
            onChange={(event) => setCommunityId(event.target.value)}
            placeholder="11111111-1111-4111-8111-111111111111"
          />
        </label>
        <button
          className="secondary-button"
          type="button"
          disabled={Boolean(busy)}
          onClick={() => void Promise.all([load(), loadContent()])}
        >
          {busy === 'load' ? 'Обновляем…' : 'Обновить очередь'}
        </button>
      </section>

      {error ? <div className="notice danger">{error}</div> : null}

      <section className="panel moderation-content-panel" aria-busy={contentBusy}>
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Контент</p>
            <h2>Публикации на модерации</h2>
            <p>Очередь `MODERATED_FEED`; решение фиксируется в аудите и durable event stream.</p>
          </div>
        </div>
        {contentItems.length === 0 && !contentBusy ? (
          <div className="empty-state">
            <span>✓</span>
            <p>Публикаций на проверке нет.</p>
          </div>
        ) : null}
        {contentItems.map((item) => (
          <article className="moderation-request-card" key={item.post.id}>
            <header>
              <div>
                <p className="eyebrow">Пост {shortId(item.post.id)}</p>
                <h3>{item.post.body}</h3>
              </div>
              <span className="status-chip">PENDING</span>
            </header>
            {item.post.media?.length ? (
              <div className="moderation-media-grid" aria-label="Изображения публикации">
                {item.post.media.map((media) => (
                  <ModerationMediaPreview
                    key={media.id}
                    client={client}
                    communityId={item.post.communityId}
                    mediaId={media.id}
                  />
                ))}
              </div>
            ) : null}
            <dl>
              <div>
                <dt>Сообщество</dt>
                <dd title={item.post.communityId}>{shortId(item.post.communityId)}</dd>
              </div>
              <div>
                <dt>Автор</dt>
                <dd title={item.post.authorUserId}>{shortId(item.post.authorUserId)}</dd>
              </div>
              <div>
                <dt>Обновлён</dt>
                <dd>{new Date(item.post.updatedAt).toLocaleString('ru-RU')}</dd>
              </div>
            </dl>
            <label>
              Код причины отклонения
              <input
                value={contentReasonCodes[item.post.id] ?? ''}
                onChange={(event) =>
                  setContentReasonCodes((current) => ({
                    ...current,
                    [item.post.id]: event.target.value
                      .toUpperCase()
                      .replace(/[^A-Z0-9_]/g, '')
                      .slice(0, 64),
                  }))
                }
                maxLength={64}
                placeholder="CONTENT_POLICY_VIOLATION"
              />
            </label>
            <div className="moderation-actions">
              <small className="muted">
                Отклонённый пост скрывается. Автор может исправить его и повторно отправить на
                модерацию.
              </small>
              <button
                className="secondary-button danger-button"
                type="button"
                disabled={contentBusy || Boolean(busy)}
                onClick={() => void rejectContent(item)}
              >
                Отклонить публикацию
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={contentBusy || Boolean(busy)}
                onClick={() => void approveContent(item)}
              >
                Одобрить публикацию
              </button>
            </div>
          </article>
        ))}
        {contentNextCursor ? (
          <button
            className="secondary-button"
            type="button"
            disabled={contentBusy}
            onClick={() => void loadContent(contentNextCursor)}
          >
            {contentBusy ? 'Загружаем…' : 'Показать ещё публикации'}
          </button>
        ) : null}
      </section>

      <section className="moderation-request-list" aria-busy={Boolean(busy)}>
        {items.length === 0 && busy !== 'load' ? (
          <div className="panel empty-state">
            <span>✓</span>
            <p>Открытых заявок по выбранному фильтру нет.</p>
          </div>
        ) : null}
        {items.map((item) => (
          <article className="panel moderation-request-card" key={item.requestId}>
            <header>
              <div>
                <p className="eyebrow">
                  {item.kind === 'REJOIN' ? 'Повторный вход' : 'Вступление'}
                </p>
                <h2>Заявка {shortId(item.requestId)}</h2>
              </div>
              <span className="status-chip">PENDING</span>
            </header>
            <dl>
              <div>
                <dt>Сообщество</dt>
                <dd title={item.communityId}>{shortId(item.communityId)}</dd>
              </div>
              <div>
                <dt>Пользователь</dt>
                <dd title={item.requesterUserId}>{shortId(item.requesterUserId)}</dd>
              </div>
              <div>
                <dt>Создана</dt>
                <dd>{new Date(item.requestedAt).toLocaleString('ru-RU')}</dd>
              </div>
            </dl>
            <label>
              Код причины отклонения
              <input
                value={reasonCodes[item.requestId] ?? ''}
                onChange={(event) =>
                  setReasonCodes((current) => ({
                    ...current,
                    [item.requestId]: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''),
                  }))
                }
                maxLength={64}
                placeholder="PROFILE_INCOMPLETE"
              />
            </label>
            <div className="moderation-actions">
              <button
                className="secondary-button danger-button"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void decide(item, 'reject')}
              >
                Отклонить
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void decide(item, 'approve')}
              >
                {busy === item.requestId ? 'Применяем…' : 'Одобрить'}
              </button>
            </div>
          </article>
        ))}
      </section>

      {nextCursor ? (
        <button
          className="secondary-button"
          type="button"
          disabled={Boolean(busy)}
          onClick={() => void load(nextCursor)}
        >
          {busy === 'more' ? 'Загружаем…' : 'Показать ещё'}
        </button>
      ) : null}
    </main>
  );
}
