import { useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, KeyboardEvent } from 'react';

import { ChatCategoryIcon } from './ChatCategoryIcon.js';
import {
  MAX_CHAT_ATTACHMENTS,
  describeChatAttachmentRejections,
  formatAttachmentSize,
  validateChatAttachmentSelection,
  type ChatAttachmentDraft,
} from './chat-attachments.js';
import styles from './ChatsUi.module.css';

export interface ChatComposerSend {
  readonly body: string;
  readonly attachmentIds: readonly string[];
}

interface ChatComposerProps {
  readonly busy: boolean;
  readonly forbidden: boolean;
  readonly attachments: readonly ChatAttachmentDraft[];
  readonly attachmentNotice?: string | null | undefined;
  readonly onAttachFiles: (files: readonly File[]) => void;
  readonly onRemoveAttachment: (localId: string) => void;
  readonly onSendMessage: (input: ChatComposerSend) => void;
}

const ATTACHMENT_ACCEPT = 'image/jpeg,image/png,image/webp,*/*';

export function ChatComposer({
  busy,
  forbidden,
  attachments,
  attachmentNotice,
  onAttachFiles,
  onRemoveAttachment,
  onSendMessage,
}: ChatComposerProps): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const [selectionHint, setSelectionHint] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const readyAttachmentIds = attachments
    .filter((attachment) => attachment.state === 'READY' && attachment.mediaId)
    .map((attachment) => attachment.mediaId as string);
  const attachmentsBusy = attachments.some(
    (attachment) => attachment.state === 'UPLOADING' || attachment.state === 'SCANNING',
  );
  const hint = selectionHint ?? attachmentNotice ?? null;
  const atAttachmentLimit = attachments.length >= MAX_CHAT_ATTACHMENTS;
  const canSend =
    !busy &&
    !forbidden &&
    !attachmentsBusy &&
    (draft.trim().length > 0 || readyAttachmentIds.length > 0);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canSend) return;
    onSendMessage({ body: draft.trim(), attachmentIds: readyAttachmentIds });
    setDraft('');
    setSelectionHint(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    const composing = event.nativeEvent.isComposing || event.keyCode === 229;
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey) || composing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function onFilesChosen(event: ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(event.target.files ?? []);
    // Allow choosing the same file again after a rejection or removal.
    event.target.value = '';
    if (files.length === 0) return;
    const selection = validateChatAttachmentSelection(attachments.length, files);
    setSelectionHint(describeChatAttachmentRejections(selection.rejections));
    if (selection.accepted.length > 0) onAttachFiles(selection.accepted);
  }

  return (
    <form className={styles.composer} onSubmit={submit}>
      <label className="sr-only" htmlFor="chat-message-body">
        Сообщение
      </label>
      <input
        ref={fileInputRef}
        id="chat-attachment-input"
        className="sr-only"
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        tabIndex={-1}
        onChange={onFilesChosen}
      />
      <label className="sr-only" htmlFor="chat-attachment-input">
        Выбрать файлы для прикрепления
      </label>
      {attachments.length > 0 ? (
        <ul className={styles.attachmentChips} aria-label="Выбранные вложения">
          {attachments.map((attachment) => (
            <li key={attachment.localId} className={styles.attachmentChip}>
              <span className={styles.attachmentChipIcon} aria-hidden="true">
                {attachment.mediaType === 'IMAGE' ? '🖼' : '📄'}
              </span>
              <span className={styles.attachmentChipBody}>
                <span className={styles.attachmentChipName} title={attachment.fileName}>
                  {attachment.fileName}
                </span>
                <span className={styles.attachmentChipMeta}>
                  {formatAttachmentSize(attachment.byteSize)}
                  {attachment.state === 'UPLOADING' ? ` · ${attachment.progress}%` : null}
                  {attachment.state === 'SCANNING' ? ' · проверяем' : null}
                  {attachment.state === 'READY' ? ' · готово' : null}
                  {attachment.state === 'FAILED' ? ' · не загрузилось' : null}
                </span>
                {attachment.state === 'UPLOADING' ? (
                  <progress
                    className={styles.attachmentProgress}
                    max={100}
                    value={attachment.progress}
                    aria-label={`Загрузка ${attachment.fileName}`}
                  />
                ) : null}
              </span>
              <button
                type="button"
                className={styles.attachmentRemove}
                aria-label={`Убрать ${attachment.fileName}`}
                title="Убрать вложение"
                disabled={busy}
                onClick={() => onRemoveAttachment(attachment.localId)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {hint ? (
        <p id="chat-attachment-hint" className={styles.attachmentHint} role="status">
          {hint}
        </p>
      ) : null}
      <div className={styles.composerLine}>
        <button
          className={styles.attachButton}
          type="button"
          disabled={busy || forbidden || atAttachmentLimit}
          aria-label="Прикрепить файл"
          title={atAttachmentLimit ? 'Достигнут лимит вложений' : 'Прикрепить файл'}
          onClick={() => fileInputRef.current?.click()}
        >
          <span aria-hidden="true">+</span>
        </button>
        <textarea
          id="chat-message-body"
          rows={1}
          aria-describedby="chat-composer-hint chat-attachment-hint"
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
          disabled={!canSend}
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
