import { useState } from 'react';

import type { ConversationNotificationPolicyUpdate, ConversationSummary } from '../auth-gateway.js';
import { ChatCategoryIcon } from './ChatCategoryIcon.js';
import { conversationTitle, initials } from './chat-format.js';
import styles from './ChatsUi.module.css';

const TEMPORARY_MUTE_MS = 8 * 60 * 60 * 1_000;

interface ChatThreadHeaderProps {
  readonly conversation: ConversationSummary | undefined;
  readonly busy: boolean;
  readonly policyBusy: boolean;
  readonly onRefresh: () => void;
  readonly onSetNotificationPolicy: (update: ConversationNotificationPolicyUpdate) => void;
  readonly connectionStatus?: string | null | undefined;
}

export function ChatThreadHeader({
  conversation,
  busy,
  policyBusy,
  onRefresh,
  onSetNotificationPolicy,
  connectionStatus,
}: ChatThreadHeaderProps): React.JSX.Element {
  const [policyOpen, setPolicyOpen] = useState(false);
  const title = conversation ? conversationTitle(conversation) : 'Диалог';
  const isGame = conversation?.kind === 'GAME';
  const policy = conversation?.notificationPolicy;
  const muted = policy?.muted === true;
  const temporaryMute = muted && policy?.level === 'ALL';
  const policyKnown = policy !== undefined;

  function applyPolicy(update: ConversationNotificationPolicyUpdate): void {
    setPolicyOpen(false);
    onSetNotificationPolicy(update);
  }

  return (
    <header className={styles.threadHeader}>
      <a className={styles.backLink} href="/chats" aria-label="Назад к чатам">
        <span aria-hidden="true">←</span>
      </a>
      <span className={`${styles.avatar} ${isGame ? styles.gameAvatar : ''}`} aria-hidden="true">
        {isGame ? <ChatCategoryIcon name="GAME" /> : initials(title)}
      </span>
      <div className={styles.threadHeading}>
        <h2>{title}</h2>
        <small>
          {isGame ? 'Чат игры' : 'Личный чат'}
          {muted ? ' · уведомления выключены' : ''}
        </small>
        {connectionStatus ? <span role="status">{connectionStatus}</span> : null}
      </div>
      <div className={styles.policyControl}>
        <button
          type="button"
          className={`${styles.refreshButton} ${muted ? styles.policyButtonMuted : ''}`}
          aria-label={
            !policyKnown
              ? 'Уведомления в этом чате ещё не загружены'
              : muted
                ? 'Уведомления выключены'
                : 'Уведомления включены'
          }
          aria-haspopup="true"
          aria-expanded={policyOpen}
          title="Уведомления в этом чате"
          disabled={policyBusy || !policyKnown}
          onClick={() => setPolicyOpen(!policyOpen)}
        >
          <ChatCategoryIcon name={muted ? 'BELL_OFF' : 'NOTIFICATIONS'} />
        </button>
        {policyOpen && policyKnown ? (
          <div className={styles.policyMenu} role="menu" aria-label="Уведомления в этом чате">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!muted}
              disabled={policyBusy}
              onClick={() => applyPolicy({ level: 'ALL' })}
            >
              Включены
            </button>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={temporaryMute}
              disabled={policyBusy}
              onClick={() =>
                applyPolicy({
                  level: 'ALL',
                  mutedUntil: new Date(Date.now() + TEMPORARY_MUTE_MS).toISOString(),
                })
              }
            >
              Выключить на 8 часов
            </button>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={policy?.level === 'NONE'}
              disabled={policyBusy}
              onClick={() => applyPolicy({ level: 'NONE' })}
            >
              Выключить
            </button>
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className={styles.refreshButton}
        aria-label={busy ? 'Обновляем…' : 'Обновить'}
        title="Обновить"
        disabled={busy}
        onClick={onRefresh}
      >
        <ChatCategoryIcon name="REFRESH" />
      </button>
    </header>
  );
}
