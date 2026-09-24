import { ChatCategoryIcon } from './ChatCategoryIcon.js';
import styles from './ChatsUi.module.css';

export type ChatFilter = 'ALL' | 'DIRECT' | 'GAME' | 'TOURNAMENT' | 'STATION' | 'COMMUNITY';

interface ChatFiltersProps {
  readonly filter: ChatFilter;
  readonly onFilterChange: (filter: ChatFilter) => void;
}

/**
 * The rail is ordered by how often the destination is used, not by the API enum: stations sit right
 * after "Все" because a player with a pending station question has to reach it without a swipe.
 */
const filters = [
  { value: 'ALL', label: 'Все' },
  { value: 'STATION', label: 'Станции' },
  { value: 'DIRECT', label: 'Личные' },
  { value: 'GAME', label: 'Игры' },
  { value: 'TOURNAMENT', label: 'Турниры' },
  { value: 'COMMUNITY', label: 'Сообщества' },
] as const;

export function ChatFilterHeading({ filter }: { readonly filter: ChatFilter }): React.JSX.Element {
  const label = filters.find((item) => item.value === filter)?.label ?? 'Все';
  return <h1 title={label}>{label}</h1>;
}

export function ChatSearch({
  query,
  onQueryChange,
}: {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
}): React.JSX.Element {
  return (
    <div className={styles.searchField}>
      <label className="sr-only" htmlFor="chat-search">
        Поиск по чатам
      </label>
      <span className={styles.searchIcon} aria-hidden="true" />
      <input
        id="chat-search"
        type="search"
        value={query}
        placeholder="Поиск по чатам"
        autoComplete="off"
        onChange={(event) => onQueryChange(event.target.value)}
      />
      {query ? (
        <button
          type="button"
          className={styles.clearSearch}
          aria-label="Очистить"
          onClick={() => onQueryChange('')}
        >
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
    </div>
  );
}

export function ChatFilters({ filter, onFilterChange }: ChatFiltersProps): React.JSX.Element {
  return (
    <div className={styles.filtersBlock}>
      <nav className={styles.filterRail} aria-label="Типы чатов">
        {filters.map((item) => (
          <button
            type="button"
            key={item.value}
            className={filter === item.value ? styles.activeFilter : undefined}
            aria-pressed={filter === item.value}
            aria-label={item.label}
            title={item.label}
            onClick={() => onFilterChange(item.value)}
          >
            {item.value === 'ALL' ? (
              <span>Все</span>
            ) : (
              <>
                <ChatCategoryIcon name={item.value} />
                <span className={styles.filterLabel}>{item.label}</span>
              </>
            )}
          </button>
        ))}
        <a href="/notifications" aria-label="Уведомления" title="Уведомления">
          <ChatCategoryIcon name="NOTIFICATIONS" />
          <span className={styles.filterLabel}>Уведомления</span>
        </a>
      </nav>
    </div>
  );
}
