import { useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, KeyboardEvent } from 'react';

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
  /**
   * Station support dialogs accept pictures, but a deployment without a media bucket serves them
   * text-only, so the attach control can be switched off per thread.
   */
  readonly attachmentsEnabled?: boolean | undefined;
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
  attachmentsEnabled = true,
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
  const hint = attachmentsEnabled ? (selectionHint ?? attachmentNotice ?? null) : null;
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
      {attachmentsEnabled ? (
        <>
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
        </>
      ) : null}
      {attachmentsEnabled && attachments.length > 0 ? (
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
        {attachmentsEnabled ? (
          <button
            className={styles.attachButton}
            type="button"
            disabled={busy || forbidden || atAttachmentLimit}
            aria-label="Прикрепить файл"
            title={atAttachmentLimit ? 'Достигнут лимит вложений' : 'Прикрепить файл'}
            onClick={() => fileInputRef.current?.click()}
          >
            <span className={styles.attachIcon} aria-hidden="true">
              <svg width="32" height="32" viewBox="0 0 32 32" fill="currentColor">
                <path d="M14 16.6666H10.6667C10.2985 16.6666 10 16.3681 10 15.9999C10 15.6317 10.2985 15.3333 10.6667 15.3333H14V16.6666Z" />
                <path d="M21.3333 15.3333C21.7015 15.3333 22 15.6317 22 15.9999C22 16.3681 21.7015 16.6666 21.3333 16.6666H15.3333V15.3333H21.3333Z" />
                <path d="M16.6678 21.3333C16.6678 21.7015 16.3693 22 16.0011 22C15.6329 22 15.3345 21.7015 15.3345 21.3333V15.3333H16.6678V21.3333Z" />
                <path d="M16.0011 10C16.3693 10 16.6678 10.2985 16.6678 10.6667V14H15.3345V10.6667C15.3345 10.2985 15.6329 10 16.0011 10Z" />
              </svg>
            </span>
          </button>
        ) : null}
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
          <span className={styles.sendIcon} aria-hidden="true">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <path
                d="M21 15L16 10L11 15M16 21V10"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeMiterlimit="10"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </button>
      </div>
      <small id="chat-composer-hint" className="sr-only">
        Enter — новая строка · Ctrl/⌘+Enter — отправить
      </small>
    </form>
  );
}
