import type { CommunityMembershipPage, CommunityReadExperienceChatPage } from '../auth-gateway.js';

/** One destination row of the Сообщества tab: a community the viewer is a member of. */
export type CommunityRow = CommunityMembershipPage['items'][number];
export type CommunityChatMessage = CommunityReadExperienceChatPage['items'][number];

/** The projection has no last-message preview for a community chat, so the row states what it is. */
export const COMMUNITY_CHAT_PREVIEW = 'Чат сообщества';

/**
 * A community chat message carries no identifier of its own: the provider addresses the history by
 * the send instant, and the projection exposes that instant together with the author and the body.
 * Two identical messages sent within the same second therefore share a key. That is the honest
 * limit of this read contract, and it is preferable to showing the same history page twice.
 */
export function communityMessageKey(message: CommunityChatMessage): string {
  return `${message.sentAt}|${message.author.displayName}|${message.body}`;
}

/**
 * The provider pages a community chat newest first, because "earlier" walks backwards from the end
 * of the thread. A conversation reads the other way round, so every arriving page is turned around
 * before it is placed above the messages that are already on screen.
 */
export function communityThreadPage(
  page: CommunityReadExperienceChatPage,
): readonly CommunityChatMessage[] {
  return [...page.items].reverse();
}

/**
 * Search and the unread toggle belong to the tab, so both apply to the member communities. Only the
 * title is searchable: the directory item carries no preview text, and the unread counter itself is
 * not a search term.
 */
export function communityRows(input: {
  readonly communities: readonly CommunityRow[];
  readonly query: string;
  readonly unreadOnly: boolean;
}): readonly CommunityRow[] {
  const normalizedQuery = input.query.trim().toLocaleLowerCase('ru-RU');
  return input.communities.filter((community) => {
    if (input.unreadOnly && community.unreadChatCount <= 0) return false;
    if (!normalizedQuery) return true;
    return community.title.toLocaleLowerCase('ru-RU').includes(normalizedQuery);
  });
}

/** Appending a page must not repeat a community the viewer already sees. */
export function appendCommunityPage(
  current: readonly CommunityRow[],
  items: readonly CommunityRow[],
): readonly CommunityRow[] {
  const known = new Set(current.map((community) => community.id));
  return [...current, ...items.filter((community) => !known.has(community.id))];
}
