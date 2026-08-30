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
    this.dispatchEvent(new CloseEvent('close'));
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
  it('keeps the ticket out of the URL and recovers gaps through HTTP sequence', async () => {
    const socket = new FakeSocket();
    const createSocket = vi.fn().mockReturnValue(socket);
    const onRecoveryRequired = vi.fn();
    const client = connectChatRealtime({
      baseUrl: 'https://staging.padlhub.test',
      tenantKey: 'local-padel',
      conversationId: '11111111-1111-4111-8111-111111111111',
      getTicket: vi.fn().mockResolvedValue({
        ticket: 'secret-one-time-ticket',
        expiresAt: '2026-08-03T12:00:30.000Z',
      }),
      getAfterSequence: () => 2,
      onRecoveryRequired,
      createSocket,
    });
    await vi.waitFor(() => expect(createSocket).toHaveBeenCalledOnce());
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
    });
    expect(onRecoveryRequired).toHaveBeenCalledWith(2);
    client.stop();
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it('reports reconnecting and triggers immediate HTTP recovery when the socket drops', async () => {
    vi.useFakeTimers();
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const createSocket = vi.fn().mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket);
    const onConnectionStateChange = vi.fn();
    const onRecoveryRequired = vi.fn();
    const client = connectChatRealtime({
      baseUrl: 'https://staging.padlhub.test',
      tenantKey: 'local-padel',
      conversationId: '11111111-1111-4111-8111-111111111111',
      getTicket: vi.fn().mockResolvedValue({
        ticket: 'one-time-ticket',
        expiresAt: '2026-08-03T12:00:30.000Z',
      }),
      getAfterSequence: () => 7,
      onRecoveryRequired,
      onConnectionStateChange,
      createSocket,
    });
    await vi.advanceTimersByTimeAsync(0);
    firstSocket.open();
    firstSocket.message({ type: 'connection.ready' });
    expect(onConnectionStateChange).toHaveBeenLastCalledWith('connected');

    firstSocket.close();
    expect(onConnectionStateChange).toHaveBeenLastCalledWith('reconnecting');
    expect(onRecoveryRequired).toHaveBeenCalledWith(7);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(createSocket).toHaveBeenCalledTimes(2);

    client.stop();
    vi.useRealTimers();
  });
});
