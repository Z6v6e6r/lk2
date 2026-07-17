import { useEffect, useState } from 'react';

import type { CommunityMembershipPage } from './auth-gateway.js';

type CommunitySummary = CommunityMembershipPage['items'][number];

interface CommunitiesPageProps {
  readonly tenantName: string;
  readonly loadPage: (cursor?: string) => Promise<CommunityMembershipPage>;
}

function initials(title: string): string {
  return title
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toLocaleUpperCase('ru-RU'))
    .join('');
}

function accent(id: string): string {
  const palette = ['#7654d7', '#76a839', '#258d72', '#bd7d24', '#3978bd'] as const;
  const hash = [...id].reduce((value, character) => value + character.charCodeAt(0), 0);
  return palette[hash % palette.length] ?? palette[0];
}

function CommunityAvatar({ community }: { readonly community: CommunitySummary }) {
  const background = accent(community.id);
  return (
    <span className="community-directory-avatar" style={{ borderColor: background }}>
      {community.logoUrl ? (
        <img src={community.logoUrl} alt="" />
      ) : (
        <i style={{ background }}>{initials(community.title)}</i>
      )}
      {community.isVerified ? <b aria-label="Проверенное сообщество">✓</b> : null}
    </span>
  );
}

function mergeCommunities(
  current: readonly CommunitySummary[],
  next: readonly CommunitySummary[],
): CommunitySummary[] {
  const byId = new Map(current.map((community) => [community.id, community]));
  next.forEach((community) => byId.set(community.id, community));
  return [...byId.values()];
}

export function CommunitiesPage({ tenantName, loadPage }: CommunitiesPageProps): React.JSX.Element {
  const [items, setItems] = useState<readonly CommunitySummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadPage().then(
      (page) => {
        if (!active) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setError(null);
        setLoading(false);
      },
      () => {
        if (!active) return;
        setError('Не удалось загрузить сообщества. Повторите попытку.');
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [loadPage]);

  function loadMore(): void {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    void loadPage(nextCursor).then(
      (page) => {
        setItems((current) => mergeCommunities(current, page.items));
        setNextCursor(page.nextCursor);
        setLoadingMore(false);
      },
      () => {
        setError('Не удалось догрузить сообщества. Повторите попытку.');
        setLoadingMore(false);
      },
    );
  }

  return (
    <main className="community-directory-page">
      <header className="community-directory-header">
        <a href="/" aria-label="Вернуться на Главную">
          ←
        </a>
        <span>{tenantName}</span>
        <h1>Мои сообщества</h1>
        <p>Ваши активные сообщества. Остальные подгружаются по мере просмотра.</p>
      </header>

      <section className="community-directory-content" aria-busy={loading || loadingMore}>
        {loading ? (
          <p className="community-directory-status" role="status">
            Загружаем сообщества…
          </p>
        ) : null}
        {!loading && items.length === 0 && !error ? (
          <p className="community-directory-status">Вы пока не состоите в сообществах.</p>
        ) : null}
        {items.length > 0 ? (
          <ul className="community-directory-list">
            {items.map((community) => (
              <li key={community.id}>
                <div className="community-directory-card">
                  <CommunityAvatar community={community} />
                  <span>
                    <strong>{community.title}</strong>
                    <small>
                      {community.unreadChatCount > 0
                        ? `Новых сообщений: ${community.unreadChatCount}`
                        : 'Нет новых сообщений'}
                    </small>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p className="community-directory-error" role="alert">
            {error}
          </p>
        ) : null}
        {nextCursor ? (
          <button type="button" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Загружаем…' : 'Показать ещё'}
          </button>
        ) : null}
      </section>
    </main>
  );
}
