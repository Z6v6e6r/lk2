import type { CommunityChatMessage } from './community-chat-rows.js';
import type { StationSupportMessage } from '../auth-gateway.js';

/**
 * A thread is served by the same legacy projection as the member directory, so opening one costs the
 * same seconds. The buffered page is the last page the viewer actually saw: it is painted when the
 * thread opens and a fresh page replaces it in the background. Only the newest messages are kept, and
 * only for one browser tab session, because a thread is other people's content.
 */
const CACHE_VERSION = 1;

export interface ThreadPageCache<T> {
  read(userId: string, threadId: string): readonly T[] | null;
  write(userId: string, threadId: string, messages: readonly T[]): void;
  clear(userId: string, threadId: string): void;
}

function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    // Storage can be unavailable in private browsing and embedded previews.
    return null;
  }
}

export function threadPageCacheKey(name: string, userId: string, threadId: string): string {
  return `lk2:chats:${name}:${CACHE_VERSION}:${userId}:${threadId}`;
}

/**
 * The cache is read by a build that may be older or newer than the one that wrote it, so every item
 * is validated before it reaches the UI; one unusable message discards the whole buffered page.
 */
export function createThreadPageCache<T>(options: {
  readonly name: string;
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly isMessage: (value: unknown) => value is T;
  readonly storage?: (() => Storage | null) | undefined;
}): ThreadPageCache<T> {
  const store = options.storage ?? sessionStore;
  return {
    read(userId, threadId) {
      const target = store();
      if (!target) return null;
      try {
        const stored = target.getItem(threadPageCacheKey(options.name, userId, threadId));
        if (!stored) return null;
        const parsed: unknown = JSON.parse(stored);
        if (!Array.isArray(parsed) || parsed.length === 0) return null;
        if (parsed.length > options.maxItems) return null;
        if (!parsed.every(options.isMessage)) return null;
        return parsed;
      } catch {
        // A corrupted or unreadable buffer is absent, not fatal.
        return null;
      }
    },
    write(userId, threadId, messages) {
      const target = store();
      if (!target) return;
      try {
        // The tail is what the viewer was reading: a fresh page will restore the rest.
        const payload = JSON.stringify(messages.slice(-options.maxItems));
        if (payload.length > options.maxBytes) {
          target.removeItem(threadPageCacheKey(options.name, userId, threadId));
          return;
        }
        target.setItem(threadPageCacheKey(options.name, userId, threadId), payload);
      } catch {
        // A full or unavailable storage keeps the in-memory thread working without the buffer.
      }
    },
    clear(userId, threadId) {
      const target = store();
      if (!target) return;
      try {
        target.removeItem(threadPageCacheKey(options.name, userId, threadId));
      } catch {
        // Nothing to clear when storage is unavailable.
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCommunityChatMessage(value: unknown): value is CommunityChatMessage {
  if (!isRecord(value) || !isRecord(value.author)) return false;
  return (
    typeof value.body === 'string' &&
    typeof value.sentAt === 'string' &&
    typeof value.author.displayName === 'string' &&
    typeof value.isViewer === 'boolean'
  );
}

function isStationAttachment(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.fileName === 'string' &&
    typeof value.contentType === 'string' &&
    typeof value.byteSize === 'number' &&
    typeof value.url === 'string'
  );
}

function isStationSupportMessage(value: unknown): value is StationSupportMessage {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.body === 'string' &&
    (value.author === 'ME' || value.author === 'STATION' || value.author === 'SYSTEM') &&
    (value.authorName === null || typeof value.authorName === 'string') &&
    typeof value.createdAt === 'string' &&
    Array.isArray(value.attachments) &&
    value.attachments.every(isStationAttachment)
  );
}

export const communityThreadCache = createThreadPageCache<CommunityChatMessage>({
  name: 'community-thread',
  maxItems: 50,
  maxBytes: 32_768,
  isMessage: isCommunityChatMessage,
});

export const stationThreadCache = createThreadPageCache<StationSupportMessage>({
  name: 'station-thread',
  maxItems: 50,
  maxBytes: 131_072,
  isMessage: isStationSupportMessage,
});
