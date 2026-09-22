import type { WebPushConfiguration } from '../auth-gateway.js';
import type { WebPushBrowserState } from '../web-push-client.js';
import { NotificationIcon } from './NotificationIcon.js';
import { NotificationSwitch } from './NotificationSwitch.js';
import type { PreferenceCategoryDraft, PreferenceDraft } from './notification-preferences.js';
import {
  canToggleNotificationPush,
  categoryChannel,
  notificationCategorySettings,
  notificationPushStatus,
  quietWindowSummary,
} from './notification-preferences.js';
import styles from './NotificationsUi.module.css';

interface NotificationSettingsScreenProps {
  readonly draft: PreferenceDraft | null;
  readonly busy: boolean;
  readonly error?: string | null | undefined;
  readonly webPush: WebPushConfiguration;
  readonly browserState: WebPushBrowserState;
  readonly onEnableWebPush: () => void;
  readonly onDisableWebPush: () => void;
  readonly onOpenQuietHours: () => void;
  readonly onApplyDraft: (draft: PreferenceDraft) => void;
  readonly onBack: () => void;
}

/**
 * The dedicated settings screen. Every switch applies immediately: the category rows write the
 * whole preference draft back through the existing replace-preferences command, so a recipient does
 * not have to remember a separate save step.
 */
export function NotificationSettingsScreen({
  draft,
  busy,
  error,
  webPush,
  browserState,
  onEnableWebPush,
  onDisableWebPush,
  onOpenQuietHours,
  onApplyDraft,
  onBack,
}: NotificationSettingsScreenProps): React.JSX.Element {
  const subscribed = browserState === 'subscribed';
  const canTogglePush = canToggleNotificationPush(webPush, browserState);

  function toggleCategory(
    category: PreferenceCategoryDraft,
    channel: 'IN_APP' | 'PUSH',
    enabled: boolean,
  ): void {
    if (!draft) return;
    onApplyDraft({
      ...draft,
      categories: draft.categories.map((entry) =>
        entry.category === category.category
          ? {
              ...entry,
              channels: entry.channels.map((item) =>
                item.channel === channel ? { ...item, enabled } : item,
              ),
            }
          : entry,
      ),
    });
  }

  return (
    <section className={styles.settingsSurface}>
      <header className={styles.header}>
        <button type="button" aria-label="Назад к уведомлениям" onClick={onBack}>
          <NotificationIcon name="back" />
        </button>
        <h1>Настройки уведомлений</h1>
        <span aria-hidden="true" />
      </header>

      <section className={styles.settingsCard} aria-label="Основные настройки">
        <div className={styles.settingsRow}>
          <span className={`${styles.settingsIcon} ${styles.toneAccent}`} aria-hidden="true">
            <NotificationIcon name="bell" />
          </span>
          <div className={styles.settingsCopy}>
            <strong>Получать push</strong>
            <small>{notificationPushStatus(webPush, browserState)}</small>
          </div>
          <NotificationSwitch
            checked={subscribed}
            disabled={busy || (!subscribed && !canTogglePush)}
            label="Получать push-уведомления"
            onChange={subscribed ? onDisableWebPush : onEnableWebPush}
          />
        </div>
        <button
          type="button"
          className={`${styles.settingsRow} ${styles.settingsRowButton}`}
          onClick={onOpenQuietHours}
        >
          <span className={`${styles.settingsIcon} ${styles.toneNeutral}`} aria-hidden="true">
            <NotificationIcon name="moon" />
          </span>
          <div className={styles.settingsCopy}>
            <strong>Тихие часы</strong>
            <small>{draft ? quietWindowSummary(draft) : 'Недоступны'}</small>
          </div>
          <NotificationIcon name="chevron" />
        </button>
      </section>

      {draft ? (
        <>
          <h2 className={styles.sectionLabel}>КАТЕГОРИИ УВЕДОМЛЕНИЙ</h2>
          <section className={styles.settingsCard} aria-label="Категории уведомлений">
            {draft.categories.map((category) => {
              const settings = notificationCategorySettings(category.category);
              const push = categoryChannel(category, 'PUSH');
              const inApp = categoryChannel(category, 'IN_APP');
              return (
                <div className={styles.settingsRow} key={category.category}>
                  <span className={styles.settingsIcon} aria-hidden="true">
                    <NotificationIcon name={settings.icon} />
                  </span>
                  <div className={styles.settingsCopy}>
                    <strong>{settings.title}</strong>
                    <small>{settings.description}</small>
                    {inApp ? (
                      <span className={styles.inlineToggle}>
                        <span>В ленте</span>
                        <NotificationSwitch
                          compact
                          checked={inApp.enabled}
                          disabled={busy}
                          label={`${settings.title}: показывать в приложении`}
                          onChange={() => toggleCategory(category, 'IN_APP', !inApp.enabled)}
                        />
                      </span>
                    ) : null}
                  </div>
                  {push ? (
                    <div className={styles.settingsPush}>
                      <NotificationSwitch
                        checked={push.enabled}
                        disabled={busy || !push.available}
                        label={`${settings.title}: push-уведомления`}
                        onChange={() => toggleCategory(category, 'PUSH', !push.enabled)}
                      />
                      {push.available ? null : <small>не подключён</small>}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </section>
        </>
      ) : (
        <p className={styles.settingsHint} role="status">
          {error ?? 'Настройки уведомлений временно недоступны.'}
        </p>
      )}

      {error && draft ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.note}>
        <NotificationIcon name="info" />
        <span>
          Критически важные системные уведомления приходят всегда, даже если включены тихие часы.
        </span>
      </div>
    </section>
  );
}
