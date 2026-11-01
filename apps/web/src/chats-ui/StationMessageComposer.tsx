import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { parseStationMessageReceipt } from '@phub/api-sdk';
import type { StationMessageReceipt, StationMessageRequest } from '../auth-gateway.js';
import { StationMessageCustody } from './station-message-custody.js';
import styles from './ChatsUi.module.css';
export interface StationMessageComposerProps {
  readonly scope: string;
  readonly communityId: string;
  readonly eligible: boolean;
  readonly send: (
    communityId: string,
    request: StationMessageRequest,
  ) => Promise<StationMessageReceipt>;
  readonly status: (communityId: string, requestId: string) => Promise<StationMessageReceipt>;
  readonly onConfirmed: (
    message: Extract<StationMessageReceipt, { outcome: 'CONFIRMED' }>['message'],
  ) => void;
  readonly onAccessDenied: () => void;
}
export function StationMessageComposer(props: StationMessageComposerProps): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const draftRef = useRef(draft);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [notice, setNotice] = useState('');
  const [pendingCount, setPendingCount] = useState(0);
  const active = useRef(true);
  const propsRef = useRef(props);
  useLayoutEffect(() => {
    propsRef.current = props;
  }, [props]);
  const [custody] = useState(() => {
    try {
      return new StationMessageCustody(props.scope, props.communityId, window.sessionStorage);
    } catch {
      return null;
    }
  });
  function updatePending(): void {
    try {
      setPendingCount(custody?.pending().length ?? 0);
    } catch {
      setNotice('Не удалось прочитать исходные запросы. Новая отправка недоступна.');
    }
  }
  function unavailable(error: unknown): void {
    if (!active.current) return;
    if (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      [401, 403, 404].includes(Number(error.status))
    )
      propsRef.current.onAccessDenied();
    setNotice('Статус пока неизвестен. Проверка не отправляет сообщение повторно.');
  }
  async function accept(value: unknown, requestId: string, text?: string): Promise<boolean> {
    const receipt = parseStationMessageReceipt(value, requestId, text);
    if (!active.current) return false;
    if (receipt.outcome !== 'CONFIRMED') {
      setNotice('Не удалось подтвердить отправку. Проверьте статус сообщения.');
      return false;
    }
    if (!custody || !(await custody.matchesOriginal(requestId, receipt.message.body)))
      throw new Error('STATION_MESSAGE_RECEIPT_UNKNOWN');
    if (!active.current) return false;
    propsRef.current.onConfirmed(receipt.message);
    custody?.confirmed(requestId);
    updatePending();
    setNotice('Сообщение сохранено. Это не подтверждение прочтения.');
    return true;
  }
  async function restore(): Promise<void> {
    if (inFlight.current || !custody) return;
    inFlight.current = true;
    setBusy(true);
    try {
      for (const original of custody.pending()) {
        if (!active.current) break;
        try {
          await accept(
            await propsRef.current.status(props.communityId, original.requestId),
            original.requestId,
          );
        } catch (error) {
          unavailable(error);
        }
      }
      if (active.current) updatePending();
    } catch (error) {
      unavailable(error);
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    queueMicrotask(() => {
      if (active.current) {
        updatePending();
        void restore();
      }
    });
    // A keyed component owns exactly one tenant/user/community. Restore is GET-only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function send(): Promise<void> {
    if (inFlight.current || !custody || !props.eligible) return;
    const text = draftRef.current;
    if (!text.trim() || text.length > 8000) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const original = await custody.original(text);
      if (!active.current) return;
      updatePending();
      const result = await props.send(props.communityId, { requestId: original.requestId, text });
      if ((await accept(result, original.requestId, text)) && draftRef.current === text) {
        draftRef.current = '';
        setDraft('');
      }
    } catch (error) {
      unavailable(error);
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <div>
      {props.eligible ? (
        <form
          className={styles.composer}
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label className="sr-only" htmlFor={`station-message-${props.communityId}`}>
            Сообщение сообществу
          </label>
          <div className={styles.composerLine}>
            <textarea
              placeholder="Сообщение сообществу"
              id={`station-message-${props.communityId}`}
              value={draft}
              maxLength={8000}
              onChange={(event) => {
                draftRef.current = event.target.value;
                setDraft(event.target.value);
              }}
            />
            <button
              type="submit"
              className={styles.sendButton}
              aria-label="Отправить"
              disabled={busy || !custody || !draft.trim()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="m4 4 17 8-17 8 3-8-3-8Zm3 8h14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </form>
      ) : null}
      {pendingCount > 0 ? (
        <div className={styles.retryBar}>
          <span>
            Ожидают подтверждения: {pendingCount}. После перезагрузки текст черновика не
            сохраняется.
          </span>
          <button type="button" disabled={busy} onClick={() => void restore()}>
            Проверить статус
          </button>
        </div>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {!custody ? (
        <p role="status">Для безопасной отправки требуется хранилище этой вкладки.</p>
      ) : null}
    </div>
  );
}
