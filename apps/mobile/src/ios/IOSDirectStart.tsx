import { useEffect, useSyncExternalStore } from 'react';
import { MainBottomNavigation } from '../../../web/src/HomeDashboardPage.js';
import type { IOSDirectController } from './direct-start.js';
import styles from '../../../web/src/chats-ui/ChatsUi.module.css';

export function IOSDirectStart({
  controller,
  recipient,
}: {
  readonly controller: IOSDirectController;
  readonly recipient: string | null;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  useEffect(() => {
    controller.activate(recipient);
    return () => controller.stop();
  }, [controller, recipient]);
  useEffect(() => {
    if (!state.conversationId) return;
    window.history.replaceState(null, '', `/chats/${state.conversationId}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, [state.conversationId]);
  return (
    <main className="games-page ios-cabinet-page">
      <section className={styles.directStart}>
        <a href="/chats">← К диалогам</a>
        <h1>{state.error ? 'Новый личный чат' : 'Открываем диалог…'}</h1>
        {state.error ? (
          <div className={styles.errorBanner} role="alert">
            <span>{state.error}</span>
            {state.canRetry ? (
              <button type="button" disabled={state.busy} onClick={() => void controller.attempt()}>
                Повторить
              </button>
            ) : null}
          </div>
        ) : (
          <p role="status">Открываем личный чат с выбранным игроком.</p>
        )}
      </section>
      <MainBottomNavigation readOnly chatsAvailable active="chats" />
    </main>
  );
}
