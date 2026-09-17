import { useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';

import { ChatCategoryIcon } from './ChatCategoryIcon.js';
import styles from './ChatsUi.module.css';

interface ChatComposerProps {
  readonly busy: boolean;
  readonly forbidden: boolean;
  readonly onSendMessage: (body: string) => void;
}

export function ChatComposer({
  busy,
  forbidden,
  onSendMessage,
}: ChatComposerProps): React.JSX.Element {
  const [draft, setDraft] = useState('');

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = draft.trim();
    if (!normalized || busy || forbidden) return;
    onSendMessage(normalized);
    setDraft('');
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    const composing = event.nativeEvent.isComposing || event.keyCode === 229;
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey) || composing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <form className={styles.composer} onSubmit={submit}>
      <label className="sr-only" htmlFor="chat-message-body">
        Сообщение
      </label>
      <div className={styles.composerLine}>
        <button
          className={styles.attachButton}
          type="button"
          disabled
          aria-label="Прикрепить файл — пока недоступно"
          title="Прикрепление файлов пока недоступно"
        >
          <span aria-hidden="true">+</span>
        </button>
        <textarea
          id="chat-message-body"
          rows={1}
          aria-describedby="chat-composer-hint"
          value={draft}
          maxLength={8000}
          placeholder={forbidden ? 'Отправка недоступна' : 'Введите сообщение'}
          disabled={busy || forbidden}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          className={styles.sendButton}
          type="submit"
          aria-label={busy ? 'Отправляем…' : 'Отправить'}
          title="Отправить"
          disabled={busy || forbidden || !draft.trim()}
        >
          <ChatCategoryIcon name="SEND" />
        </button>
      </div>
      <small id="chat-composer-hint" className="sr-only">
        Enter — новая строка · Ctrl/⌘+Enter — отправить
      </small>
    </form>
  );
}
