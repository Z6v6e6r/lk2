import { ApiClientError } from '@phub/api-sdk';
import type {
  ConversationMessage,
  ConversationMessagePage,
  ConversationPage,
  ConversationNotificationPolicyUpdate,
  ConversationNotificationPolicyResult,
  SendConversationMessageResult,
} from '../../../web/src/auth-gateway.js';
import { createMessagingCommandId } from '../../../web/src/auth-gateway.js';
import type { PendingChatMessage } from '../../../web/src/ChatsPage.js';
import { setChatsUnreadCount, totalUnreadConversations } from '../../../web/src/chats-unread.js';
import { resolveCabinetMedia } from '../cabinet-media.js';
import type { IOSSession } from './session.js';

export interface IOSChatState {
  readonly page: ConversationPage | null;
  readonly messages: readonly ConversationMessage[];
  readonly pending: PendingChatMessage | null;
  readonly busy: 'send' | 'refresh' | 'load-earlier' | null;
  readonly error: string | null;
  readonly forbidden: boolean;
  readonly loaded: boolean;
  readonly canRetry: boolean;
  readonly hasEarlier: boolean;
  readonly policyBusy: boolean;
}
const initial: IOSChatState = {
  page: null,
  messages: [],
  pending: null,
  busy: null,
  error: null,
  forbidden: false,
  loaded: false,
  canRetry: false,
  hasEarlier: false,
  policyBusy: false,
};
// The existing Web consumer uses this wire type too: generated discriminator aliases are not wire values.
export function readIOSConversations(session: IOSSession): Promise<ConversationPage> {
  return session.read((api) => api.request<ConversationPage>('/conversations?limit=100'));
}
const terminal = (error: unknown) =>
  error instanceof ApiClientError && [400, 401, 403, 404, 409, 422].includes(error.status);
function merge(current: readonly ConversationMessage[], incoming: readonly ConversationMessage[]) {
  const messages = new Map(current.map((message) => [message.sequence, message]));
  for (const message of incoming) messages.set(message.sequence, message);
  return [...messages.values()].sort((a, b) => a.sequence - b.sequence);
}

/** One mounted existing-conversation consumer. No durable offline queue or cross-account cache. */
export class IOSChatController {
  private state: IOSChatState = initial;
  private active = false;
  private readonly listeners = new Set<() => void>();
  private refreshInFlight: Promise<boolean> | undefined;
  private refreshAgain = false;
  private recoveryAfter: number | undefined;
  private pendingAfter = 0;
  private lastSequence = 0;
  private readThrough = 0;
  private earlierAfter = 0;
  private sending = false;
  public constructor(
    private readonly session: IOSSession,
    public readonly conversationId?: string,
    public readonly userId?: string,
  ) {}
  public snapshot = () => this.state;
  public subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  public start() {
    const state = this.session.getSnapshot();
    this.active =
      state.status === 'signed-in' &&
      (this.userId === undefined || state.session.user.id === this.userId);
  }
  public stop() {
    this.active = false;
  }
  public sequence = () => this.lastSequence;
  private update(patch: Partial<IOSChatState>) {
    if (!this.active) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private failure(error: unknown) {
    if (terminal(error)) {
      this.update({
        error: 'Этот чат недоступен для вашей учётной записи.',
        forbidden: true,
        loaded: false,
        messages: [],
        pending: null,
        canRetry: false,
      });
      if (this.active) setChatsUnreadCount(0);
    } else this.update({ error: 'Не удалось подтвердить данные. Проверьте связь и повторите.' });
  }
  private async page(afterSequence: number): Promise<ConversationMessagePage> {
    return this.session.read((api) =>
      api.listConversationMessages(this.conversationId!, { afterSequence, limit: 100 }),
    );
  }
  private async gap(afterSequence: number): Promise<readonly ConversationMessage[]> {
    const result: ConversationMessage[] = [];
    let cursor = afterSequence;
    for (let count = 0; count < 20; count++) {
      const page = await this.page(cursor);
      if (!this.active) throw new DOMException('Chat closed', 'AbortError');
      result.push(...page.messages);
      if (page.nextAfterSequence === undefined) return result;
      if (!Number.isSafeInteger(page.nextAfterSequence) || page.nextAfterSequence <= cursor)
        throw new Error('Invalid history cursor');
      cursor = page.nextAfterSequence;
    }
    // Never declare an ambiguous send absent after a truncated reconciliation.
    throw new Error('History recovery limit');
  }
  public refresh = (): Promise<boolean> => {
    if (!this.active) return Promise.resolve(false);
    if (this.refreshInFlight) {
      this.refreshAgain = true;
      return this.refreshInFlight;
    }
    const operation = this.load().finally(() => {
      if (this.refreshInFlight === operation) this.refreshInFlight = undefined;
      if (this.active && this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh();
      }
    });
    this.refreshInFlight = operation;
    return operation;
  };
  private async load(): Promise<boolean> {
    let recovering: number | undefined;
    try {
      const page = resolveCabinetMedia(
        await readIOSConversations(this.session),
        this.session.configuration.apiBaseUrl,
      );
      if (!this.active) return false;
      const summary = page.items.find((entry) => entry.id === this.conversationId);
      const first = !this.state.loaded;
      recovering = this.recoveryAfter;
      this.recoveryAfter = undefined;
      const after = this.state.pending
        ? this.pendingAfter
        : recovering !== undefined
          ? recovering
          : first
            ? Math.max(0, (summary?.lastMessage?.sequence ?? 0) - 100)
            : this.lastSequence;
      const messages = this.conversationId ? await this.gap(after) : [];
      if (!this.active) return false;
      const foundPending =
        this.state.pending &&
        messages.some((message) => message.clientMessageId === this.state.pending?.clientMessageId);
      if (first) this.earlierAfter = after;
      this.lastSequence = Math.max(
        this.lastSequence,
        ...messages.map((message) => message.sequence),
      );
      this.update({
        page,
        messages: merge(this.state.messages, messages),
        loaded: true,
        forbidden: false,
        error: null,
        hasEarlier: this.earlierAfter > 0,
        ...(foundPending
          ? { pending: null, canRetry: false }
          : { canRetry: this.state.pending?.state === 'failed' }),
      });
      setChatsUnreadCount(totalUnreadConversations(page));
      if (
        this.conversationId &&
        this.lastSequence > this.readThrough &&
        document.visibilityState === 'visible'
      ) {
        const through = this.lastSequence;
        try {
          await this.session.read((api) => api.markConversationRead(this.conversationId!, through));
          if (this.active) this.readThrough = Math.max(this.readThrough, through);
        } catch (error) {
          if (terminal(error)) {
            this.failure(error);
            return false;
          }
        }
      }
      return true;
    } catch (error) {
      if (recovering !== undefined)
        this.recoveryAfter = Math.min(this.recoveryAfter ?? recovering, recovering);
      this.failure(error);
      return false;
    }
  }
  public recover = (after: number) => {
    if (!this.active) return;
    if (Number.isSafeInteger(after) && after >= 0 && after < this.lastSequence) {
      this.recoveryAfter = Math.min(this.recoveryAfter ?? after, after);
      this.lastSequence = after;
      this.readThrough = Math.min(this.readThrough, after);
      if (after === 0) {
        this.earlierAfter = 0;
        this.update({ messages: [], hasEarlier: false });
      }
    }
    void this.refresh();
  };
  public send = async (body: string): Promise<void> => {
    if (
      !this.active ||
      !this.conversationId ||
      !this.state.loaded ||
      this.state.forbidden ||
      this.state.pending ||
      this.sending ||
      !body.trim() ||
      body.length > 8000
    )
      return;
    this.pendingAfter = this.lastSequence;
    this.update({
      pending: { clientMessageId: createMessagingCommandId(), body: body.trim(), state: 'sending' },
      canRetry: false,
    });
    await this.dispatch();
  };
  private async dispatch(): Promise<void> {
    const pending = this.state.pending;
    if (!this.active || !pending || !this.conversationId || this.sending) return;
    this.sending = true;
    this.update({
      busy: 'send',
      pending: { ...pending, state: 'sending' },
      canRetry: false,
      error: null,
    });
    try {
      const result = await this.session.read((api) =>
        api.request<SendConversationMessageResult>(
          `/conversations/${this.conversationId}/messages`,
          {
            method: 'POST',
            idempotencyKey: pending.clientMessageId,
            body: JSON.stringify({ clientMessageId: pending.clientMessageId, body: pending.body }),
          },
        ),
      );
      if (!this.active) return;
      this.update({
        messages: merge(this.state.messages, [result.message]),
        pending: null,
        canRetry: false,
      });
      // Do not jump the recovery cursor to our ACK: intervening peer messages still need HTTP.
    } catch (error) {
      if (terminal(error)) this.failure(error);
      else
        this.update({
          pending: { ...pending, state: 'failed' },
          error: 'Сервер не подтвердил отправку. Проверяем историю перед повтором.',
        });
    } finally {
      this.sending = false;
      this.update({ busy: null });
    }
    if (this.active) await this.refresh();
  }
  public retry = async (): Promise<void> => {
    if (!this.active || this.sending || this.state.pending?.state !== 'failed') return;
    this.update({ canRetry: false, busy: 'refresh' });
    // A refresh already in progress may predate the failed POST. Drain it, then perform a fresh read.
    if (this.refreshInFlight) await this.refreshInFlight;
    const recovered = await this.refresh();
    this.update({ busy: null });
    if (recovered && this.active && this.state.pending?.state === 'failed' && !this.state.forbidden)
      await this.dispatch();
  };
  public earlier = async (): Promise<void> => {
    if (!this.active || !this.conversationId || this.state.busy || this.earlierAfter <= 0) return;
    const after = Math.max(0, this.earlierAfter - 100);
    this.update({ busy: 'load-earlier' });
    try {
      const page = await this.page(after);
      if (!this.active) return;
      this.earlierAfter = after;
      this.update({ messages: merge(this.state.messages, page.messages), hasEarlier: after > 0 });
    } catch (error) {
      this.failure(error);
    } finally {
      this.update({ busy: null });
    }
  };
  public policy = async (update: ConversationNotificationPolicyUpdate): Promise<void> => {
    if (!this.active || !this.conversationId || this.state.policyBusy || this.state.forbidden)
      return;
    this.update({ policyBusy: true });
    try {
      const result = await this.session.read((api) =>
        api.request<ConversationNotificationPolicyResult>(
          `/conversations/${this.conversationId}/notification-policy`,
          {
            method: 'PUT',
            idempotencyKey: createMessagingCommandId(),
            body: JSON.stringify(update),
          },
        ),
      );
      if (this.active && this.state.page)
        this.update({
          page: {
            items: this.state.page.items.map((entry) =>
              entry.id === this.conversationId
                ? { ...entry, notificationPolicy: result.policy }
                : entry,
            ),
          },
        });
    } catch (error) {
      this.failure(error);
    } finally {
      this.update({ policyBusy: false });
    }
  };
}
