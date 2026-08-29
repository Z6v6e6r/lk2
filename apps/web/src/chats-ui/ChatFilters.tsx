import styles from './ChatsUi.module.css';

export type ChatFilter = 'ALL' | 'DIRECT' | 'GAME';

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
] as const;

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
            onClick={() => onFilterChange(item.value)}
          >
            {item.label}
          </button>
        ))}
        <a href="/notifications">Уведомления</a>
      </nav>
    </div>
  );
}
