import { describe, expect, it, vi } from 'vitest';

import { createMessagingRepository } from './messaging-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const otherUserId = '59d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const conversationId = '11111111-1111-4111-8111-111111111111';
const memberId = '22222222-2222-4222-8222-222222222222';
const messageId = '33333333-3333-4333-8333-333333333333';

function poolWithQuery(query: ReturnType<typeof vi.fn>) {
  return {
    connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
  };
}

describe('messaging repository', () => {
  it('keeps every runtime gate disabled without an explicit tenant row', async () => {
    const query = vi.fn((text: string) => {
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
      expect(authorizationQuery).toContain("current_user.status = 'ACTIVE'");
      expect(authorizationQuery).toContain("other_member.state = 'ACTIVE'");
      expect(authorizationQuery).toContain("other_user.status = 'ACTIVE'");
      expect(authorizationQuery).toContain(
        "coalesce(target_privacy.chat_policy, 'AUTHORIZED') = 'AUTHORIZED'",
      );
      expect(
        query.mock.calls.some(([text]) =>
          /select next_sequence|message\.idempotency_key|insert into messaging\.messages|insert into audit\.outbox_events/.test(
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
        /select next_sequence|message\.idempotency_key|insert into messaging\.messages|insert into audit\.outbox_events/.test(
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
});
