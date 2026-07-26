import { describe, expect, it, vi } from 'vitest';

import { createMessagingRepository } from './messaging-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
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

  it('authorizes realtime only through enabled gates and current direct membership', async () => {
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
      if (text.includes('conversation.next_sequence - 1 as latest_sequence')) {
        expect(text).toContain("conversation.kind = 'DIRECT'");
        expect(text).toContain("member.state = 'ACTIVE'");
        return Promise.resolve({ rows: [{ latest_sequence: '7' }], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.authorizeRealtimeSubscription({
        tenantId,
        userId,
        conversationId,
      }),
    ).resolves.toEqual({ outcome: 'ok', latestSequence: 7 });
  });

  it('resolves realtime recipients from the canonical message and active members', async () => {
    const query = vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('join messaging.messages message')) {
        expect(text).toContain('message.id = $3');
        expect(text).toContain('message.sequence = $4');
        expect(text).toContain('settings.realtime_enabled = true');
        return Promise.resolve({
          rows: [{ user_id: userId }, { user_id: '44444444-4444-4444-8444-444444444444' }],
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
        sequence: 1,
      }),
    ).resolves.toEqual([userId, '44444444-4444-4444-8444-444444444444']);
  });

  it('audits realtime ticket issuance without storing the signed credential', async () => {
    const query = vi.fn((text: string, values?: readonly unknown[]) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes("'REALTIME_TICKET_ISSUED'")) {
        expect(values).toEqual([
          tenantId,
          userId,
          '55555555-5555-4555-8555-555555555555',
          'realtime-ticket-correlation-0001',
          JSON.stringify({ expiresAt: '2026-07-26T12:00:30.000Z' }),
        ]);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createMessagingRepository(poolWithQuery(query) as never);

    await expect(
      repository.recordRealtimeTicketIssued({
        tenantId,
        userId,
        ticketId: '55555555-5555-4555-8555-555555555555',
        expiresAt: '2026-07-26T12:00:30.000Z',
        correlationId: 'realtime-ticket-correlation-0001',
      }),
    ).resolves.toBeUndefined();
  });
});
