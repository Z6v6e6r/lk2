import { useEffect, useState } from 'react';
import styles from './ChatsUi.module.css';

export type CupReplyCursor = { at: string; id: string };
export type CupReplyPage = {
  messages: { id: string; number: string; body: string; createdAt: string }[];
  next: CupReplyCursor | null;
};
export type CupReplySource = (
  before?: CupReplyCursor,
  signal?: AbortSignal,
) => Promise<CupReplyPage>;

export function CupSupportChat({ load, close }: { load: CupReplySource; close: () => void }) {
  const [history, setHistory] = useState<CupReplyPage>();
  const [before, setBefore] = useState<CupReplyCursor>();
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void load(before, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setHistory((old) =>
          before && old
            ? {
                messages: [...old.messages, ...page.messages],
                next: page.next,
              }
            : page,
        );
        setFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [load, before, retry]);

  return (
    <section className={styles.thread} aria-label="Поддержка CUP" aria-busy={loading}>
      <header className={styles.threadHeader}>
        <button
          type="button"
          className={styles.cupReplyButton}
          onClick={close}
          aria-label="К списку чатов"
        >
          ←
        </button>
        <h2>Поддержка CUP</h2>
      </header>
      <div className={styles.cupReplies}>
        {failed && <p role="alert">Не удалось загрузить ответы CUP.</p>}
        {loading && <p role="status">Загружаем ответы…</p>}
        {history?.messages.length === 0 && !failed && (
          <p>Здесь появятся ответы на ваши обращения из формы CUP.</p>
        )}
        {history?.messages.length ? (
          <ol className={styles.cupReplyList}>
            {history.messages.map((message) => (
              <li key={message.id}>
                <strong>{message.number}</strong>
                <time dateTime={message.createdAt}>
                  {new Date(message.createdAt).toLocaleString('ru-RU')}
                </time>
                <p>{message.body}</p>
              </li>
            ))}
          </ol>
        ) : null}
        {history?.next && !failed && (
          <button
            type="button"
            className={styles.cupReplyButton}
            disabled={loading}
            onClick={() => {
              setLoading(true);
              setBefore(history.next ?? undefined);
            }}
          >
            Загрузить более ранние
          </button>
        )}
        <button
          type="button"
          className={styles.cupReplyButton}
          disabled={loading}
          onClick={() => {
            setLoading(true);
            if (!failed) setBefore(undefined);
            setRetry((value) => value + 1);
          }}
        >
          {failed ? 'Повторить' : 'Обновить'}
        </button>
        <a href="https://stg-support.tsup.space/">Создать обращение</a>
      </div>
    </section>
  );
}
