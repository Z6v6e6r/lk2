import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { createMessagingRepository } from './messaging-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const otherUserId = '59d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const conversationId = '11111111-1111-4111-8111-111111111111';
const memberId = '22222222-2222-4222-8222-222222222222';
const messageId = '33333333-3333-4333-8333-333333333333';
const gameId = '44444444-4444-4444-8444-444444444444';

function poolWithQuery(query: ReturnType<typeof vi.fn>) {
  return {
    connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
  };
}

describe('messaging repository', () => {
  it('does not use PostgreSQL session keywords as relation aliases', async () => {
    const source = await readFile(new URL('./messaging-repository.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/\b(?:join|from)\s+[^\s]+\s+current_user\b/i);
  });

  it('keeps directed blocks tenant-local across direct reads, writes, subscriptions and fanout', async () => {
    const source = await readFile(new URL('./messaging-repository.ts', import.meta.url), 'utf8');

    expect(source).toContain('from messaging.user_blocks block');
    expect(source).toContain('messaging.user_block_commands');
    expect(source).toContain('messaging.user-block.changed.v1');
    expect(source).toContain("conversation.kind = 'GAME'");
    expect(source).toContain('getAuthorizedMember');
    expect(source).toContain('listRealtimeRecipientUserIds');
    expect(source).toContain('pg_advisory_xact_lock');
  });

  it('stores a directed block, command result, audit and outbox atomically', async () => {
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      void values;
      if (
        text === 'begin' ||
        text === 'commit' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from messaging.user_block_commands')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('select user_account.id')) {
        return Promise.resolve({ rows: [{ id: userId }], rowCount: 1 });
      }
      if (text.includes('select id from identity.users')) {
        return Promise.resolve({ rows: [{ id: otherUserId }], rowCount: 1 });
      }
      if (text.includes('insert into messaging.user_blocks')) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (
        text.includes('insert into messaging.user_block_commands') ||
        text.includes('insert into audit.outbox_events') ||
        text.includes('insert into audit.audit_log')
      ) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.setUserBlock({
        tenantId,
        actorUserId: userId,
        otherUserId,
        action: 'BLOCK',
        idempotencyKey: 'user-block-command-0001',
        correlationId: 'user-block-correlation-0001',
      }),
    ).resolves.toEqual({ outcome: 'ok', changed: true, replayed: false });

    expect(query.mock.calls.some(([text]) => String(text).includes('audit.outbox_events'))).toBe(
      true,
    );
    expect(query.mock.calls.some(([text]) => String(text).includes('audit.audit_log'))).toBe(true);
    expect(
      query.mock.calls
        .filter(([text]) => String(text).includes('pg_advisory_xact_lock'))
        .map(([, values]) => String(values?.[0])),
    ).toEqual([
      `${tenantId}:${userId}:user-block-command-0001`,
      `${tenantId}:${userId}:${otherUserId}`,
    ]);
  });

  it('replays a stored block command after rechecking the current actor permission', async () => {
    const query = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('select user_account.id')) {
        return Promise.resolve({ rows: [{ id: userId }], rowCount: 1 });
      }
      if (text.includes('from messaging.user_block_commands')) {
        return Promise.resolve({
          rows: [{ other_user_id: otherUserId, action: 'BLOCK', changed: true }],
          rowCount: 1,
        });
      }
      throw new Error(`Replay must not query or mutate current target state: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.setUserBlock({
        tenantId,
        actorUserId: userId,
        otherUserId,
        action: 'BLOCK',
        idempotencyKey: 'user-block-command-0001',
        correlationId: 'user-block-correlation-0002',
      }),
    ).resolves.toEqual({ outcome: 'ok', changed: true, replayed: true });
  });

  it('denies block mutation and replay when current actor authorization was revoked', async () => {
    const query = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('select user_account.id')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      throw new Error(`Revoked actor must not read replay state or mutate blocks: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.setUserBlock({
        tenantId,
        actorUserId: userId,
        otherUserId,
        action: 'BLOCK',
        idempotencyKey: 'user-block-command-0001',
        correlationId: 'user-block-correlation-revoked',
      }),
    ).resolves.toEqual({ outcome: 'forbidden' });

    expect(
      query.mock.calls.some(([text]) =>
        /user_block_commands|insert into messaging\.user_blocks|audit\.(?:audit_log|outbox_events)/.test(
          String(text),
        ),
      ),
    ).toBe(false);
  });

  it('keeps every runtime gate disabled without an explicit tenant row', async () => {
    const query = vi.fn((text: string, values?: readonly unknown[]) => {
      void values;
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from messaging.tenant_runtime_settings')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(repository.getRuntimeSettings(tenantId)).resolves.toEqual({
      httpEnabled: false,
      directEnabled: false,
      realtimeEnabled: false,
      contextualEnabled: false,
    });
  });

  it('creates one canonical GAME conversation from active PadlHub roster membership', async () => {
    const query = vi.fn((text: string, values?: readonly unknown[]) => {
      void values;
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from games.games game') && text.includes('runtime.contextual_enabled')) {
        return Promise.resolve({
          rows: [{ id: gameId, title: 'Игра в среду', role: 'PLAYER' }],
          rowCount: 1,
        });
      }
      if (text.includes('from messaging.game_conversation_commands')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (
        text.includes('from messaging.conversations') &&
        text.includes("kind = 'GAME'") &&
        !text.includes('join games.participations')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('insert into messaging.conversations')) {
        return Promise.resolve({ rows: [{ id: conversationId }], rowCount: 1 });
      }
      if (
        text.includes('insert into messaging.conversation_members') ||
        text.includes('insert into audit.outbox_events') ||
        text.includes('insert into audit.audit_log') ||
        text.includes('insert into messaging.game_conversation_commands')
      ) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('select conversation.id') && text.includes('join games.participations')) {
        return Promise.resolve({
          rows: [
            {
              id: conversationId,
              context_id: gameId,
              title: 'Игра в среду',
              unread_count: '0',
              updated_at: '2026-08-03 12:00:00.000000+00',
            },
          ],
          rowCount: 1,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.getOrCreateGameConversation({
        tenantId,
        actorUserId: userId,
        gameId,
        idempotencyKey: 'game-chat-command-0001',
        correlationId: 'game-chat-correlation-0001',
      }),
    ).resolves.toMatchObject({
      outcome: 'ok',
      conversation: { kind: 'GAME', contextId: gameId, title: 'Игра в среду' },
      created: true,
      replayed: false,
    });

    const authorization = String(
      query.mock.calls.find(([text]) => String(text).includes('from games.games game'))?.[0],
    );
    expect(authorization).toContain("participation.state = 'ACTIVE'");
    expect(authorization).toContain("'games.play' = any(current_access.permissions)");
    expect(authorization).toContain('runtime.contextual_enabled');
    expect(authorization).not.toMatch(/viva|external_id|provider_id/i);
    expect(
      query.mock.calls.some(([text]) => String(text).includes('select participation.tenant_id')),
    ).toBe(true);
  });

  it('fails GAME creation closed before writes when current roster membership is absent', async () => {
    const query = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from games.games game')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.getOrCreateGameConversation({
        tenantId,
        actorUserId: userId,
        gameId,
        idempotencyKey: 'game-chat-command-0001',
        correlationId: 'game-chat-correlation-0001',
      }),
    ).resolves.toEqual({ outcome: 'not_found' });
    expect(query.mock.calls.some(([text]) => String(text).includes('insert into messaging.'))).toBe(
      false,
    );
  });

  it('syncs a late active game participant without creating a second conversation', async () => {
    const query = vi.fn((text: string, values?: readonly unknown[]) => {
      void values;
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from games.games game') && text.includes('runtime.contextual_enabled')) {
        return Promise.resolve({
          rows: [{ id: gameId, title: 'Игра', role: 'PLAYER' }],
          rowCount: 1,
        });
      }
      if (text.includes('from messaging.game_conversation_commands')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (
        text.includes('from messaging.conversations') &&
        text.includes("kind = 'GAME'") &&
        !text.includes('join games.participations')
      ) {
        return Promise.resolve({ rows: [{ id: conversationId }], rowCount: 1 });
      }
      if (text.includes('insert into messaging.conversation_members')) {
        return Promise.resolve({ rows: [{ id: memberId }], rowCount: 1 });
      }
      if (
        text.includes('insert into audit.outbox_events') ||
        text.includes('insert into audit.audit_log') ||
        text.includes('insert into messaging.game_conversation_commands')
      ) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('select conversation.id') && text.includes('join games.participations')) {
        return Promise.resolve({
          rows: [
            {
              id: conversationId,
              context_id: gameId,
              title: 'Игра',
              unread_count: '0',
              updated_at: '2026-08-03 12:00:00.000000+00',
            },
          ],
          rowCount: 1,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.getOrCreateGameConversation({
        tenantId,
        actorUserId: userId,
        gameId,
        idempotencyKey: 'game-chat-command-0002',
        correlationId: 'game-chat-correlation-0002',
      }),
    ).resolves.toMatchObject({ outcome: 'ok', created: false, replayed: false });
    expect(
      query.mock.calls.filter(([text]) =>
        String(text).includes('insert into messaging.conversations'),
      ),
    ).toHaveLength(0);
    const outbox = query.mock.calls.find(([text]) =>
      String(text).includes('insert into audit.outbox_events'),
    );
    expect(String(outbox?.[0])).toContain('messaging.member.changed.v1');
    expect(JSON.stringify(outbox?.[1])).not.toMatch(/body|messageText/i);
  });

  it('lists GAME conversations only through current roster membership and contextual gate', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes("conversation.kind = 'DIRECT'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes("conversation.kind = 'GAME'")) {
        return Promise.resolve({
          rows: [
            {
              id: conversationId,
              context_id: gameId,
              title: 'Игра',
              unread_count: '2',
              updated_at: '2026-08-03 12:00:00.000000+00',
              last_sequence: '3',
              last_body: 'Готов',
              last_created_at: '2026-08-03 11:59:00.000000+00',
            },
          ],
          rowCount: 1,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(repository.listConversations({ tenantId, userId, limit: 20 })).resolves.toEqual([
      {
        id: conversationId,
        kind: 'GAME',
        contextId: gameId,
        title: 'Игра',
        unreadCount: 2,
        updatedAt: '2026-08-03T12:00:00.000000+00:00',
        lastMessage: {
          sequence: 3,
          body: 'Готов',
          createdAt: '2026-08-03T11:59:00.000000+00:00',
        },
      },
    ]);
    const gameQuery = String(
      query.mock.calls.find(([text]) => String(text).includes("conversation.kind = 'GAME'"))?.[0],
    );
    expect(gameQuery).toContain("participation.state = 'ACTIVE'");
    expect(gameQuery).toContain("'games.play' = any(current_access.permissions)");
    expect(gameQuery).toContain('runtime.contextual_enabled');
    const directQuery = String(
      query.mock.calls.find(([text]) => String(text).includes("conversation.kind = 'DIRECT'"))?.[0],
    );
    expect(directQuery).toContain('identity.user_access_profiles current_access');
    expect(directQuery).toContain("'chat.direct.create' = any(current_access.permissions)");
    expect(directQuery).toContain("other_user.status = 'ACTIVE'");
    expect(directQuery).toContain(
      "coalesce(target_privacy.chat_policy, 'AUTHORIZED') = 'AUTHORIZED'",
    );
  });

  it('issues a realtime authority result for a contextual-only games.play session', async () => {
    const query = vi.fn((text: string, values?: readonly unknown[]) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from messaging.tenant_runtime_settings')) {
        return Promise.resolve({
          rows: [
            {
              http_enabled: true,
              direct_enabled: false,
              realtime_enabled: true,
              contextual_enabled: true,
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('from identity.refresh_sessions presented')) {
        expect(values?.[3]).toEqual(['games.play']);
        expect(text).toContain('current_access.permissions && $4::text[]');
        return Promise.resolve({ rows: [{ authorized: true }], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.authorizeRealtimeConnection({
        tenantId,
        userId,
        sessionId: '55555555-5555-4555-8555-555555555555',
      }),
    ).resolves.toEqual({ outcome: 'ok' });
  });

  it('authorizes GAME realtime subscription through the same current roster rule as HTTP', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from messaging.tenant_runtime_settings')) {
        return Promise.resolve({
          rows: [
            {
              http_enabled: true,
              direct_enabled: false,
              realtime_enabled: true,
              contextual_enabled: true,
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('member.id as member_id')) {
        expect(text).toContain("conversation.kind = 'GAME'");
        expect(text).toContain("participation.state = 'ACTIVE'");
        expect(text).toContain("'games.play' = any(current_access.permissions)");
        return Promise.resolve({
          rows: [{ member_id: memberId, last_read_sequence: '3', last_sequence: '7' }],
          rowCount: 1,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.authorizeRealtimeSubscription({ tenantId, userId, conversationId }),
    ).resolves.toEqual({ outcome: 'ok', latestSequence: 7 });
  });

  it('denies GAME realtime subscription after the participant leaves or is removed', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from messaging.tenant_runtime_settings')) {
        return Promise.resolve({
          rows: [
            {
              http_enabled: true,
              direct_enabled: false,
              realtime_enabled: true,
              contextual_enabled: true,
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('member.id as member_id')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.authorizeRealtimeSubscription({ tenantId, userId, conversationId }),
    ).resolves.toEqual({ outcome: 'not_found' });
  });

  it('fans out GAME realtime hints only to current active roster members', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('select member.user_id')) {
        expect(text).toContain("conversation.kind in ('DIRECT', 'GAME')");
        expect(text).toContain('settings.contextual_enabled = true');
        expect(text).toContain("participation.state = 'ACTIVE'");
        expect(text).toContain("'games.play' = any(current_access.permissions)");
        expect(text).toContain("coalesce(target_privacy.chat_policy, 'AUTHORIZED') = 'AUTHORIZED'");
        return Promise.resolve({
          rows: [{ user_id: userId }, { user_id: otherUserId }],
          rowCount: 2,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.listRealtimeRecipientUserIds({
        tenantId,
        conversationId,
        messageId,
        sequence: 7,
      }),
    ).resolves.toEqual([userId, otherUserId]);
  });

  it('allocates one sequence and emits only identifiers to the outbox', async () => {
    const body = 'Секретный текст сообщения';
    const query = vi.fn((text: string, values?: readonly unknown[]) => {
      void values;
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('member.id as member_id') && !text.includes('for update of member')) {
        return Promise.resolve({
          rows: [{ member_id: memberId, last_read_sequence: '0', last_sequence: '0' }],
          rowCount: 1,
        });
      }
      if (text.includes('message.idempotency_key = $3')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('select next_sequence')) {
        return Promise.resolve({ rows: [{ next_sequence: '1' }], rowCount: 1 });
      }
      if (text.includes('insert into messaging.messages')) {
        return Promise.resolve({ rows: [{ id: messageId }], rowCount: 1 });
      }
      if (
        text.includes('update messaging.conversations') ||
        text.includes('update messaging.conversation_members') ||
        text.includes('insert into audit.outbox_events') ||
        text.includes('insert into audit.audit_log')
      ) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('message.id = $4')) {
        return Promise.resolve({
          rows: [
            {
              id: messageId,
              conversation_id: conversationId,
              sequence: '1',
              sender_user_id: userId,
              sender_display_name: 'Анна',
              message_type: 'TEXT',
              body,
              created_at: '2026-07-26 12:00:00.123456+00',
              client_message_id: 'client-message-0001',
              idempotency_key: 'message-command-0001',
            },
          ],
          rowCount: 1,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.sendMessage({
        tenantId,
        userId,
        conversationId,
        clientMessageId: 'client-message-0001',
        idempotencyKey: 'message-command-0001',
        body,
        correlationId: 'message-correlation-0001',
      }),
    ).resolves.toMatchObject({
      outcome: 'ok',
      message: { id: messageId, sequence: 1, body },
      replayed: false,
    });

    const outboxCall = query.mock.calls.find(([text]) =>
      String(text).includes('insert into audit.outbox_events'),
    );
    expect(outboxCall).toBeDefined();
    expect(JSON.stringify(outboxCall?.[1])).not.toContain(body);
    expect(JSON.stringify(outboxCall?.[1])).toContain(messageId);
    const auditCall = query.mock.calls.find(([text]) =>
      String(text).includes('insert into audit.audit_log'),
    );
    expect(auditCall).toBeDefined();
    expect(JSON.stringify(auditCall?.[1])).not.toContain(body);
  });

  it.each(['target privacy is NOBODY', 'target identity is inactive'])(
    'fails send closed when %s before allocating a sequence',
    async () => {
      const query = vi.fn((text: string) => {
        if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        if (text.includes('member.id as member_id')) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        if (text.includes('select next_sequence')) {
          return Promise.resolve({ rows: [{ next_sequence: '1' }], rowCount: 1 });
        }
        throw new Error(`Unexpected query: ${text}`);
      });
      const repository = createMessagingRepository(poolWithQuery(query) as never);

      await expect(
        repository.sendMessage({
          tenantId,
          userId,
          conversationId,
          clientMessageId: 'client-message-0001',
          idempotencyKey: 'message-command-0001',
          body: 'Секретный текст сообщения',
          correlationId: 'message-correlation-0001',
        }),
      ).resolves.toEqual({ outcome: 'not_found' });

      const authorizationQuery = String(
        query.mock.calls.find(([text]) => String(text).includes('member.id as member_id'))?.[0],
      );
      expect(authorizationQuery).toContain("viewer_user.status = 'ACTIVE'");
      expect(authorizationQuery).not.toMatch(/\bcurrent_user\b/i);
      expect(authorizationQuery).toContain("other_member.state = 'ACTIVE'");
      expect(authorizationQuery).toContain("other_user.status = 'ACTIVE'");
      expect(authorizationQuery).toContain(
        "coalesce(target_privacy.chat_policy, 'AUTHORIZED') = 'AUTHORIZED'",
      );
      expect(
        query.mock.calls.some(([text]) =>
          /message\.idempotency_key|insert into messaging\.messages|insert into audit\.outbox_events/.test(
            String(text),
          ),
        ),
      ).toBe(false);
    },
  );

  it('fails send closed when the current database permission is missing', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('member.id as member_id')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('select next_sequence')) {
        return Promise.resolve({ rows: [{ next_sequence: '1' }], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.sendMessage({
        tenantId,
        userId,
        conversationId,
        clientMessageId: 'client-message-0001',
        idempotencyKey: 'message-command-0001',
        body: 'Привет',
        correlationId: 'message-correlation-0001',
      }),
    ).resolves.toEqual({ outcome: 'not_found' });

    const authorizationQuery = String(
      query.mock.calls.find(([text]) => String(text).includes('member.id as member_id'))?.[0],
    );
    expect(authorizationQuery).toContain('identity.user_access_profiles current_access');
    expect(authorizationQuery).toContain("'chat.direct.create' = any(current_access.permissions)");
    expect(
      query.mock.calls.some(([text]) =>
        /message\.idempotency_key|insert into messaging\.messages|insert into audit\.outbox_events/.test(
          String(text),
        ),
      ),
    ).toBe(false);
  });

  it('denies an exact idempotent replay when current target policy has been revoked', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('member.id as member_id')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('select next_sequence')) {
        return Promise.resolve({ rows: [{ next_sequence: '1' }], rowCount: 1 });
      }
      if (text.includes('message.idempotency_key = $3')) {
        return Promise.resolve({
          rows: [
            {
              id: messageId,
              conversation_id: conversationId,
              sequence: '1',
              sender_user_id: userId,
              sender_display_name: 'Анна',
              message_type: 'TEXT',
              body: 'Привет',
              created_at: '2026-08-03 12:00:00.000000+00',
              client_message_id: 'client-message-0001',
              idempotency_key: 'message-command-0001',
            },
          ],
          rowCount: 1,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.sendMessage({
        tenantId,
        userId,
        conversationId,
        clientMessageId: 'client-message-0001',
        idempotencyKey: 'message-command-0001',
        body: 'Привет',
        correlationId: 'message-correlation-0001',
      }),
    ).resolves.toEqual({ outcome: 'not_found' });
    expect(
      query.mock.calls.some(([text]) => String(text).includes('message.idempotency_key = $3')),
    ).toBe(false);
  });

  it('hides a target whose current profile policy denies direct chat', async () => {
    const query = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from messaging.direct_conversation_commands')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('select true as blocked')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from identity.users user_account')) {
        return Promise.resolve({
          rows: [
            { id: userId, chat_policy: 'AUTHORIZED' },
            { id: otherUserId, chat_policy: 'NOBODY' },
          ],
          rowCount: 2,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.createDirectConversation({
        tenantId,
        actorUserId: userId,
        otherUserId,
        idempotencyKey: 'direct-command-0001',
        correlationId: 'direct-correlation-0001',
      }),
    ).resolves.toEqual({ outcome: 'target_not_found' });
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('insert into messaging.conversations'),
      ),
    ).toBe(false);
  });

  it.each([
    { actorUserId: userId, blockedUserId: otherUserId },
    { actorUserId: otherUserId, blockedUserId: userId },
  ])(
    'hides direct creation when either pair direction is blocked: $actorUserId',
    async ({ actorUserId, blockedUserId }) => {
      const query = vi.fn((text: string) => {
        if (
          text === 'begin' ||
          text === 'commit' ||
          text.includes("set_config('app.tenant_id'") ||
          text.includes('pg_advisory_xact_lock')
        ) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        if (text.includes('from identity.users user_account')) {
          return Promise.resolve({
            rows: [
              { id: actorUserId, chat_policy: 'AUTHORIZED' },
              { id: blockedUserId, chat_policy: 'AUTHORIZED' },
            ],
            rowCount: 2,
          });
        }
        if (text.includes('from messaging.user_blocks')) {
          return Promise.resolve({ rows: [{ blocked: true }], rowCount: 1 });
        }
        throw new Error(`Blocked direct pair must not reach command or mutation queries: ${text}`);
      });
      const repository = createMessagingRepository(poolWithQuery(query) as never);

      await expect(
        repository.createDirectConversation({
          tenantId,
          actorUserId,
          otherUserId: blockedUserId,
          idempotencyKey: 'direct-command-blocked-0001',
          correlationId: 'direct-correlation-blocked-0001',
        }),
      ).resolves.toEqual({ outcome: 'target_not_found' });

      expect(
        query.mock.calls.some(([text]) =>
          /direct_conversation_commands|insert into messaging\.(?:conversations|direct_conversations|conversation_members)|audit\.(?:audit_log|outbox_events)/.test(
            String(text),
          ),
        ),
      ).toBe(false);
    },
  );

  it('denies direct creation when the current database permission is missing', async () => {
    const query = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from identity.users user_account')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.createDirectConversation({
        tenantId,
        actorUserId: userId,
        otherUserId,
        idempotencyKey: 'direct-command-0001',
        correlationId: 'direct-correlation-0001',
      }),
    ).resolves.toEqual({ outcome: 'target_not_found' });

    const authorizationQuery = String(
      query.mock.calls.find(([text]) =>
        String(text).includes('from identity.users user_account'),
      )?.[0],
    );
    expect(authorizationQuery).toContain('identity.user_access_profiles current_access');
    expect(authorizationQuery).toContain("'chat.direct.create' = any(current_access.permissions)");
    expect(
      query.mock.calls.some(([text]) =>
        /from messaging\.direct_conversation_commands|insert into messaging\.(?:conversations|direct_conversation_commands)/.test(
          String(text),
        ),
      ),
    ).toBe(false);
  });

  it('reuses the canonical direct pair instead of creating a duplicate conversation', async () => {
    const query = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from messaging.direct_conversation_commands')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('select true as blocked')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from identity.users user_account')) {
        return Promise.resolve({
          rows: [
            { id: userId, chat_policy: 'AUTHORIZED' },
            { id: otherUserId, chat_policy: 'AUTHORIZED' },
          ],
          rowCount: 2,
        });
      }
      if (text.includes('from messaging.direct_conversations')) {
        return Promise.resolve({ rows: [{ conversation_id: conversationId }], rowCount: 1 });
      }
      if (text.includes('insert into messaging.direct_conversation_commands')) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('from messaging.conversations conversation')) {
        return Promise.resolve({
          rows: [
            {
              id: conversationId,
              kind: 'DIRECT',
              other_user_id: otherUserId,
              other_display_name: 'Борис',
              unread_count: '0',
              updated_at: '2026-08-03 12:00:00.000000+00',
              last_sequence: null,
              last_body: null,
              last_created_at: null,
            },
          ],
          rowCount: 1,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.createDirectConversation({
        tenantId,
        actorUserId: userId,
        otherUserId,
        idempotencyKey: 'direct-command-0001',
        correlationId: 'direct-correlation-0001',
      }),
    ).resolves.toMatchObject({ outcome: 'ok', created: false, replayed: false });
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('insert into messaging.conversations'),
      ),
    ).toBe(false);
  });

  it('treats a reused clientMessageId with another command key as a conflict', async () => {
    const body = 'Первый текст';
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('member.id as member_id')) {
        return Promise.resolve({
          rows: [{ member_id: memberId, last_read_sequence: '0', last_sequence: '1' }],
          rowCount: 1,
        });
      }
      if (text.includes('select next_sequence')) {
        return Promise.resolve({ rows: [{ next_sequence: '2' }], rowCount: 1 });
      }
      if (text.includes('message.client_message_id = $4')) {
        return Promise.resolve({
          rows: [
            {
              id: messageId,
              conversation_id: conversationId,
              sequence: '1',
              sender_user_id: userId,
              sender_display_name: 'Анна',
              message_type: 'TEXT',
              body,
              created_at: '2026-08-03 12:00:00.000000+00',
              client_message_id: 'client-message-0001',
              idempotency_key: 'message-command-0001',
            },
          ],
          rowCount: 1,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.sendMessage({
        tenantId,
        userId,
        conversationId,
        clientMessageId: 'client-message-0001',
        idempotencyKey: 'message-command-0002',
        body,
        correlationId: 'message-correlation-0002',
      }),
    ).resolves.toEqual({ outcome: 'idempotency_conflict' });
  });

  it('does not reveal a conversation to a non-member', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from messaging.conversation_members member')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.listMessages({
        tenantId,
        userId,
        conversationId,
        afterSequence: 0,
        limit: 50,
      }),
    ).resolves.toEqual({ outcome: 'not_found' });
  });

  it('denies blocked history, send and read before any durable mutation', async () => {
    const mutationPattern =
      /insert into messaging\.(?:messages|read_cursor_commands)|update messaging\.(?:conversations|conversation_members)|insert into audit\.(?:audit_log|outbox_events)/;
    const deniedMemberQuery = (text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('select next_sequence, kind')) {
        return Promise.resolve({ rows: [{ next_sequence: '5', kind: 'DIRECT' }], rowCount: 1 });
      }
      if (text.includes('select left_user_id, right_user_id')) {
        return Promise.resolve({
          rows: [{ left_user_id: userId, right_user_id: otherUserId }],
          rowCount: 1,
        });
      }
      if (text.includes('pg_advisory_xact_lock')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('member.id as member_id')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      throw new Error(`Denied member must not reach durable state: ${text}`);
    };

    for (const operation of ['history', 'send', 'read'] as const) {
      const query = vi.fn(deniedMemberQuery);
      const repository = createMessagingRepository(poolWithQuery(query) as never);
      const result =
        operation === 'history'
          ? await repository.listMessages({
              tenantId,
              userId,
              conversationId,
              afterSequence: 0,
              limit: 50,
            })
          : operation === 'send'
            ? await repository.sendMessage({
                tenantId,
                userId,
                conversationId,
                clientMessageId: 'blocked-client-message-0001',
                idempotencyKey: 'blocked-message-command-0001',
                body: 'Сообщение не должно записаться',
                correlationId: 'blocked-message-correlation-0001',
              })
            : await repository.markRead({
                tenantId,
                userId,
                conversationId,
                throughSequence: 4,
                idempotencyKey: 'blocked-read-command-0001',
                correlationId: 'blocked-read-correlation-0001',
              });

      expect(result).toEqual({ outcome: 'not_found' });
      expect(query.mock.calls.some(([text]) => mutationPattern.test(String(text)))).toBe(false);
      expect(query.mock.calls.some(([text]) => String(text).includes('read_cursor_commands'))).toBe(
        false,
      );
    }
  });

  it('authorizes realtime only while the tenant gate, permission and session family are active', async () => {
    const query = vi.fn((text: string, values?: readonly unknown[]) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from messaging.tenant_runtime_settings')) {
        return Promise.resolve({
          rows: [
            {
              http_enabled: true,
              direct_enabled: true,
              realtime_enabled: true,
              contextual_enabled: false,
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('from identity.refresh_sessions presented')) {
        expect(values?.[3]).toEqual(['chat.direct.create']);
        return Promise.resolve({ rows: [{ authorized: true }], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.authorizeRealtimeConnection({
        tenantId,
        userId,
        sessionId: '55555555-5555-4555-8555-555555555555',
      }),
    ).resolves.toEqual({ outcome: 'ok' });
    const authorizationSql = String(
      query.mock.calls.find(([text]) =>
        String(text).includes('from identity.refresh_sessions presented'),
      )?.[0],
    );
    expect(authorizationSql).toContain('current_access.permissions && $4::text[]');
    expect(authorizationSql).toContain('active_session.revoked_at is null');
    expect(authorizationSql).toContain('active_session.rotated_at is null');
    expect(authorizationSql).toContain('active_session.family_id = presented.family_id');
  });

  it('rechecks direct membership and current permission for every realtime subscription', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from messaging.tenant_runtime_settings')) {
        return Promise.resolve({
          rows: [
            {
              http_enabled: true,
              direct_enabled: true,
              realtime_enabled: true,
              contextual_enabled: false,
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('member.id as member_id')) {
        return Promise.resolve({
          rows: [{ member_id: memberId, last_read_sequence: '0', last_sequence: '7' }],
          rowCount: 1,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.authorizeRealtimeSubscription({ tenantId, userId, conversationId }),
    ).resolves.toEqual({ outcome: 'ok', latestSequence: 7 });
    const membershipSql = String(
      query.mock.calls.find(([text]) => String(text).includes('member.id as member_id'))?.[0],
    );
    expect(membershipSql).toContain("member.state = 'ACTIVE'");
    expect(membershipSql).toContain("conversation.kind = 'DIRECT'");
    expect(membershipSql).toContain("'chat.direct.create' = any(current_access.permissions)");
    expect(membershipSql).toContain("other_user.status = 'ACTIVE'");
    expect(membershipSql).toContain(
      "coalesce(target_privacy.chat_policy, 'AUTHORIZED') = 'AUTHORIZED'",
    );
  });

  it('denies a blocked realtime subscription and returns no fanout recipients', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('select member.user_id')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from messaging.tenant_runtime_settings')) {
        return Promise.resolve({
          rows: [
            {
              http_enabled: true,
              direct_enabled: true,
              realtime_enabled: true,
              contextual_enabled: false,
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('member.id as member_id')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.authorizeRealtimeSubscription({ tenantId, userId, conversationId }),
    ).resolves.toEqual({ outcome: 'not_found' });
    await expect(
      repository.listRealtimeRecipientUserIds({
        tenantId,
        conversationId,
        messageId,
        sequence: 4,
      }),
    ).resolves.toEqual([]);

    const subscriptionSql = String(
      query.mock.calls.find(([text]) => String(text).includes('member.id as member_id'))?.[0],
    );
    const fanoutSql = String(
      query.mock.calls.find(([text]) => String(text).includes('select member.user_id'))?.[0],
    );
    expect(subscriptionSql).toContain('messaging.user_blocks block');
    expect(fanoutSql).toContain('messaging.user_blocks block');
    expect(subscriptionSql).toContain('profile.privacy_settings target_privacy');
    expect(fanoutSql).toContain('profile.privacy_settings target_privacy');
    expect(fanoutSql).toContain("'chat.direct.create' = any(current_access.permissions)");
  });
});
