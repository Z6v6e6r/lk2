import { useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';

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
      <textarea
        id="chat-message-body"
        rows={1}
        value={draft}
        maxLength={8000}
        placeholder={forbidden ? 'Отправка недоступна' : 'Введите сообщение'}
        disabled={busy || forbidden}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" disabled={busy || forbidden || !draft.trim()}>
        {busy ? 'Отправляем…' : 'Отправить'}
      </button>
      <small>Enter — новая строка · Ctrl/⌘+Enter — отправить</small>
    </form>
  );
}
