import { describe, expect, it, vi } from 'vitest';

import { runDirectChatSmoke } from './verify-direct-chat-smoke.js';

const recipientUserId = '11111111-1111-4111-8111-111111111111';
const conversationId = '22222222-2222-4222-8222-222222222222';
const messageId = '33333333-3333-4333-8333-333333333333';
const message = 'PADLHUB_CHAT_SMOKE readiness-20260805';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('fail-closed direct chat smoke', () => {
  it('performs no request without the exact destructive confirmation', async () => {
    const fetchImpl = vi.fn();
    await expect(
      runDirectChatSmoke({
        confirm: 'NO',
        baseUrl: 'https://owner-confirmed.example.test',
        tenantKey: 'owner-tenant',
        recipientUserId,
        runId: 'readiness-20260805',
        message,
        playerAToken: 'player-a-secret',
        playerBToken: 'player-b-secret',
        fetchImpl,
      }),
    ).rejects.toThrow('DIRECT_CHAT_SMOKE_CONFIRMATION_REQUIRED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('proves create/send/read replay and B history without echoing credentials or body', async () => {
    let directCalls = 0;
    let sendCalls = 0;
    let readCalls = 0;
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toMatch(/^Bearer player-[ab]-secret$/);
      expect(headers.get('x-correlation-id')).toMatch(/^chat-smoke\.readiness-20260805\./);
      if (url.endsWith('/conversations/direct')) {
        directCalls += 1;
        expect(init?.method).toBe('POST');
        return Promise.resolve(
          json({
            outcome: 'ok',
            conversation: { id: conversationId },
            replayed: directCalls > 1,
          }),
        );
      }
      if (url.includes('/messages?')) {
        expect(init?.method).toBe('GET');
        return Promise.resolve(
          json({ messages: [{ id: messageId, conversationId, sequence: 7, body: message }] }),
        );
      }
      if (url.endsWith('/messages')) {
        sendCalls += 1;
        expect(init?.method).toBe('POST');
        return Promise.resolve(
          json({
            outcome: 'ok',
            message: { id: messageId, conversationId, sequence: 7, body: message },
            replayed: sendCalls > 1,
          }),
        );
      }
      if (url.endsWith('/read-cursor')) {
        readCalls += 1;
        expect(init?.method).toBe('PUT');
        return Promise.resolve(
          json({ outcome: 'ok', readThroughSequence: 7, replayed: readCalls > 1 }),
        );
      }
      return Promise.reject(new Error('unexpected request'));
    });

    const report = await runDirectChatSmoke({
      confirm: 'SEND_DIRECT_CHAT_SMOKE',
      baseUrl: 'https://owner-confirmed.example.test',
      tenantKey: 'owner-tenant',
      recipientUserId,
      runId: 'readiness-20260805',
      message,
      playerAToken: 'player-a-secret',
      playerBToken: 'player-b-secret',
      fetchImpl,
    });

    expect(report).toMatchObject({
      result: 'PASS',
      conversationId,
      messageId,
      sequence: 7,
      mutationRequests: 6,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(7);
    expect(JSON.stringify(report)).not.toContain('player-a-secret');
    expect(JSON.stringify(report)).not.toContain(message);
  });
});
