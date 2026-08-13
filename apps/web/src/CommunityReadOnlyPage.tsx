import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  CommunityReadExperienceChatPage,
  CommunityReadExperienceDetail,
  CommunityReadExperienceFeedPage,
  CommunityReadExperienceRating,
} from './auth-gateway.js';
import {
  CommunityDetailShell,
  type CommunityReadOnlyModel,
  type CommunityReadOnlyTab,
} from './communities-ui/index.js';
import styles from './communities-ui/CommunitiesReadOnly.module.css';

interface CommunityReadOnlyPageProps {
  readonly communityId: string;
  readonly feedEnabled: boolean;
  readonly chatEnabled: boolean;
  readonly ratingEnabled: boolean;
  readonly loadDetail: (communityId: string) => Promise<CommunityReadExperienceDetail>;
  readonly loadFeed: (
    communityId: string,
    cursor?: string,
  ) => Promise<CommunityReadExperienceFeedPage>;
  readonly loadChat: (
    communityId: string,
    cursor?: string,
  ) => Promise<CommunityReadExperienceChatPage>;
  readonly loadRating: (communityId: string) => Promise<CommunityReadExperienceRating>;
}

const dateLabel = (value: string) =>
  new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(value),
  );

export function CommunityReadOnlyPage(props: CommunityReadOnlyPageProps): React.JSX.Element {
  return <CommunityReadOnlyPageContent key={props.communityId} {...props} />;
}

function CommunityReadOnlyPageContent({
  communityId,
  feedEnabled,
  chatEnabled,
  ratingEnabled,
  loadDetail,
  loadFeed,
  loadChat,
  loadRating,
}: CommunityReadOnlyPageProps): React.JSX.Element {
  const [detail, setDetail] = useState<CommunityReadExperienceDetail | null>(null);
  const [feed, setFeed] = useState<CommunityReadExperienceFeedPage | null>(null);
  const [chat, setChat] = useState<CommunityReadExperienceChatPage | null>(null);
  const [rating, setRating] = useState<CommunityReadExperienceRating | null>(null);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const firstTab: CommunityReadOnlyTab | null = feedEnabled
    ? 'feed'
    : chatEnabled
      ? 'chat'
      : ratingEnabled
        ? 'ranking'
        : null;
  const [activeTab, setActiveTab] = useState<CommunityReadOnlyTab>(firstTab ?? 'feed');
  const pendingTabs = useRef<Set<CommunityReadOnlyTab>>(new Set(firstTab ? [firstTab] : []));
  const [loadingTabs, setLoadingTabs] = useState<ReadonlySet<CommunityReadOnlyTab>>(
    new Set(firstTab ? [firstTab] : []),
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationError, setPaginationError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [tabErrors, setTabErrors] = useState<Partial<Record<CommunityReadOnlyTab, string>>>({});

  const clearTabError = (tab: CommunityReadOnlyTab) => {
    setTabErrors((current) => {
      if (current[tab] === undefined) return current;
      const next = { ...current };
      delete next[tab];
      return next;
    });
  };
  const setTabError = (tab: CommunityReadOnlyTab, message: string) => {
    setTabErrors((current) => ({ ...current, [tab]: message }));
  };

  useEffect(() => {
    let active = true;
    void loadDetail(communityId).then(
      (nextDetail) => {
        if (!active) return;
        setDetail(nextDetail);
      },
      () => {
        if (!active) return;
        setDetailError('Не удалось загрузить сообщество. Повторите попытку.');
      },
    );
    return () => {
      active = false;
    };
  }, [communityId, detailAttempt, loadDetail]);

  useEffect(() => {
    let active = true;
    if (!firstTab) {
      pendingTabs.current.clear();
      return () => {
        active = false;
      };
    }
    pendingTabs.current.add(firstTab);
    setLoadingTabs(new Set(pendingTabs.current));
    const fail = () => {
      pendingTabs.current.delete(firstTab);
      if (!active) return;
      setLoadingTabs(new Set(pendingTabs.current));
      setTabError(firstTab, 'Раздел временно недоступен.');
    };
    const complete = () => {
      pendingTabs.current.delete(firstTab);
      if (active) setLoadingTabs(new Set(pendingTabs.current));
    };
    if (firstTab === 'feed')
      void loadFeed(communityId).then((value) => {
        if (active) setFeed(value);
        complete();
      }, fail);
    else if (firstTab === 'chat')
      void loadChat(communityId).then((value) => {
        if (active) setChat(value);
        complete();
      }, fail);
    else
      void loadRating(communityId).then((value) => {
        if (active) setRating(value);
        complete();
      }, fail);
    return () => {
      active = false;
    };
  }, [communityId, firstTab, loadChat, loadFeed, loadRating]);

  const availableTabs = useMemo<CommunityReadOnlyTab[]>(() => {
    const result: CommunityReadOnlyTab[] = [];
    if (feedEnabled) result.push('feed');
    if (chatEnabled) result.push('chat');
    if (ratingEnabled) result.push('ranking');
    return result;
  }, [chatEnabled, feedEnabled, ratingEnabled]);

  const loadTab = (tab: CommunityReadOnlyTab, forceRetry = false) => {
    setActiveTab(tab);
    if (!forceRetry && tabErrors[tab] !== undefined) return;
    if (pendingTabs.current.has(tab)) return;
    if (tab === 'feed' && feed) {
      clearTabError(tab);
      return;
    }
    if (tab === 'chat' && chat) {
      clearTabError(tab);
      return;
    }
    if (tab === 'ranking' && rating) {
      clearTabError(tab);
      return;
    }
    clearTabError(tab);
    pendingTabs.current.add(tab);
    setLoadingTabs(new Set(pendingTabs.current));
    const completeTab = () => {
      pendingTabs.current.delete(tab);
      setLoadingTabs(new Set(pendingTabs.current));
    };
    if (tab === 'feed') {
      void loadFeed(communityId).then(
        (value) => {
          setFeed(value);
          completeTab();
        },
        () => {
          setTabError(tab, 'Лента временно недоступна.');
          completeTab();
        },
      );
    }
    if (tab === 'chat') {
      void loadChat(communityId).then(
        (value) => {
          setChat(value);
          completeTab();
        },
        () => {
          setTabError(tab, 'Чат временно недоступен.');
          completeTab();
        },
      );
    }
    if (tab === 'ranking') {
      void loadRating(communityId).then(
        (value) => {
          setRating(value);
          completeTab();
        },
        () => {
          setTabError(tab, 'Рейтинг временно недоступен.');
          completeTab();
        },
      );
    }
  };

  if (!detail) {
    const failed = Boolean(detailError);
    return (
      <main className="community-directory-page">
        <section className={styles.stateShell} aria-label="Сообщество">
          <header className={styles.header}>
            <div className={styles.topbar}>
              <a
                className={styles.circleButton}
                href="/communities"
                aria-label="Назад к сообществам"
              >
                ←
              </a>
              <div className={styles.headerCopy}>
                <h1 className={styles.title}>Сообщество</h1>
                <p className={styles.members}>ПаделХАБ</p>
              </div>
            </div>
          </header>
          <div className={styles.stateCard}>
            <p role={failed ? 'alert' : 'status'}>
              {failed ? detailError : 'Загружаем сообщество…'}
            </p>
            {failed ? (
              <button
                className={styles.retryButton}
                type="button"
                onClick={() => {
                  setDetailError(null);
                  setDetailAttempt((value) => value + 1);
                }}
              >
                Повторить
              </button>
            ) : null}
          </div>
        </section>
      </main>
    );
  }

  const loadMore = () => {
    if (loadingMore) return;
    if (activeTab === 'feed' && feed?.nextCursor) {
      setLoadingMore(true);
      setPaginationError(null);
      void loadFeed(communityId, feed.nextCursor).then(
        (page) => {
          setFeed({ ...page, items: [...feed.items, ...page.items] });
          setPaginationError(null);
          setLoadingMore(false);
        },
        () => {
          setPaginationError('Не удалось догрузить ленту.');
          setLoadingMore(false);
        },
      );
    }
  };

  const model: CommunityReadOnlyModel = {
    community: {
      id: detail.id,
      title: detail.title,
      memberCount: detail.memberCount,
      avatarUrl: detail.logoUrl,
    },
    posts: (feed?.items ?? []).map((item) => ({
      author: { displayName: item.author.displayName },
      body: item.body || item.title || 'Публикация',
      publishedLabel: dateLabel(item.publishedAt),
      ...(item.commentsCount === undefined ? {} : { commentsCount: item.commentsCount }),
      ...(item.likesCount === undefined ? {} : { reactionsCount: item.likesCount }),
    })),
    messages: (chat?.items ?? []).map((item) => ({
      author: { displayName: item.author.displayName },
      body: item.body,
      sentLabel: dateLabel(item.sentAt),
      isCurrentUser: item.isViewer,
    })),
    ranking: (rating?.rows ?? []).map((row) => ({
      place: row.place,
      displayName: row.displayName,
      levelLabel: `Уровень ${row.currentLevel}`,
      score: row.score,
      delta: row.delta,
      games: row.games,
      tournaments: row.tournaments,
    })),
    ...(rating ? { ratingPeriod: rating.period, ratingTab: rating.tab } : {}),
  };

  return (
    <main className="community-directory-page">
      <CommunityDetailShell
        model={model}
        initialTab={availableTabs[0] ?? 'feed'}
        availableTabs={availableTabs}
        onTabChange={loadTab}
        status={
          tabErrors[activeTab]
            ? {
                kind: 'alert',
                message: tabErrors[activeTab],
                actionLabel: 'Повторить',
                onAction: () => loadTab(activeTab, true),
              }
            : loadingTabs.has(activeTab)
              ? { kind: 'status', message: 'Загружаем раздел…' }
              : null
        }
      />
      {activeTab === 'feed' && feed?.nextCursor ? (
        paginationError ? (
          <div className="community-read-only-pagination-error" role="alert">
            <span>{paginationError}</span>
            <button type="button" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Загружаем…' : 'Повторить'}
            </button>
          </div>
        ) : (
          <button
            className="community-read-only-load-more"
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
          >
            {loadingMore ? 'Загружаем…' : 'Показать ещё'}
          </button>
        )
      ) : null}
    </main>
  );
}
