// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { consumeGameChatNavigation, rememberGameChatNavigation } from './game-chat-navigation.js';

const scope = {
  tenantKey: 'local-padel',
  userId: '00000000-0000-4000-8000-000000000001',
};
const conversation = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'GAME' as const,
  contextId: '11111111-1111-4111-8111-111111111111',
  title: 'Игра в среду',
  unreadCount: 0,
  updatedAt: '2026-08-26T09:00:00.000Z',
  lastMessage: {
    sequence: 2_501,
    body: 'Текст не должен попасть в navigation storage',
    createdAt: '2026-08-26T09:00:00.000Z',
  },
};

afterEach(() => {
  window.sessionStorage.clear();
  vi.useRealTimers();
});

describe('game chat navigation hint', () => {
  it('retains only scoped metadata and consumes it once', () => {
    rememberGameChatNavigation(scope, conversation);

    expect(window.sessionStorage.getItem('phub.game-chat-navigation.v1')).not.toContain(
      conversation.lastMessage.body,
    );
    expect(consumeGameChatNavigation(scope, conversation.id)).toEqual({
      conversationId: conversation.id,
      contextId: conversation.contextId,
      title: conversation.title,
      lastSequence: 2_501,
      updatedAt: conversation.updatedAt,
    });
    expect(consumeGameChatNavigation(scope, conversation.id)).toBeUndefined();
  });

  it('consumes and rejects an expired, mismatched-user or mismatched-conversation hint', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T09:00:00.000Z'));
    rememberGameChatNavigation(scope, conversation);
    expect(
      consumeGameChatNavigation(
        { ...scope, userId: '00000000-0000-4000-8000-000000000002' },
        conversation.id,
      ),
    ).toBeUndefined();
    expect(consumeGameChatNavigation(scope, conversation.id)).toBeUndefined();

    rememberGameChatNavigation(scope, conversation);
    expect(
      consumeGameChatNavigation(scope, '33333333-3333-4333-8333-333333333333'),
    ).toBeUndefined();

    rememberGameChatNavigation(scope, conversation);
    vi.advanceTimersByTime(10 * 60 * 1_000 + 1);
    expect(consumeGameChatNavigation(scope, conversation.id)).toBeUndefined();
  });
});
