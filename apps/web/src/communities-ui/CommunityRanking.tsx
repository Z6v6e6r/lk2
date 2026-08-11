import { useMemo, useState } from 'react';

import styles from './CommunitiesReadOnly.module.css';
import { Avatar } from './CommunityFeedList.js';
import type { CommunityReadOnlyRankingEntry } from './types.js';

export function CommunityRanking({
  entries,
  period = '30d',
  kind = 'overall',
}: {
  readonly entries: readonly CommunityReadOnlyRankingEntry[];
  readonly period?: 'all' | '30d';
  readonly kind?: 'overall' | 'dynamics' | 'games' | 'tournaments';
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const visibleEntries = useMemo(
    () =>
      entries.filter((entry) =>
        entry.displayName
          .toLocaleLowerCase('ru-RU')
          .includes(query.trim().toLocaleLowerCase('ru-RU')),
      ),
    [entries, query],
  );
  return (
    <section aria-label="Рейтинг сообщества">
      <div className={styles.rankingControls} aria-label="Фильтры рейтинга">
        <div className={styles.rankingPills} role="group" aria-label="Период">
          <button
            type="button"
            className={period === 'all' ? styles.pillActive : styles.pill}
            disabled
            aria-label="Все время: выбор периода недоступен"
          >
            Все время
          </button>
          <button
            type="button"
            className={period === '30d' ? styles.pillActive : styles.pill}
            disabled
            aria-label="Последние 30 дней: выбор периода недоступен"
          >
            Месяц
          </button>
        </div>
        <div className={styles.rankingKinds} role="group" aria-label="Тип рейтинга">
          {(
            [
              ['overall', 'Общий'],
              ['games', 'Игры'],
              ['tournaments', 'Турниры'],
              ...(kind === 'dynamics' ? ([['dynamics', 'Динамика']] as const) : []),
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={kind === id ? styles.kindActive : styles.kind}
              disabled
              aria-label={`${label}: выбор типа рейтинга недоступен`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.rankingHead}>
        <div className={styles.searchWrap}>
          <input
            className={styles.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="⌕  Поиск игрока"
            aria-label="Поиск игрока"
          />
          <button
            className={styles.filterButton}
            type="button"
            aria-label="Дополнительные фильтры недоступны"
            disabled
          >
            ≡
          </button>
        </div>
      </div>
      {visibleEntries.length ? (
        <ol className={styles.rankingList}>
          {visibleEntries.map((entry, index) => (
            <li className={styles.rankingRow} key={`${entry.place}:${index}`}>
              <span className={styles.place}>{entry.place}</span>
              <Avatar name={entry.displayName} src={entry.avatarUrl} />
              <span className={styles.memberName}>
                {entry.displayName}
                {entry.levelLabel ? (
                  <small className={styles.level}>{entry.levelLabel}</small>
                ) : null}
              </span>
              <span className={styles.score}>★ {entry.score}</span>
              {typeof entry.delta === 'number' ? (
                <span
                  className={
                    entry.delta > 0
                      ? styles.deltaUp
                      : entry.delta < 0
                        ? styles.deltaDown
                        : styles.delta
                  }
                >
                  {entry.delta > 0 ? '▲' : entry.delta < 0 ? '▼' : '—'} {Math.abs(entry.delta)}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className={styles.empty}>Игроки не найдены.</p>
      )}
    </section>
  );
}
