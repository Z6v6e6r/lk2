import styles from './NotificationsUi.module.css';

interface NotificationSwitchProps {
  readonly checked: boolean;
  readonly disabled?: boolean | undefined;
  readonly label: string;
  readonly compact?: boolean | undefined;
  readonly onChange: () => void;
}

/**
 * One switch for every preference row. It is a button with `role="switch"` so the state is exposed
 * to assistive technology without relying on a label wrapper.
 */
export function NotificationSwitch({
  checked,
  disabled = false,
  label,
  compact = false,
  onChange,
}: NotificationSwitchProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={[
        styles.switch,
        compact ? styles.switchCompact : '',
        checked ? styles.switchOn : '',
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={disabled}
      onClick={onChange}
    >
      <span aria-hidden="true" />
    </button>
  );
}
