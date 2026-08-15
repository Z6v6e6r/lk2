import { once } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

import { openRealtimeConnection } from './verify-direct-chat-realtime-e2e.js';

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      for (const client of server.clients) client.terminate();
      server.close();
      await once(server, 'close');
    }),
  );
});

async function rawRealtimeServer(
  onMessage: (socket: WebSocket, message: string) => void,
): Promise<string> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  await once(server, 'listening');
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const text = Array.isArray(raw)
        ? Buffer.concat(raw).toString('utf8')
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw).toString('utf8')
          : raw.toString('utf8');
      onMessage(socket, text);
    });
  });
  const address = server.address();
  if (typeof address === 'string' || address === null) {
    throw new Error('TEST_SERVER_ADDRESS_INVALID');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function realtimeServer(onSubscribed: (socket: WebSocket) => void): Promise<string> {
  return rawRealtimeServer((socket, text) => {
    const message = JSON.parse(text) as { type?: string };
    if (message.type === 'authenticate') {
      socket.send(JSON.stringify({ type: 'connection.ready' }));
    } else if (message.type === 'conversation.subscribe') {
      onSubscribed(socket);
    }
  });
}

const loopbackEnabled =
  process.env.CI === 'true' || process.env.DIRECT_REALTIME_LOOPBACK_TEST === 'true';

describe.runIf(loopbackEnabled)('local DIRECT realtime loopback transport', () => {
  it('fails closed when a loopback target sends an oversized message', async () => {
    const baseUrl = await realtimeServer((socket) => {
      socket.send(JSON.stringify({ type: 'noise', value: 'x'.repeat(20_000) }));
    });
    const connection = await openRealtimeConnection({
      baseUrl,
      tenantKey: 'local-padel',
      ticket: 'synthetic-ticket',
      conversationId: '11111111-1111-4111-8111-111111111111',
      afterSequence: 0,
    });

    await expect(connection.waitFor(() => false, 'UNREACHABLE_TIMEOUT')).rejects.toThrow(
      'DIRECT_REALTIME_VERIFY_SOCKET_MESSAGE_TOO_LARGE',
    );
    await connection.close();
  });

  it('fails closed when a loopback target floods the bounded message buffer', async () => {
    const baseUrl = await realtimeServer((socket) => {
      for (let index = 0; index <= 100; index += 1) {
        socket.send(JSON.stringify({ type: 'noise', index }));
      }
    });
    const connection = await openRealtimeConnection({
      baseUrl,
      tenantKey: 'local-padel',
      ticket: 'synthetic-ticket',
      conversationId: '11111111-1111-4111-8111-111111111111',
      afterSequence: 0,
    });

    await expect(connection.waitFor(() => false, 'UNREACHABLE_TIMEOUT')).rejects.toThrow(
      'DIRECT_REALTIME_VERIFY_SOCKET_BUFFER_LIMIT',
    );
    await connection.close();
  });

  it('terminates the loopback socket when authentication receives malformed JSON', async () => {
    let clientClosed = false;
    const baseUrl = await rawRealtimeServer((socket, text) => {
      const message = JSON.parse(text) as { type?: string };
      if (message.type === 'authenticate') {
        socket.once('close', () => {
          clientClosed = true;
        });
        socket.send('{');
      }
    });

    await expect(
      openRealtimeConnection({
        baseUrl,
        tenantKey: 'local-padel',
        ticket: 'synthetic-ticket',
        timeoutMs: 100,
      }),
    ).rejects.toThrow('DIRECT_REALTIME_VERIFY_SOCKET_MESSAGE_INVALID');
    await vi.waitFor(() => expect(clientClosed).toBe(true));
  });

  it('terminates the loopback socket when authentication readiness times out', async () => {
    let clientClosed = false;
    const baseUrl = await rawRealtimeServer((socket, text) => {
      const message = JSON.parse(text) as { type?: string };
      if (message.type === 'authenticate') {
        socket.once('close', () => {
          clientClosed = true;
        });
      }
    });

    await expect(
      openRealtimeConnection({
        baseUrl,
        tenantKey: 'local-padel',
        ticket: 'synthetic-ticket',
        timeoutMs: 50,
      }),
    ).rejects.toThrow('DIRECT_REALTIME_VERIFY_CONNECTION_READY_TIMEOUT');
    await vi.waitFor(() => expect(clientClosed).toBe(true));
  });
});
