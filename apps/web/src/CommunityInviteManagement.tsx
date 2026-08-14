import { useEffect, useState } from 'react';

import type {
  CommunityDirectInviteCreated,
  CommunityDirectInvitePage,
  CommunityDirectInviteState,
} from './auth-gateway.js';

interface CommunityInviteManagementProps {
  readonly communityId: string;
  readonly issuerMembershipRevision: number;
  readonly loadInvites: (
    communityId: string,
    cursor?: string,
  ) => Promise<CommunityDirectInvitePage>;
  readonly createInvite: (
    communityId: string,
    expectedIssuerMembershipRevision: number,
  ) => Promise<CommunityDirectInviteCreated>;
  readonly revokeInvite: (
    inviteId: string,
    expectedInviteRevision: number,
  ) => Promise<CommunityDirectInviteState>;
}

function inviteLink(token: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}/community-invite#${token}`;
}

export function CommunityInviteManagement({
  communityId,
  issuerMembershipRevision,
  loadInvites,
  createInvite,
  revokeInvite,
}: CommunityInviteManagementProps): React.JSX.Element {
  const [items, setItems] = useState<CommunityDirectInvitePage['items']>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadInvites(communityId).then(
      (page) => {
        if (!active) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setLoading(false);
      },
      () => {
        if (!active) return;
        setError('Не удалось загрузить активные ссылки.');
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [communityId, loadInvites]);

  async function refresh(): Promise<void> {
    const page = await loadInvites(communityId);
    setItems(page.items);
    setNextCursor(page.nextCursor);
  }

  async function handleCreate(): Promise<void> {
    setBusy('create');
    setError(null);
    setNotice(null);
    try {
      const created = await createInvite(communityId, issuerMembershipRevision);
      setCreatedLink(inviteLink(created.token));
      await refresh();
    } catch {
      setError('Не удалось создать ссылку. Обновите данные и повторите.');
    } finally {
      setBusy(null);
    }
  }

  async function handleCopy(): Promise<void> {
    if (!createdLink) return;
    try {
      await navigator.clipboard.writeText(createdLink);
      setNotice('Ссылка скопирована.');
    } catch {
      setNotice('Скопируйте ссылку из поля вручную.');
    }
  }

  async function handleRevoke(invite: CommunityDirectInviteState): Promise<void> {
    setBusy(invite.id);
    setError(null);
    try {
      await revokeInvite(invite.id, invite.revision);
      setItems((current) => current.filter((item) => item.id !== invite.id));
    } catch {
      setError('Не удалось отозвать ссылку. Обновите список и повторите.');
    } finally {
      setBusy(null);
    }
  }

  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    setBusy('more');
    setError(null);
    try {
      const page = await loadInvites(communityId, nextCursor);
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch {
      setError('Не удалось загрузить следующую страницу.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="community-invite-management" aria-labelledby="community-invites-title">
      <header>
        <div>
          <h2 id="community-invites-title">Ссылки-приглашения</h2>
          <p>Многоразовые, действуют 7 суток и дают роль участника.</p>
        </div>
        <button type="button" disabled={busy !== null} onClick={() => void handleCreate()}>
          {busy === 'create' ? 'Создаём…' : 'Создать ссылку'}
        </button>
      </header>

      {createdLink ? (
        <div className="community-invite-created" role="status">
          <label htmlFor="community-invite-created-link">
            Новая ссылка показывается только сейчас
          </label>
          <input id="community-invite-created-link" readOnly value={createdLink} />
          <div>
            <button type="button" onClick={() => void handleCopy()}>
              Скопировать
            </button>
            <button type="button" onClick={() => setCreatedLink(null)}>
              Скрыть
            </button>
          </div>
        </div>
      ) : null}

      {notice ? <p className="community-invite-notice">{notice}</p> : null}
      {error ? (
        <p className="community-directory-error" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? <p className="community-directory-status">Загружаем ссылки…</p> : null}
      {!loading && items.length === 0 ? (
        <p className="community-invite-empty">Активных ссылок пока нет.</p>
      ) : null}

      <ul className="community-invite-list">
        {items.map((invite) => (
          <li key={invite.id}>
            <span>
              Действует до{' '}
              {new Intl.DateTimeFormat('ru-RU', {
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              }).format(new Date(invite.expiresAt))}
            </span>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void handleRevoke(invite)}
            >
              {busy === invite.id ? 'Отзываем…' : 'Отозвать'}
            </button>
          </li>
        ))}
      </ul>

      {nextCursor ? (
        <button type="button" disabled={busy !== null} onClick={() => void loadMore()}>
          {busy === 'more' ? 'Загружаем…' : 'Показать ещё'}
        </button>
      ) : null}
    </section>
  );
}
