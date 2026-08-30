const GAME_CHAT_NAVIGATION_KEY = 'phub.game-chat-navigation.v1';
const GAME_CHAT_NAVIGATION_TTL_MS = 10 * 60 * 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface GameChatNavigationScope {
  readonly tenantKey: string;
  readonly userId: string;
}

export interface GameChatNavigationHint {
  readonly conversationId: string;
  readonly contextId: string;
  readonly title: string;
  readonly lastSequence: number;
  readonly updatedAt: string;
}

interface StoredGameChatNavigation extends GameChatNavigationHint, GameChatNavigationScope {
  readonly expiresAt: number;
}

interface GameChatNavigationConversation {
  readonly id: string;
  readonly contextId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly lastMessage?: { readonly sequence: number };
}

function isStoredHint(value: unknown): value is StoredGameChatNavigation {
  if (typeof value !== 'object' || value === null) return false;
  const hint = value as Partial<StoredGameChatNavigation>;
  return (
    typeof hint.tenantKey === 'string' &&
    hint.tenantKey.length > 0 &&
    hint.tenantKey.length <= 100 &&
    typeof hint.userId === 'string' &&
    UUID_PATTERN.test(hint.userId) &&
    typeof hint.conversationId === 'string' &&
    UUID_PATTERN.test(hint.conversationId) &&
    typeof hint.contextId === 'string' &&
    UUID_PATTERN.test(hint.contextId) &&
    typeof hint.title === 'string' &&
    hint.title.length > 0 &&
    hint.title.length <= 300 &&
    Number.isSafeInteger(hint.lastSequence) &&
    (hint.lastSequence ?? -1) >= 0 &&
    typeof hint.updatedAt === 'string' &&
    Number.isFinite(Date.parse(hint.updatedAt)) &&
    Number.isFinite(hint.expiresAt)
  );
}

export function rememberGameChatNavigation(
  scope: GameChatNavigationScope,
  conversation: GameChatNavigationConversation,
): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(
      GAME_CHAT_NAVIGATION_KEY,
      JSON.stringify({
        ...scope,
        conversationId: conversation.id,
        contextId: conversation.contextId,
        title: conversation.title,
        lastSequence: conversation.lastMessage?.sequence ?? 0,
        updatedAt: conversation.updatedAt,
        expiresAt: Date.now() + GAME_CHAT_NAVIGATION_TTL_MS,
      } satisfies StoredGameChatNavigation),
    );
  } catch {
    // Navigation remains valid; only newest-page positioning may need the regular list fallback.
  }
}

export function clearGameChatNavigation(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(GAME_CHAT_NAVIGATION_KEY);
  } catch {
    // Logout remains valid when browser storage is unavailable.
  }
}

export function consumeGameChatNavigation(
  scope: GameChatNavigationScope,
  conversationId: string,
): GameChatNavigationHint | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.sessionStorage.getItem(GAME_CHAT_NAVIGATION_KEY);
    if (!raw) return undefined;
    window.sessionStorage.removeItem(GAME_CHAT_NAVIGATION_KEY);
    const stored = JSON.parse(raw) as unknown;
    if (
      !isStoredHint(stored) ||
      stored.expiresAt <= Date.now() ||
      stored.tenantKey !== scope.tenantKey ||
      stored.userId !== scope.userId ||
      stored.conversationId !== conversationId
    ) {
      return undefined;
    }
    return {
      conversationId: stored.conversationId,
      contextId: stored.contextId,
      title: stored.title,
      lastSequence: stored.lastSequence,
      updatedAt: stored.updatedAt,
    };
  } catch {
    return undefined;
  }
}
