import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';

import { verifyRealtimeTicketHandshake } from './verify-realtime-ticket-handshake.js';

class FakeSocket extends EventEmitter {
  readyState = 1;
  terminated = false;
  readonly sent: string[] = [];

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', 1000);
  }

  terminate(): void {
    this.readyState = 3;
    this.terminated = true;
  }
}

describe('authenticated realtime ticket handshake', () => {
  it('requests one user-scoped ticket and proves connection.ready without logging credentials', async () => {
    const socket = new FakeSocket();
    const fetchImpl = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer redacted-token');
      return Promise.resolve(
        new Response(
          JSON.stringify({ ticket: 'x'.repeat(64), expiresAt: '2026-08-16T12:00:30.000Z' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    });
    const pending = verifyRealtimeTicketHandshake({
      baseUrl: 'https://lk.nano.padlhub.su',
      tenantKey: 'nano',
      accessToken: 'redacted-token',
      fetchImpl,
      socketFactory: (url) => {
        expect(url.href).toBe('wss://lk.nano.padlhub.su/realtime/v1/nano');
        queueMicrotask(() => socket.emit('open'));
        queueMicrotask(() => socket.emit('message', Buffer.from('{"type":"connection.ready"}')));
        return socket as unknown as WebSocket;
      },
    });
    await expect(pending).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(socket.sent[0] ?? '{}')).toEqual({
      type: 'authenticate',
      ticket: 'x'.repeat(64),
    });
  });

  it('fails closed before opening a socket when the authenticated ticket route rejects', async () => {
    const socketFactory = vi.fn();
    await expect(
      verifyRealtimeTicketHandshake({
        baseUrl: 'https://lk.nano.padlhub.su',
        tenantKey: 'nano',
        accessToken: 'redacted-token',
        fetchImpl: vi.fn(() => Promise.resolve(new Response('{}', { status: 401 }))),
        socketFactory,
      }),
    ).rejects.toThrow('REALTIME_HANDSHAKE_TICKET_HTTP_401');
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it('terminates the socket immediately when realtime returns a malformed frame', async () => {
    const socket = new FakeSocket();
    const pending = verifyRealtimeTicketHandshake({
      baseUrl: 'https://lk.nano.padlhub.su',
      tenantKey: 'nano',
      accessToken: 'redacted-token',
      fetchImpl: vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ ticket: 'x'.repeat(64), expiresAt: '2026-08-16T12:00:30.000Z' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      ),
      socketFactory: () => {
        queueMicrotask(() => socket.emit('open'));
        queueMicrotask(() => socket.emit('message', Buffer.from('{')));
        return socket as unknown as WebSocket;
      },
    });
    await expect(pending).rejects.toThrow('REALTIME_HANDSHAKE_MESSAGE_INVALID');
    expect(socket.terminated).toBe(true);
  });
});
