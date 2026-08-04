import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';

import type {
  CommunityFeedPage,
  CommunityMediaStatus,
  CommunityMediaUploadIssueRequest,
  CommunityMediaUploadIssued,
  CommunityPost,
  CommunityPostCreateRequest,
  CommunityPostMedia,
} from '@phub/api-sdk';

const MAX_MEDIA = 10;
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
const ACCEPTED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

type UploadState = 'UPLOADING' | 'SCANNING' | 'READY' | 'FAILED';

interface PendingUpload {
  readonly localId: string;
  readonly file: File;
  readonly state: UploadState;
  readonly mediaId?: string;
  readonly error?: string;
}

export interface CommunityFeedProps {
  readonly communityId: string;
  readonly canPublish: boolean;
  readonly canonicalSnapshot?: {
    readonly revision: number;
    readonly page: CommunityFeedPage;
  };
  readonly loadFeed: (communityId: string, cursor?: string) => Promise<CommunityFeedPage>;
  readonly issueMediaUpload: (
    communityId: string,
    input: CommunityMediaUploadIssueRequest,
  ) => Promise<CommunityMediaUploadIssued>;
  readonly finalizeMediaUpload: (
    communityId: string,
    mediaId: string,
    expectedRevision: number,
  ) => Promise<CommunityMediaStatus>;
  readonly getMediaStatus: (communityId: string, mediaId: string) => Promise<CommunityMediaStatus>;
  readonly createPost: (
    communityId: string,
    input: CommunityPostCreateRequest,
  ) => Promise<CommunityPost>;
  readonly loadMediaVariant: (
    communityId: string,
    mediaId: string,
    variant: 'THUMBNAIL' | 'FEED',
  ) => Promise<Blob>;
  readonly pollIntervalMs?: number;
  readonly maxPollAttempts?: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fileSha256(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function mediaError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Не удалось загрузить изображение.';
}

function CommunityPostImage({
  communityId,
  media,
  loadMediaVariant,
}: {
  readonly communityId: string;
  readonly media: CommunityPostMedia;
  readonly loadMediaVariant: CommunityFeedProps['loadMediaVariant'];
}): React.JSX.Element {
  const [source, setSource] = useState<string>();
  const [failed, setFailed] = useState(false);
  const variant = media.variants.some((item) => item.variant === 'FEED') ? 'FEED' : 'THUMBNAIL';
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    void loadMediaVariant(communityId, media.id, variant).then(
      (blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [communityId, loadMediaVariant, media.id, variant]);
  if (failed) return <span>Изображение недоступно</span>;
  return source ? (
    <img src={source} alt="Изображение публикации" />
  ) : (
    <span>Загружаем изображение…</span>
  );
}

function CommunityFeedState({
  communityId,
  canPublish,
  canonicalSnapshot,
  loadFeed,
  issueMediaUpload,
  finalizeMediaUpload,
  getMediaStatus,
  createPost,
  loadMediaVariant,
  pollIntervalMs = 1_000,
  maxPollAttempts = 60,
}: CommunityFeedProps): React.JSX.Element {
  const [posts, setPosts] = useState<readonly CommunityPost[]>(() =>
    canonicalSnapshot
      ? canonicalSnapshot.page.items.filter((post) => post.status === 'PUBLISHED')
      : [],
  );
  const [nextCursor, setNextCursor] = useState<string | undefined>(
    canonicalSnapshot?.page.nextCursor,
  );
  const [loadedCommunityId, setLoadedCommunityId] = useState<string | undefined>(
    canonicalSnapshot ? communityId : undefined,
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [feedError, setFeedError] = useState<string>();
  const [body, setBody] = useState('');
  const [uploads, setUploads] = useState<readonly PendingUpload[]>([]);
  const [composerError, setComposerError] = useState<string>();
  const [publishing, setPublishing] = useState(false);
  const [publicationNotice, setPublicationNotice] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    if (canonicalSnapshot) {
      return () => {
        active = false;
        mounted.current = false;
      };
    }
    void loadFeed(communityId).then(
      (page) => {
        if (!active) return;
        setPosts(page.items.filter((post) => post.status === 'PUBLISHED'));
        setNextCursor(page.nextCursor);
        setFeedError(undefined);
        setLoadedCommunityId(communityId);
      },
      () => {
        if (!active) return;
        setFeedError('Не удалось загрузить ленту сообщества.');
        setLoadedCommunityId(communityId);
      },
    );
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [canonicalSnapshot, communityId, loadFeed]);

  function updateUpload(localId: string, update: Partial<PendingUpload>): void {
    if (!mounted.current) return;
    setUploads((current) =>
      current.map((upload) => (upload.localId === localId ? { ...upload, ...update } : upload)),
    );
  }

  async function processFile(upload: PendingUpload): Promise<void> {
    try {
      const issued = await issueMediaUpload(communityId, {
        mediaType: 'IMAGE',
        contentType: upload.file.type as CommunityMediaUploadIssueRequest['contentType'],
        byteSize: upload.file.size,
        sha256: await fileSha256(upload.file),
      });
      updateUpload(upload.localId, { mediaId: issued.id });
      const stored = await fetch(issued.upload.url, {
        method: 'PUT',
        headers: issued.upload.requiredHeaders,
        body: upload.file,
        redirect: 'error',
      });
      if (!stored.ok) throw new Error('Хранилище отклонило загрузку изображения.');
      let status = await finalizeMediaUpload(communityId, issued.id, issued.revision);
      updateUpload(upload.localId, { state: status.state === 'READY' ? 'READY' : 'SCANNING' });
      for (
        let attempt = 0;
        status.state === 'SCANNING' && attempt < maxPollAttempts;
        attempt += 1
      ) {
        await delay(pollIntervalMs);
        status = await getMediaStatus(communityId, issued.id);
      }
      if (status.state !== 'READY') {
        throw new Error(
          status.state === 'REJECTED'
            ? 'Изображение не прошло проверку безопасности.'
            : 'Изображение не было обработано вовремя.',
        );
      }
      updateUpload(upload.localId, { state: 'READY', mediaId: issued.id });
    } catch (error) {
      updateUpload(upload.localId, { state: 'FAILED', error: mediaError(error) });
    }
  }

  function selectFiles(event: ChangeEvent<HTMLInputElement>): void {
    const selected = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = '';
    setComposerError(undefined);
    if (uploads.length + selected.length > MAX_MEDIA) {
      setComposerError('К одному посту можно прикрепить не более 10 изображений.');
      return;
    }
    const invalid = selected.find(
      (file) =>
        !ACCEPTED_MEDIA_TYPES.has(file.type) || file.size < 1 || file.size > MAX_MEDIA_BYTES,
    );
    if (invalid) {
      setComposerError('Допустимы JPEG, PNG или WebP размером до 15 МиБ.');
      return;
    }
    const pending = selected.map<PendingUpload>((file) => ({
      localId: globalThis.crypto.randomUUID(),
      file,
      state: 'UPLOADING',
    }));
    setUploads((current) => [...current, ...pending]);
    pending.forEach((upload) => void processFile(upload));
  }

  function removeUpload(localId: string): void {
    setUploads((current) => current.filter((upload) => upload.localId !== localId));
  }

  async function publish(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const text = body.trim();
    if (!text) {
      setComposerError('Напишите текст публикации.');
      return;
    }
    if (uploads.some((upload) => upload.state !== 'READY' || !upload.mediaId)) return;
    setPublishing(true);
    setComposerError(undefined);
    setPublicationNotice(undefined);
    try {
      const post = await createPost(communityId, {
        body: text,
        mediaIds: uploads.flatMap((upload) => (upload.mediaId ? [upload.mediaId] : [])),
      });
      if (post.status === 'PUBLISHED') {
        setPosts((current) => [post, ...current.filter((item) => item.id !== post.id)]);
        setPublicationNotice('Публикация размещена.');
      } else if (post.status === 'PENDING_MODERATION') {
        setPublicationNotice('Публикация отправлена на модерацию.');
      } else {
        throw new Error('Сервер вернул недоступное состояние публикации.');
      }
      setBody('');
      setUploads([]);
      if (fileInput.current) fileInput.current.value = '';
    } catch (error) {
      setComposerError(mediaError(error));
    } finally {
      setPublishing(false);
    }
  }

  async function loadMore(): Promise<void> {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await loadFeed(communityId, nextCursor);
      setPosts((current) => {
        const byId = new Map(current.map((post) => [post.id, post]));
        page.items
          .filter((post) => post.status === 'PUBLISHED')
          .forEach((post) => byId.set(post.id, post));
        return [...byId.values()];
      });
      setNextCursor(page.nextCursor);
    } catch {
      setFeedError('Не удалось загрузить следующую страницу.');
    } finally {
      setLoadingMore(false);
    }
  }

  const mediaReady = uploads.every((upload) => upload.state === 'READY' && upload.mediaId);
  const publishEnabled = canPublish && body.trim().length > 0 && mediaReady && !publishing;
  const loading = loadedCommunityId !== communityId;

  return (
    <section className="community-feed" aria-label="Лента сообщества">
      {canPublish ? (
        <form className="community-composer" onSubmit={(event) => void publish(event)}>
          <label htmlFor={`community-post-body-${communityId}`}>Новая публикация</label>
          <textarea
            id={`community-post-body-${communityId}`}
            value={body}
            onChange={(event) => setBody(event.currentTarget.value)}
            maxLength={10_000}
            required
            placeholder="Поделитесь новостью с сообществом"
          />
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            onChange={selectFiles}
            aria-label="Добавить изображения"
          />
          {uploads.length > 0 ? (
            <ul className="community-composer-media" aria-label="Выбранные изображения">
              {uploads.map((upload) => (
                <li key={upload.localId}>
                  <span>{upload.file.name}</span>
                  <small>
                    {upload.state === 'UPLOADING'
                      ? 'Загружаем…'
                      : upload.state === 'SCANNING'
                        ? 'Проверяем…'
                        : upload.state === 'READY'
                          ? 'Готово'
                          : upload.error}
                  </small>
                  <button
                    type="button"
                    onClick={() => removeUpload(upload.localId)}
                    disabled={upload.state === 'UPLOADING' || upload.state === 'SCANNING'}
                    aria-label={`Убрать ${upload.file.name}`}
                  >
                    Убрать
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {composerError ? <p role="alert">{composerError}</p> : null}
          {publicationNotice ? <p role="status">{publicationNotice}</p> : null}
          <button type="submit" disabled={!publishEnabled}>
            {publishing ? 'Публикуем…' : 'Опубликовать'}
          </button>
        </form>
      ) : null}

      {loading ? <p role="status">Загружаем ленту…</p> : null}
      {feedError ? <p role="alert">{feedError}</p> : null}
      {!loading && posts.length === 0 && !feedError ? <p>Публикаций пока нет.</p> : null}
      {posts.length > 0 ? (
        <ol className="community-feed-list">
          {posts.map((post) => (
            <li key={post.id}>
              <article>
                <p>{post.body}</p>
                {post.media?.map((media) => (
                  <CommunityPostImage
                    key={media.id}
                    communityId={communityId}
                    media={media}
                    loadMediaVariant={loadMediaVariant}
                  />
                ))}
              </article>
            </li>
          ))}
        </ol>
      ) : null}
      {nextCursor ? (
        <button type="button" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? 'Загружаем…' : 'Показать ещё'}
        </button>
      ) : null}
    </section>
  );
}

export function CommunityFeed(props: CommunityFeedProps): React.JSX.Element {
  const snapshotKey = props.canonicalSnapshot?.revision ?? 'http';
  return <CommunityFeedState key={`${props.communityId}:${snapshotKey}`} {...props} />;
}
