import { useEffect, useState } from 'react';
import type {
  NotificationInboxPage,
  NotificationPreferencesView,
  NotificationPreferencesUpdateRequest,
} from '@phub/api-sdk';
import { NotificationsPage } from '../../../web/src/NotificationsPage.js';
import type { AndroidPushSnapshot } from '../android-push.js';
import type { IOSSession } from './session.js';

export function IOSNotifications({
  session,
  push,
  onEnable,
  onDisable,
}: {
  readonly session: IOSSession;
  readonly push: AndroidPushSnapshot;
  readonly onEnable: () => void;
  readonly onDisable: () => void;
}): React.JSX.Element {
  const [page, setPage] = useState<NotificationInboxPage>({ items: [], unreadCount: 0 });
  const [preferences, setPreferences] = useState<NotificationPreferencesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    void Promise.allSettled([
      session.read((api) => api.listNotifications()),
      session.read((api) => api.getNotificationPreferences()),
    ]).then(([inbox, prefs]) => {
      if (!current) return;
      if (inbox.status === 'fulfilled') setPage(inbox.value);
      if (prefs.status === 'fulfilled') setPreferences(prefs.value);
      if (inbox.status === 'rejected' || prefs.status === 'rejected')
        setError('Не удалось загрузить уведомления. Повторите попытку.');
    });
    return () => {
      current = false;
    };
  }, [session, attempt]);
  const save = async (update: NotificationPreferencesUpdateRequest): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setPreferences(await session.read((api) => api.updateNotificationPreferences(update)));
    } catch {
      setError('Не удалось сохранить настройки. Повторите попытку.');
    } finally {
      setBusy(false);
    }
  };
  const mark = async (): Promise<void> => {
    const first = page.items[0];
    if (!first) return;
    setBusy(true);
    try {
      await session.read((api) => api.markNotificationsRead(first.id));
      setAttempt((a) => a + 1);
    } catch {
      setError('Не удалось отметить уведомления.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <NotificationsPage
      platform="ios"
      page={page}
      webPush={{ enabled: push.enabled }}
      browserState={push.state}
      conversations={[]}
      busy={busy || push.busy}
      error={error ?? push.error ?? null}
      inboxUnavailable={false}
      preferences={preferences}
      preferencesBusy={busy}
      preferencesError={error}
      friendRequests={[]}
      outgoingFriendRequests={[]}
      friendRequestBusyId={null}
      onAcceptFriendRequest={() => {}}
      onDeclineFriendRequest={() => {}}
      onEnableWebPush={onEnable}
      onDisableWebPush={onDisable}
      onSavePreferences={(update) => void save(update)}
      onMarkAllRead={() => void mark()}
      onRetryInbox={() => {
        setError(null);
        setAttempt((a) => a + 1);
      }}
      onOpenNotification={(_item, href, navigate) => {
        if (navigate) {
          window.history.pushState(
            {},
            '',
            href.startsWith('/') && !href.startsWith('//') ? href : '/notifications',
          );
          window.dispatchEvent(new PopStateEvent('popstate'));
        }
      }}
    />
  );
}
