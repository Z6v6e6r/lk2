import type { CommunityMembershipPage, CommunityReadExperienceChatPage } from '../auth-gateway.js';

/** One destination row of the Сообщества tab: a community the viewer is a member of. */
export type CommunityRow = CommunityMembershipPage['items'][number];
export type CommunityChatMessage = CommunityReadExperienceChatPage['items'][number];

/** The projection has no last-message preview for a community chat, so the row states what it is. */
export const COMMUNITY_CHAT_PREVIEW = 'Чат сообщества';

/** Canonical UUIDs distinguish identical messages; old rows retain their timestamp compatibility. */
export function communityMessageKey(message: CommunityChatMessage): string {
  if (message.id) return message.id;
  return `${message.sentAt}|${message.author.displayName}|${message.body}`;
}

/** An unreadable instant sorts as the oldest message, the way the rest of the block treats it. */
function communityInstant(message: CommunityChatMessage): number {
  const parsed = Date.parse(message.sentAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function chronological(left: CommunityChatMessage, right: CommunityChatMessage): number {
  const time = communityInstant(left) - communityInstant(right);
  if (time !== 0 || !left.id || !right.id) return time;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * The chat reads chronologically: the newest message sits at the bottom and earlier pages are pulled
 * in above it. The projection exposes a send instant for every message, so the reading order comes
 * from that instant rather than from the direction the provider happened to use for the page — a page
 * that arrives oldest-first would otherwise be shown upside down. Equal instants use public UUID order; old rows without UUID retain compatibility.
 */
export function communityThreadPage(
  page: CommunityReadExperienceChatPage,
): readonly CommunityChatMessage[] {
  return [...page.items].sort(chronological);
}

/**
 * An "earlier" page is merged into the same chronological order instead of being trusted to arrive in
 * it, and a message the viewer already sees is never added twice.
 */
export function mergeCommunityThreadPage(
  current: readonly CommunityChatMessage[],
  page: CommunityReadExperienceChatPage,
): { readonly messages: readonly CommunityChatMessage[]; readonly added: number } {
  const known = new Set(current.map(communityMessageKey));
  const added = communityThreadPage(page).filter((message) => {
    const key = communityMessageKey(message);
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
  if (added.length === 0) return { messages: current, added: 0 };
  return {
    messages: [...current, ...added].sort(chronological),
    added: added.length,
  };
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
