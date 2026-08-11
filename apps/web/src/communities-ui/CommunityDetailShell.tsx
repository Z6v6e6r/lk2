import { useId, useState, type KeyboardEvent } from 'react';

import styles from './CommunitiesReadOnly.module.css';
import { CommunityChatTranscript } from './CommunityChatTranscript.js';
import { CommunityFeedList } from './CommunityFeedList.js';
import { CommunityRanking } from './CommunityRanking.js';
import type { CommunityReadOnlyModel, CommunityReadOnlyTab } from './types.js';

export interface CommunityDetailShellProps {
  readonly model: CommunityReadOnlyModel;
  readonly initialTab?: CommunityReadOnlyTab;
  readonly onTabChange?: (tab: CommunityReadOnlyTab) => void;
  readonly availableTabs?: readonly CommunityReadOnlyTab[];
  readonly backHref?: string;
  readonly status?: {
    readonly kind: 'status' | 'alert';
    readonly message: string;
    readonly actionLabel?: string;
    readonly onAction?: () => void;
  } | null;
}

const tabs: ReadonlyArray<{ readonly id: CommunityReadOnlyTab; readonly label: string }> = [
  { id: 'feed', label: 'Лента' },
  { id: 'chat', label: 'Чат' },
  { id: 'ranking', label: 'Рейтинг' },
];

function initials(value: string): string {
  return (
    value
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toLocaleUpperCase('ru-RU') || '?'
  );
}

function memberLabel(count: number): string {
  const tail = count % 100;
  const unit = count % 10;
  if (unit === 1 && tail !== 11) return `${count} участник`;
  if (unit >= 2 && unit <= 4 && (tail < 12 || tail > 14)) return `${count} участника`;
  return `${count} участников`;
}

export function CommunityDetailShell({
  model,
  initialTab = 'feed',
  onTabChange,
  availableTabs = ['feed', 'chat', 'ranking'],
  backHref = '/communities',
  status = null,
}: CommunityDetailShellProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<CommunityReadOnlyTab>(initialTab);
  const tabId = useId();
  const { community } = model;
  const selectTab = (tab: CommunityReadOnlyTab) => {
    setActiveTab(tab);
    onTabChange?.(tab);
  };
  const visibleTabs = tabs.filter((tab) => availableTabs.includes(tab.id));
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | undefined;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % visibleTabs.length;
    if (event.key === 'ArrowLeft')
      nextIndex = (index - 1 + visibleTabs.length) % visibleTabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = visibleTabs.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextTab = visibleTabs[nextIndex];
    if (!nextTab) return;
    selectTab(nextTab.id);
    document.getElementById(`${tabId}-${nextTab.id}-tab`)?.focus();
  };

  return (
    <section
      className={styles.root}
      aria-label={`Сообщество ${community.title}`}
      data-read-only="true"
    >
      <header className={styles.header}>
        <div className={styles.topbar}>
          <a className={styles.circleButton} href={backHref} aria-label="Назад к сообществам">
            ←
          </a>
          <div className={styles.headerRow}>
            <div className={styles.avatar} aria-hidden="true">
              {community.avatarUrl ? (
                <>
                  <span>{initials(community.title)}</span>
                  <img
                    src={community.avatarUrl}
                    alt=""
                    onError={(event) => {
                      event.currentTarget.style.display = 'none';
                    }}
                  />
                </>
              ) : (
                initials(community.title)
              )}
            </div>
            <div className={styles.headerCopy}>
              <h2 className={styles.title}>{community.title}</h2>
              <p className={styles.members}>{memberLabel(community.memberCount)}</p>
            </div>
          </div>
          <span
            className={styles.circleButton}
            aria-label="Сообщество доступно только для просмотра"
          >
            •••
          </span>
        </div>
      </header>
      {visibleTabs.length > 0 ? (
        <nav className={styles.tabs} role="tablist" aria-label="Разделы сообщества">
          {visibleTabs.map((tab, index) => (
            <button
              key={tab.id}
              id={`${tabId}-${tab.id}-tab`}
              className={styles.tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`${tabId}-${tab.id}-panel`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              onClick={() => selectTab(tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      ) : null}
      {visibleTabs.length > 0 ? (
        <div
          id={`${tabId}-${activeTab}-panel`}
          className={styles.content}
          role="tabpanel"
          aria-labelledby={`${tabId}-${activeTab}-tab`}
        >
          {status ? (
            <div
              className={status.kind === 'alert' ? styles.inlineAlert : styles.inlineStatus}
              role={status.kind}
            >
              <span>{status.message}</span>
              {status.actionLabel && status.onAction ? (
                <button type="button" onClick={status.onAction}>
                  {status.actionLabel}
                </button>
              ) : null}
            </div>
          ) : null}
          {!status && activeTab === 'feed' && <CommunityFeedList posts={model.posts} />}
          {!status && activeTab === 'chat' && <CommunityChatTranscript messages={model.messages} />}
          {!status && activeTab === 'ranking' && (
            <CommunityRanking
              entries={model.ranking}
              {...(model.ratingPeriod === undefined ? {} : { period: model.ratingPeriod })}
              {...(model.ratingTab === undefined ? {} : { kind: model.ratingTab })}
            />
          )}
        </div>
      ) : null}
      <nav className={styles.bottomNav} aria-label="Навигация сообщества">
        <button className={styles.bottomNavItem} type="button" disabled aria-label="Главная">
          <span aria-hidden="true">⌂</span>
          <small>Главная</small>
        </button>
        <button
          type="button"
          className={styles.bottomNavItem}
          aria-current={activeTab === 'feed' ? 'page' : undefined}
          disabled={!visibleTabs.some((tab) => tab.id === 'feed')}
          onClick={() => selectTab('feed')}
        >
          <span aria-hidden="true">◒</span>
          <small>Сообщества</small>
        </button>
        <button
          className={`${styles.bottomNavItem} ${styles.bottomNavCreate}`}
          type="button"
          disabled
          aria-label="Создать недоступно в режиме просмотра"
        >
          <span aria-hidden="true">+</span>
        </button>
        <button
          type="button"
          className={styles.bottomNavItem}
          aria-current={activeTab === 'chat' ? 'page' : undefined}
          disabled={!visibleTabs.some((tab) => tab.id === 'chat')}
          onClick={() => selectTab('chat')}
        >
          <span aria-hidden="true">◌</span>
          <small>Чат</small>
        </button>
        <button className={styles.bottomNavItem} type="button" disabled aria-label="Профиль">
          <span aria-hidden="true">♙</span>
          <small>Профиль</small>
        </button>
      </nav>
    </section>
  );
}
