// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { connectChatRealtime } from './chat-realtime-client.js';

class FakeSocket extends EventTarget {
  public readonly sent: string[] = [];
  public readyState: number = WebSocket.CONNECTING;

  public send(value: string): void {
    this.sent.push(value);
  }

  public close(): void {
    this.readyState = WebSocket.CLOSED;
  }

  public open(): void {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  public message(payload: Record<string, unknown>): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }));
  }
}

describe('chat realtime client', () => {
  it('keeps the ticket out of the URL and requests HTTP recovery from the local sequence', async () => {
    const socket = new FakeSocket();
    const createSocket = vi.fn().mockReturnValue(socket);
    const onRecoveryRequired = vi.fn();
    const client = connectChatRealtime({
      baseUrl: 'https://staging.padlhub.test',
      tenantKey: 'local-padel',
      conversationId: '11111111-1111-4111-8111-111111111111',
      getTicket: vi.fn().mockResolvedValue({
        ticket: 'secret-one-time-ticket',
        expiresAt: '2026-07-26T12:00:30.000Z',
      }),
      getAfterSequence: () => 2,
      onRecoveryRequired,
      createSocket,
    });
    await vi.waitFor(() => expect(createSocket).toHaveBeenCalledTimes(1));

    expect(createSocket).toHaveBeenCalledWith('wss://staging.padlhub.test/realtime/v1/local-padel');
    expect(String(createSocket.mock.calls[0]?.[0])).not.toContain('secret-one-time-ticket');

    socket.open();
    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      type: 'authenticate',
      ticket: 'secret-one-time-ticket',
    });
    socket.message({ type: 'connection.ready' });
    expect(JSON.parse(socket.sent[1] as string)).toEqual({
      type: 'conversation.subscribe',
      conversationId: '11111111-1111-4111-8111-111111111111',
      afterSequence: 2,
    });

    socket.message({
      type: 'conversation.gap',
      conversationId: '11111111-1111-4111-8111-111111111111',
      afterSequence: 2,
      latestSequence: 4,
      recovery: 'HTTP',
    });
    expect(onRecoveryRequired).toHaveBeenCalledWith(2);

    client.stop();
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });
});
