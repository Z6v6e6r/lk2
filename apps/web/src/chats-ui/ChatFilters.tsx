import { ChatCategoryIcon } from './ChatCategoryIcon.js';
import styles from './ChatsUi.module.css';

export type ChatFilter = 'ALL' | 'DIRECT' | 'GAME' | 'TOURNAMENT' | 'STATION' | 'COMMUNITY';

interface ChatFiltersProps {
  readonly filter: ChatFilter;
  readonly query: string;
  readonly onFilterChange: (filter: ChatFilter) => void;
  readonly onQueryChange: (query: string) => void;
}

const filters = [
  { value: 'ALL', label: 'Все' },
  { value: 'DIRECT', label: 'Личные' },
  { value: 'GAME', label: 'Игры' },
  { value: 'TOURNAMENT', label: 'Турниры' },
  { value: 'STATION', label: 'Станции' },
  { value: 'COMMUNITY', label: 'Сообщества' },
] as const;

export function ChatFilterHeading(): React.JSX.Element {
  return <h1>Чаты</h1>;
}

export function ChatFilters({
  filter,
  query,
  onFilterChange,
  onQueryChange,
}: ChatFiltersProps): React.JSX.Element {
  return (
    <div className={styles.filtersBlock}>
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
          <button type="button" className={styles.clearSearch} onClick={() => onQueryChange('')}>
            Очистить
          </button>
        ) : null}
      </div>
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
            <ChatCategoryIcon name={item.value} />
            <span className={styles.filterLabel}>{item.label}</span>
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
