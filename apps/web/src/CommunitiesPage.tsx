import { useEffect, useState } from 'react';

import type { CommunityMembershipPage } from './auth-gateway.js';
import styles from './communities-ui/CommunitiesReadOnly.module.css';

type CommunitySummary = CommunityMembershipPage['items'][number];

interface CommunitiesPageProps {
  readonly tenantName: string;
  readonly loadPage: (cursor?: string) => Promise<CommunityMembershipPage>;
  readonly readExperienceEnabled?: boolean;
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
    <span
      className={styles.storyAvatar}
      style={{ '--story-accent': background } as React.CSSProperties}
    >
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

export function CommunitiesPage({
  tenantName,
  loadPage,
  readExperienceEnabled = false,
}: CommunitiesPageProps): React.JSX.Element {
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
    <main className={styles.directory}>
      <header className={styles.directoryHeader}>
        <a className={styles.directoryBack} href="/" aria-label="Вернуться на Главную">
          ←
        </a>
        <div>
          <h1 aria-label="Мои сообщества">
            <span aria-hidden="true">Сообщества</span>
          </h1>
          <p>{tenantName}</p>
        </div>
      </header>

      <section className={styles.directoryContent} aria-busy={loading || loadingMore}>
        {loading ? (
          <p className={styles.directoryStatus} role="status">
            Загружаем сообщества…
          </p>
        ) : null}
        {!loading && items.length === 0 && !error ? (
          <p className={styles.directoryStatus}>Вы пока не состоите в сообществах.</p>
        ) : null}
        {items.length > 0 ? (
          <ul className={styles.stories} aria-label="Лента сообществ">
            {items.map((community) => (
              <li key={community.id}>
                {readExperienceEnabled ? (
                  <a className={styles.story} href={community.route}>
                    <CommunityAvatar community={community} />
                    <strong title={community.title}>{community.title}</strong>
                  </a>
                ) : (
                  <div className={styles.story}>
                    <CommunityAvatar community={community} />
                    <strong title={community.title}>{community.title}</strong>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p className={styles.directoryError} role="alert">
            {error}
          </p>
        ) : null}
        {nextCursor ? (
          <button
            className={styles.loadMore}
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
          >
            {loadingMore ? 'Загружаем…' : 'Показать ещё'}
          </button>
        ) : null}
      </section>
    </main>
  );
}
