import { NotificationIcon } from './NotificationIcon.js';
import { NotificationSwitch } from './NotificationSwitch.js';
import type { PreferenceDraft } from './notification-preferences.js';
import { QUIET_TIME_PATTERN, quietWindowValid } from './notification-preferences.js';
import styles from './NotificationsUi.module.css';

interface NotificationQuietHoursScreenProps {
  readonly draft: PreferenceDraft;
  readonly busy: boolean;
  readonly onApplyDraft: (draft: PreferenceDraft) => void;
  readonly onBack: () => void;
}

/**
 * Quiet hours deliberately describe only the push channel: the inbox item is durable, so the window
 * never hides an event, it only stops the interruption.
 */
export function NotificationQuietHoursScreen({
  draft,
  busy,
  onApplyDraft,
  onBack,
}: NotificationQuietHoursScreenProps): React.JSX.Element {
  const timezone =
    draft.categories
      .flatMap((category) => category.channels)
      .find((channel) => channel.channel === 'PUSH')?.timezone ?? 'Europe/Moscow';

  function applyWindow(patch: {
    readonly quietEnabled?: boolean;
    readonly quietFrom?: string;
    readonly quietUntil?: string;
  }): void {
    const next = { ...draft, ...patch };
    if (!quietWindowValid(next)) return;
    onApplyDraft(next);
  }

  return (
    <section className={styles.settingsSurface}>
      <header className={styles.header}>
        <button type="button" aria-label="Назад к настройкам уведомлений" onClick={onBack}>
          <NotificationIcon name="back" />
        </button>
        <h1>Тихие часы</h1>
        <span aria-hidden="true" />
      </header>

      <section className={styles.settingsCard} aria-label="Тихие часы">
        <div className={styles.settingsRow}>
          <span className={`${styles.settingsIcon} ${styles.toneAccent}`} aria-hidden="true">
            <NotificationIcon name="moon" />
          </span>
          <div className={styles.settingsCopy}>
            <strong>Тихие часы</strong>
            <small>В это время push не приходит, а событие остаётся в ленте.</small>
          </div>
          <NotificationSwitch
            checked={draft.quietEnabled}
            disabled={busy}
            label="Тихие часы для push"
            onChange={() => applyWindow({ quietEnabled: !draft.quietEnabled })}
          />
        </div>
      </section>

      <section className={styles.timeCard} aria-label="Период тихих часов">
        <label>
          <span>С</span>
          <input
            type="time"
            value={draft.quietFrom}
            disabled={busy || !draft.quietEnabled}
            onChange={(event) => {
              if (QUIET_TIME_PATTERN.test(event.target.value)) {
                applyWindow({ quietFrom: event.target.value });
              }
            }}
          />
        </label>
        <label>
          <span>До</span>
          <input
            type="time"
            value={draft.quietUntil}
            disabled={busy || !draft.quietEnabled}
            onChange={(event) => {
              if (QUIET_TIME_PATTERN.test(event.target.value)) {
                applyWindow({ quietUntil: event.target.value });
              }
            }}
          />
        </label>
      </section>

      <div className={styles.note}>
        <NotificationIcon name="info" />
        <span>
          Время указывается в часовом поясе {timezone}. Критически важные уведомления приходят и в
          тихие часы.
        </span>
      </div>
    </section>
  );
}
