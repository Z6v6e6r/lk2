import { useEffect, useState, type FormEvent } from 'react';

import type { CommunityDiscoveryPage, CommunityMembershipPage } from './auth-gateway.js';

type CommunitySummary = CommunityMembershipPage['items'][number];

interface CommunitiesPageProps {
  readonly tenantName: string;
  readonly loadPage: (cursor?: string) => Promise<CommunityMembershipPage>;
  readonly discoverPage: (query?: string, cursor?: string) => Promise<CommunityDiscoveryPage>;
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

interface CommunityAvatarRecord {
  readonly id: string;
  readonly title: string;
  readonly logoUrl: string | null;
  readonly isVerified: boolean;
}

function CommunityAvatar({ community }: { readonly community: CommunityAvatarRecord }) {
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

function discoveryHint(item: CommunityDiscoveryPage['items'][number]): string {
  if (item.visibility === 'LISTED_PRIVATE') return 'Закрытое сообщество';
  return `${item.memberCount} участников`;
}

export function CommunitiesPage({
  tenantName,
  loadPage,
  discoverPage,
}: CommunitiesPageProps): React.JSX.Element {
  const [items, setItems] = useState<readonly CommunitySummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [activeQuery, setActiveQuery] = useState<string | undefined>();
  const [discoveryItems, setDiscoveryItems] = useState<CommunityDiscoveryPage['items']>([]);
  const [discoveryCursor, setDiscoveryCursor] = useState<string | undefined>();
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryStarted, setDiscoveryStarted] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

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

  function runDiscovery(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const query = searchInput.trim() || undefined;
    setDiscoveryLoading(true);
    setDiscoveryStarted(true);
    setDiscoveryError(null);
    void discoverPage(query).then(
      (page) => {
        setActiveQuery(query);
        setDiscoveryItems(page.items);
        setDiscoveryCursor(page.nextCursor);
        setDiscoveryLoading(false);
      },
      () => {
        setDiscoveryError('Не удалось найти сообщества. Повторите попытку.');
        setDiscoveryLoading(false);
      },
    );
  }

  function loadMoreDiscovery(): void {
    if (!discoveryCursor || discoveryLoading) return;
    setDiscoveryLoading(true);
    setDiscoveryError(null);
    void discoverPage(activeQuery, discoveryCursor).then(
      (page) => {
        const byId = new Map(discoveryItems.map((item) => [item.id, item]));
        page.items.forEach((item) => byId.set(item.id, item));
        setDiscoveryItems([...byId.values()]);
        setDiscoveryCursor(page.nextCursor);
        setDiscoveryLoading(false);
      },
      () => {
        setDiscoveryError('Не удалось догрузить сообщества.');
        setDiscoveryLoading(false);
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
                <a className="community-directory-card" href={community.route}>
                  <CommunityAvatar community={community} />
                  <span>
                    <strong>{community.title}</strong>
                    <small>
                      {community.unreadChatCount > 0
                        ? `Новых сообщений: ${community.unreadChatCount}`
                        : 'Нет новых сообщений'}
                    </small>
                  </span>
                  <span aria-hidden="true">›</span>
                </a>
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

        <section className="community-discovery" aria-labelledby="community-discovery-title">
          <header>
            <h2 id="community-discovery-title">Найти сообщество</h2>
            <p>Поиск по каноническому каталогу PadlHub</p>
          </header>
          <form onSubmit={runDiscovery} role="search">
            <label htmlFor="community-search">Название сообщества</label>
            <div>
              <input
                id="community-search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                minLength={2}
                maxLength={80}
                placeholder="Например, Padel Friends"
              />
              <button type="submit" disabled={discoveryLoading}>
                Найти
              </button>
            </div>
          </form>
          {discoveryLoading && discoveryItems.length === 0 ? (
            <p className="community-directory-status" role="status">
              Ищем сообщества…
            </p>
          ) : null}
          {discoveryStarted &&
          !discoveryLoading &&
          discoveryItems.length === 0 &&
          !discoveryError ? (
            <p className="community-directory-status">Подходящих сообществ нет.</p>
          ) : null}
          {discoveryItems.length > 0 ? (
            <ul className="community-directory-list">
              {discoveryItems.map((community) => (
                <li key={community.id}>
                  <a className="community-directory-card" href={`/communities/${community.id}`}>
                    <CommunityAvatar community={community} />
                    <span>
                      <strong>{community.title}</strong>
                      <small>{discoveryHint(community)}</small>
                    </span>
                    <span aria-hidden="true">›</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
          {discoveryError ? (
            <p className="community-directory-error" role="alert">
              {discoveryError}
            </p>
          ) : null}
          {discoveryCursor ? (
            <button type="button" onClick={loadMoreDiscovery} disabled={discoveryLoading}>
              {discoveryLoading ? 'Загружаем…' : 'Показать ещё'}
            </button>
          ) : null}
        </section>
      </section>
    </main>
  );
}
