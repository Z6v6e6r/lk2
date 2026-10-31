import { ApiClientError } from '@phub/api-sdk';
import type { PlayerProfileView } from '@phub/api-sdk';
import { createMessagingCommandId } from '../../../web/src/auth-gateway.js';
import type { CreateDirectConversationResult } from '../../../web/src/auth-gateway.js';
import { readIOSConversations } from './chat-data.js';
import type { IOSSession } from './session.js';

export const playerIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function denied(): never {
  throw new ApiClientError('Profile unavailable', 403, 'NATIVE_PROFILE_UNAVAILABLE', 'native');
}
export function directRecipient(route: string): string | null {
  if (/[\r\n]/.test(route)) return null;
  const match = /^\/chats\/new\?recipientUserId=([^&]+)&open=1$/.exec(route);
  return match && playerIdPattern.test(match[1]!) ? match[1]! : null;
}

/** Existing authorized profile projection only; private fields and protected images never render. */
export async function readOtherProfile(
  session: IOSSession,
  viewerId: string,
  userId: string,
): Promise<PlayerProfileView> {
  const auth = session.getSnapshot();
  if (
    userId.length !== 36 ||
    !playerIdPattern.test(userId) ||
    userId === viewerId ||
    auth.status !== 'signed-in' ||
    auth.session.user.id !== viewerId ||
    !auth.session.context.permissions.includes('profile.read')
  )
    denied();
  const view = await session.read((api) => api.getPlayerProfile(userId));
  if (
    view.profile.userId !== userId ||
    view.access.audience !== 'OTHER' ||
    view.access.tier === 'SELF' ||
    'privateAccount' in view ||
    view.access.visibleSections.includes('PRIVATE_ACCOUNT')
  )
    denied();
  if (
    view.access.chat.status === 'AVAILABLE' &&
    directRecipient(view.access.chat.route ?? '') !== userId
  )
    denied();
  // Avatar transport is a separate capability. Keep the shared initials placeholder here.
  return { ...view, profile: { ...view.profile, avatarUrl: null } };
}

interface DirectState {
  readonly busy: boolean;
  readonly error: string | null;
  readonly canRetry: boolean;
  readonly conversationId: string | null;
}
const initial: DirectState = { busy: false, error: null, canRetry: false, conversationId: null };
/** Cabinet-owned commands survive route retries, but never survive the authenticated cabinet. */
export class IOSDirectController {
  private state = initial;
  private readonly listeners = new Set<() => void>();
  private readonly commands = new Map<string, { key: string; uncertain: boolean }>();
  private generation = 0;
  private recipient: string | null = null;
  private inFlight: Promise<void> | undefined;
  public constructor(
    private readonly session: IOSSession,
    private readonly viewerId: string,
  ) {}
  public snapshot = () => this.state;
  public subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(state: DirectState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  public activate(recipient: string | null) {
    const generation = ++this.generation;
    this.recipient = recipient;
    this.update(initial);
    // Serialize remounts behind an unresolved command instead of issuing a second POST.
    void (this.inFlight ?? Promise.resolve()).then(() => {
      if (this.generation === generation) void this.attempt();
    });
  }
  public stop() {
    this.generation++;
    this.recipient = null;
    this.update(initial);
  }
  public attempt = (): Promise<void> => {
    if (this.inFlight) return this.inFlight;
    const run = this.run();
    this.inFlight = run;
    return run.finally(() => {
      if (this.inFlight === run) this.inFlight = undefined;
    });
  };
  private async run(): Promise<void> {
    const generation = this.generation;
    const recipient = this.recipient;
    const auth = this.session.getSnapshot();
    const current = () => generation === this.generation && this.session.getSnapshot() === auth;
    this.update({ ...initial, busy: true });
    try {
      if (
        !recipient ||
        auth.status !== 'signed-in' ||
        auth.session.user.id !== this.viewerId ||
        !auth.session.context.permissions.includes('chat.direct.create')
      )
        denied();
      const profile = await readOtherProfile(this.session, this.viewerId, recipient);
      if (!current()) return;
      if (!profile.reachable || profile.access.chat.status !== 'AVAILABLE') denied();
      let command = this.commands.get(recipient);
      if (!command) {
        command = { key: createMessagingCommandId(), uncertain: false };
        this.commands.set(recipient, command);
      }
      if (command.uncertain) {
        const page = await readIOSConversations(this.session);
        if (!current()) return;
        const existing = page.items.find(
          (item) => item.kind === 'DIRECT' && item.participant.userId === recipient,
        );
        if (existing && existing.id.length === 36 && playerIdPattern.test(existing.id)) {
          this.update({ ...initial, conversationId: existing.id });
          return;
        }
        // The bounded list is not absence proof. The same-key POST replays the canonical pair.
      }
      command.uncertain = true;
      const result = await this.session.read((api) =>
        api.request<CreateDirectConversationResult>('/conversations/direct', {
          method: 'POST',
          idempotencyKey: command.key,
          body: JSON.stringify({ otherUserId: recipient }),
        }),
      );
      if (!current()) return;
      if (
        result.conversation.kind !== 'DIRECT' ||
        result.conversation.participant.userId !== recipient ||
        result.conversation.id.length !== 36 ||
        !playerIdPattern.test(result.conversation.id)
      )
        denied();
      this.update({ ...initial, conversationId: result.conversation.id });
    } catch (error) {
      if (!current()) return;
      const terminal =
        error instanceof ApiClientError && [400, 401, 403, 404, 409, 422].includes(error.status);
      this.update({
        ...initial,
        canRetry: !terminal,
        error: terminal
          ? 'Личный чат с этим игроком сейчас недоступен.'
          : 'Не удалось подтвердить открытие диалога. Проверьте связь и повторите.',
      });
    }
  }
}
