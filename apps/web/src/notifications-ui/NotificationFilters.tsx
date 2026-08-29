import type { NotificationFilter } from './notification-format.js';
import styles from './NotificationsUi.module.css';

interface NotificationFiltersProps {
  readonly filters: readonly { readonly value: NotificationFilter; readonly label: string }[];
  readonly selected: NotificationFilter;
  readonly onChange: (filter: NotificationFilter) => void;
}

export function NotificationFilters({
  filters,
  selected,
  onChange,
}: NotificationFiltersProps): React.JSX.Element {
  return (
    <nav className={styles.filterRail} aria-label="Категории уведомлений">
      {filters.map((filter) => (
        <button
          type="button"
          key={filter.value}
          className={selected === filter.value ? styles.activeFilter : undefined}
          aria-pressed={selected === filter.value}
          onClick={() => onChange(filter.value)}
        >
          {filter.label}
        </button>
      ))}
    </nav>
  );
}
