import type { ConversationMessage, ConversationPage } from '../../../../web/src/auth-gateway.js';
import type { IOSSessionPlugin } from '../session.js';
import { fixtureReply, nativeResult, viewerId } from './cabinet-fixtures.js';

export const directId = '11111111-1111-4111-8111-111111111111';
export const gameChatId = '22222222-2222-4222-8222-222222222222';
export const peer = {
  userId: '33333333-3333-4333-8333-333333333333',
  displayName: 'Борис Тестовый',
};
export function chatFixture() {
  const messages: ConversationMessage[] = [directId, gameChatId].map((conversationId) => ({
    id: `${conversationId}-message`,
    conversationId,
    sequence: 1,
    sender: peer,
    body: 'До встречи на корте!',
    messageType: 'TEXT',
    createdAt: '2026-10-31T09:00:00Z',
  }));
  const page: ConversationPage = {
    items: [
      {
        id: directId,
        kind: 'DIRECT',
        participant: peer,
        unreadCount: 2,
        updatedAt: '2026-10-31T09:00:00Z',
        notificationPolicy: { level: 'ALL', muted: false },
        lastMessage: {
          sequence: 1,
          body: 'До встречи на корте!',
          createdAt: '2026-10-31T09:00:00Z',
        },
      },
      {
        id: gameChatId,
        kind: 'GAME',
        contextId: '44444444-4444-4444-8444-444444444444',
        title: 'Тестовая игра',
        unreadCount: 3,
        updatedAt: '2026-10-31T09:00:00Z',
        notificationPolicy: { level: 'ALL', muted: false },
        lastMessage: {
          sequence: 1,
          body: 'До встречи на корте!',
          createdAt: '2026-10-31T09:00:00Z',
        },
      },
    ],
  };
  let ticket = 0;
  const read = new Set<string>();
  const reply = (input: Parameters<IOSSessionPlugin['request']>[0]) => {
    if (input.resource === 'conversations')
      return nativeResult({
        items: page.items.map((entry) =>
          read.has(entry.id) ? { ...entry, unreadCount: 0 } : entry,
        ),
      });
    if (input.resource === 'conversationMessages')
      return nativeResult({
        messages: messages.filter(
          (message) =>
            message.conversationId === input.resourceId &&
            message.sequence > Number(input.query?.afterSequence ?? 0),
        ),
      });
    if (input.resource === 'messageReadCursor') {
      read.add(input.resourceId!);
      return nativeResult({
        outcome: 'ok',
        readThroughSequence: (JSON.parse(input.body!) as { throughSequence: number })
          .throughSequence,
        changed: true,
        replayed: false,
      });
    }
    if (input.resource === 'realtimeTicket')
      return nativeResult({
        ticket: `synthetic-ticket-${++ticket}`,
        expiresAt: '2099-01-01T00:00:00Z',
      });
    if (input.resource === 'conversationPolicy') {
      const body = JSON.parse(input.body!) as { level: string; mutedUntil?: string };
      return nativeResult({
        outcome: 'ok',
        policy: { ...body, muted: body.level === 'NONE' },
        changed: true,
      });
    }
    if (input.resource === 'sendMessage') {
      const body = JSON.parse(input.body!) as { clientMessageId: string; body: string };
      const existing = messages.find((message) => message.clientMessageId === body.clientMessageId);
      if (existing) return nativeResult({ outcome: 'ok', message: existing, replayed: true });
      const message: ConversationMessage = {
        id: body.clientMessageId,
        clientMessageId: body.clientMessageId,
        conversationId: input.resourceId!,
        sequence:
          messages.filter((message) => message.conversationId === input.resourceId).length + 1,
        body: body.body,
        messageType: 'TEXT',
        sender: { userId: viewerId, displayName: 'Анна Тестовая' },
        createdAt: '2026-10-31T09:01:00Z',
      };
      messages.push(message);
      return nativeResult({ outcome: 'ok', message, replayed: false });
    }
    return fixtureReply(input);
  };
  return { messages, page, reply };
}
