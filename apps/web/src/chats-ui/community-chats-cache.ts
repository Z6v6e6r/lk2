import type { CommunityRow } from './community-chat-rows.js';

/**
 * The member directory is served by the legacy community projection, which answers in seconds. The
 * cached copy is what the Сообщества tab paints while the fresh read is in flight, so it is kept in
 * `sessionStorage` next to the other per-tab chat view state: it survives a route change or a reload
 * inside one browser tab, and it never outlives the session that produced it.
 */
const CACHE_VERSION = 1;
const MAX_CACHED_COMMUNITIES = 50;
/** A directory entry is small; anything larger means unusable bytes, not a long member list. */
const MAX_CACHED_BYTES = 32_768;

export interface CommunityChatsCache {
  readonly communities: readonly CommunityRow[];
  readonly nextCursor: string | null;
}

export function communityChatsCacheKey(userId: string): string {
  return `lk2:chats:community-directory:${CACHE_VERSION}:${userId}`;
}

function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    // Storage can be unavailable in private browsing and embedded previews.
    return null;
  }
}

/**
 * A cache is not a contract: it is written by an older build of this app and read after an upgrade,
 * so every field is checked before a row reaches the UI. A single unusable entry discards the whole
 * copy rather than rendering a half-valid directory.
 */
function isCommunityRow(value: unknown): value is CommunityRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    row.id.length > 0 &&
    typeof row.title === 'string' &&
    row.title.length > 0 &&
    (row.logoUrl === null || typeof row.logoUrl === 'string') &&
    typeof row.isVerified === 'boolean' &&
    typeof row.unreadChatCount === 'number' &&
    Number.isFinite(row.unreadChatCount) &&
    row.unreadChatCount >= 0 &&
    (row.memberRank === undefined ||
      (typeof row.memberRank === 'number' && Number.isFinite(row.memberRank))) &&
    typeof row.route === 'string'
  );
}

export function readCommunityChatsCache(
  userId: string,
  storage: Storage | null = sessionStore(),
): CommunityChatsCache | null {
  if (!storage) return null;
  try {
    const stored = storage.getItem(communityChatsCacheKey(userId));
    if (!stored) return null;
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Record<string, unknown>;
    const items = candidate.communities;
    if (!Array.isArray(items) || items.length > MAX_CACHED_COMMUNITIES) return null;
    if (!items.every(isCommunityRow)) return null;
    const nextCursor = candidate.nextCursor;
    if (nextCursor !== null && (typeof nextCursor !== 'string' || nextCursor.length === 0))
      return null;
    return { communities: items, nextCursor };
  } catch {
    // A corrupted or unreadable cache is absent, not fatal.
    return null;
  }
}

export function writeCommunityChatsCache(
  userId: string,
  communities: readonly CommunityRow[],
  nextCursor: string | null,
  storage: Storage | null = sessionStore(),
): void {
  if (!storage) return;
  try {
    const payload = JSON.stringify({
      communities: communities.slice(0, MAX_CACHED_COMMUNITIES),
      nextCursor,
    });
    if (payload.length > MAX_CACHED_BYTES) {
      storage.removeItem(communityChatsCacheKey(userId));
      return;
    }
    storage.setItem(communityChatsCacheKey(userId), payload);
  } catch {
    // A full or unavailable storage keeps the in-memory list working without the cache.
  }
}

export function clearCommunityChatsCache(
  userId: string,
  storage: Storage | null = sessionStore(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(communityChatsCacheKey(userId));
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}
