import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ChatList } from '../../../web/src/chats-ui/ChatList.js';
import { ChatThread } from '../../../web/src/chats-ui/ChatThread.js';
import { MainBottomNavigation } from '../../../web/src/HomeDashboardPage.js';
import { connectChatRealtime } from '../../../web/src/chat-realtime-client.js';
import { IOSChatController } from './chat-data.js';
import type { IOSSession } from './session.js';
import styles from '../../../web/src/chats-ui/ChatsUi.module.css';

const noMedia = (): Promise<Blob> => Promise.reject(new Error('Вложения пока недоступны в iOS'));
const noAttachments = () => {};

export function IOSChats({
  session,
  userId,
  conversationId,
}: {
  readonly session: IOSSession;
  readonly userId: string;
  readonly conversationId?: string;
}) {
  const controller = useMemo(
    () => new IOSChatController(session, conversationId, userId),
    [session, userId, conversationId],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [connection, setConnection] = useState('Подключаемся…');
  useEffect(() => {
    controller.start();
    void controller.refresh();
    const refresh = () => {
      if (document.visibilityState === 'visible') void controller.refresh();
    };
    const interval = window.setInterval(refresh, 5000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', refresh);
    return () => {
      controller.stop();
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [controller]);
  useEffect(() => {
    if (!conversationId || !state.loaded || state.forbidden) return;
    const realtime = connectChatRealtime({
      baseUrl: session.configuration.apiBaseUrl,
      tenantKey: session.configuration.tenantKey,
      conversationId,
      getTicket: () => session.read((api) => api.issueMessagingRealtimeTicket()),
      getAfterSequence: controller.sequence,
      onRecoveryRequired: controller.recover,
      onConnectionStateChange: (status) =>
        setConnection(
          status === 'connected'
            ? 'Онлайн'
            : status === 'reconnecting'
              ? 'Восстанавливаем связь · обновляем историю'
              : 'Подключаемся…',
        ),
    });
    return () => realtime.stop();
  }, [controller, conversationId, session, state.loaded, state.forbidden]);
  return (
    <main className="games-page ios-cabinet-page">
      <h1>Чаты</h1>
      {state.error ? (
        <div className={styles.errorBanner} role="alert">
          <span>{state.error}</span>
          <button type="button" onClick={() => void controller.refresh()}>
            Обновить
          </button>
        </div>
      ) : null}
      <p className="ios-cabinet-note">Личные чаты и чаты игр. Вложения пока недоступны.</p>
      <div className={styles.threadBody}>
        {conversationId ? (
          <ChatThread
            conversation={state.page?.items.find((entry) => entry.id === conversationId)}
            messages={state.messages}
            currentUserId={userId}
            busy={state.busy}
            forbidden={state.forbidden || !state.loaded || state.pending !== null}
            pendingMessage={state.pending}
            connectionStatus={state.loaded ? connection : 'Загружаем историю…'}
            hasEarlierMessages={state.hasEarlier}
            canRetrySend={state.canRetry}
            policyBusy={state.policyBusy}
            attachments={[]}
            attachmentsEnabled={false}
            loadMedia={noMedia}
            onAttachFiles={noAttachments}
            onRemoveAttachment={noAttachments}
            onSendMessage={({ body }) => void controller.send(body)}
            onRetrySend={() => void controller.retry()}
            onRefresh={() => void controller.refresh()}
            onLoadEarlier={() => void controller.earlier()}
            onSetNotificationPolicy={(update) => void controller.policy(update)}
          />
        ) : state.page?.items.length === 0 ? (
          <p role="status">
            У вас пока нет чатов. Здесь появятся существующие личные диалоги и чаты игр.
          </p>
        ) : (
          <ChatList
            page={state.page}
            error={state.page === null && !!state.error}
            filter="ALL"
            query=""
            unreadOnly={false}
            stationRows={[]}
            onOpenStation={noAttachments}
          />
        )}
      </div>
      <MainBottomNavigation readOnly chatsAvailable active="chats" />
    </main>
  );
}
