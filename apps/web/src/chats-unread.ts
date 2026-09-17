import { useSyncExternalStore } from 'react';

import type { ConversationPage } from './auth-gateway.js';

/**
 * Module-level unread-chat counter shared by every bottom-navigation instance. The navigation is
 * rendered by each page, so a store keeps the badge consistent without threading a prop through
 * every page component. The value is scoped to the currently signed-in session; the app resets it
 * on logout and on an unavailable conversation read.
 */
let unreadCount = 0;
const listeners = new Set<() => void>();

export const CHATS_UNREAD_REFRESH_INTERVAL_MS = 60_000;

export function totalUnreadConversations(page: ConversationPage): number {
  return page.items.reduce(
    (total, conversation) => total + Math.max(0, Math.trunc(conversation.unreadCount)),
    0,
  );
}

export function setChatsUnreadCount(count: number): void {
  const next = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
  if (next === unreadCount) return;
  unreadCount = next;
  for (const listener of listeners) listener();
}

export function getChatsUnreadCount(): number {
  return unreadCount;
}

export function subscribeChatsUnreadCount(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useChatsUnreadCount(): number {
  return useSyncExternalStore(subscribeChatsUnreadCount, getChatsUnreadCount, () => 0);
}
