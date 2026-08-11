import { useState } from 'react';

import styles from './CommunitiesReadOnly.module.css';
import type { CommunityReadOnlyPost } from './types.js';

export function CommunityFeedList({
  posts,
}: {
  readonly posts: readonly CommunityReadOnlyPost[];
}): React.JSX.Element {
  if (!posts.length) return <p className={styles.empty}>В ленте пока нет публикаций.</p>;
  return (
    <section aria-label="Лента сообщества">
      <div className={styles.feedFilters} role="group" aria-label="Фильтры ленты">
        {['Все', 'Игры', 'Турниры', 'Новости'].map((label) => (
          <button
            key={label}
            type="button"
            className={label === 'Все' ? styles.feedFilterActive : styles.feedFilter}
            disabled
            aria-label={label === 'Все' ? 'Все публикации' : `${label}: фильтр недоступен`}
          >
            {label}
          </button>
        ))}
      </div>
      <ul className={styles.list}>
        {posts.map((post, index) => (
          <li key={`${post.publishedLabel}:${index}`} className={styles.card}>
            <div className={styles.cardBody}>
              <div className={styles.authorLine}>
                <Avatar name={post.author.displayName} src={post.author.avatarUrl} />
                <span className={styles.author}>{post.author.displayName}</span>
                <span className={styles.date}>{post.publishedLabel}</span>
              </div>
              <div className={styles.eventCard}>
                <p className={styles.postBody}>{post.body}</p>
                {post.imageUrl ? (
                  <img className={styles.postImage} src={post.imageUrl} alt="" />
                ) : null}
                <div className={styles.meta}>
                  {typeof post.reactionsCount === 'number' ? (
                    <span>♡ {post.reactionsCount}</span>
                  ) : null}
                  {typeof post.commentsCount === 'number' ? (
                    <span>◌ {post.commentsCount}</span>
                  ) : null}
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Avatar({
  name,
  src,
}: {
  readonly name: string;
  readonly src?: string | null | undefined;
}): React.JSX.Element {
  const [imageFailed, setImageFailed] = useState(false);
  const initial = name.trim().slice(0, 1).toLocaleUpperCase('ru-RU');
  return (
    <span className={styles.smallAvatar} aria-hidden="true">
      {src && !imageFailed ? (
        <img src={src} alt="" onError={() => setImageFailed(true)} />
      ) : (
        initial
      )}
    </span>
  );
}
