import { EventEmitter } from 'node:events';

import { runtimeContourTargetFingerprint } from '@phub/config';
import { SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import {
  openRealtimeConnection,
  runDirectChatRealtimeVerify,
  type RealtimeSocket,
  type RealtimeSocketFactory,
} from './verify-direct-chat-realtime-e2e.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';

async function token(subject: string): Promise<string> {
  return new SignJWT({ tenants: [tenantId] })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(subject)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode('test-access-secret-at-least-32-characters'));
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function readyResponse(urlValue: string, overrides: Record<string, string> = {}): Response {
  const url = new URL(urlValue);
  const database = runtimeContourTargetFingerprint(
    'postgresql://verify:verify@127.0.0.1:5432/padlhub_chat_verify',
  );
  const redis = runtimeContourTargetFingerprint('redis://127.0.0.1:6379/15');
  const rabbitmq = runtimeContourTargetFingerprint(
    'amqp://verify:verify@127.0.0.1:5672/padlhub_chat_verify',
  );
  const runtimeContour =
    url.port === '3000'
      ? { database, redis }
      : url.port === '3001'
        ? { database, redis, rabbitmq }
        : { database, rabbitmq };
  return Response.json({ status: 'ready', runtimeContour: { ...runtimeContour, ...overrides } });
}

function validOptions(playerAToken: string, playerBToken: string) {
  return {
    confirm: 'RUN_LOCAL_DIRECT_REALTIME_VERIFY',
    appEnv: 'ci',
    apiBaseUrl: 'http://127.0.0.1:3000',
    realtimeBaseUrl: 'http://127.0.0.1:3001',
    workerBaseUrl: 'http://127.0.0.1:3002',
    databaseUrl: 'postgresql://verify:verify@127.0.0.1:5432/padlhub_chat_verify',
    rabbitmqUrl: 'amqp://verify:verify@127.0.0.1:5672/padlhub_chat_verify',
    redisUrl: 'redis://127.0.0.1:6379/15',
    tenantKey: 'local-padel',
    recipientUserId: '11111111-1111-4111-8111-111111111111',
    runId: 'realtime-20260814',
    playerAToken,
    playerBToken,
    fetchImpl: vi.fn(),
    databaseProbe: {
      latestSequence: vi.fn(),
      waitForPublishedOutbox: vi.fn(),
      close: vi.fn(),
    },
    runtimeContourProbe: {
      verifyTicketStored: vi.fn(),
      verifyTicketConsumed: vi.fn(),
      waitForRabbitEvent: vi.fn(),
      close: vi.fn(),
    },
    authenticateRealtime: vi.fn(),
    openRealtime: vi.fn(),
  } as const;
}

class FakeRealtimeSocket extends EventEmitter implements RealtimeSocket {
  readyState = 0;
  readonly closeCodes: number[] = [];
  terminated = false;
  private closeEmitted = false;

  constructor(
    private readonly onClientMessage: (socket: FakeRealtimeSocket, message: string) => void,
  ) {
    super();
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.emit('open');
    });
  }

  send(data: string): void {
    this.onClientMessage(this, data);
  }

  serverSend(data: string): void {
    this.emit('message', Buffer.from(data));
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 2;
    this.closeCodes.push(code);
    setTimeout(() => this.finishClose(code), 0);
  }

  terminate(): void {
    this.terminated = true;
    this.finishClose(1006);
  }

  private finishClose(code: number): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.readyState = 3;
    this.emit('close', code);
  }
}

function fakeRealtimeTransport(
  onClientMessage: (socket: FakeRealtimeSocket, message: string) => void,
): {
  readonly factory: RealtimeSocketFactory;
  readonly sockets: FakeRealtimeSocket[];
} {
  const sockets: FakeRealtimeSocket[] = [];
  return {
    sockets,
    factory: vi.fn((url: URL, options: { readonly maxPayload: number }): RealtimeSocket => {
      expect(url.href).toBe('ws://127.0.0.1:3001/realtime/v1/local-padel');
      expect(options).toEqual({ maxPayload: 65_536 });
      const socket = new FakeRealtimeSocket(onClientMessage);
      sockets.push(socket);
      return socket;
    }),
  };
}

function authenticatedTransport(
  onSubscribed: (socket: FakeRealtimeSocket) => void,
): ReturnType<typeof fakeRealtimeTransport> {
  return fakeRealtimeTransport((socket, text) => {
    const message = JSON.parse(text) as { type?: string };
    if (message.type === 'authenticate') {
      socket.serverSend(JSON.stringify({ type: 'connection.ready' }));
    } else if (message.type === 'conversation.subscribe') {
      onSubscribed(socket);
    }
  });
}

describe('local DIRECT realtime end-to-end verifier', () => {
  it('performs no request without the exact confirmation', async () => {
    const playerAToken = await token('00000000-0000-4000-8000-000000000001');
    const options = validOptions(playerAToken, await token('00000000-0000-4000-8000-000000000002'));

    await expect(runDirectChatRealtimeVerify({ ...options, confirm: 'NO' })).rejects.toThrow(
      'DIRECT_REALTIME_VERIFY_CONFIRMATION_REQUIRED',
    );
    expect(options.fetchImpl).not.toHaveBeenCalled();
    expect(options.openRealtime).not.toHaveBeenCalled();
    expect(options.authenticateRealtime).not.toHaveBeenCalled();
    expect(options.runtimeContourProbe.verifyTicketStored).not.toHaveBeenCalled();
    expect(options.databaseProbe.latestSequence).not.toHaveBeenCalled();
  });

  it('rejects remote or non-verify targets before opening a socket or database probe', async () => {
    const options = validOptions(
      await token('00000000-0000-4000-8000-000000000001'),
      await token('00000000-0000-4000-8000-000000000002'),
    );

    await expect(
      runDirectChatRealtimeVerify({
        ...options,
        apiBaseUrl: 'https://staging.example.test',
      }),
    ).rejects.toThrow('DIRECT_REALTIME_VERIFY_API_BASE_URL_INVALID');
    await expect(
      runDirectChatRealtimeVerify({
        ...options,
        databaseUrl: 'postgresql://verify:verify@127.0.0.1:5432/padlhub',
      }),
    ).rejects.toThrow('DIRECT_REALTIME_VERIFY_DATABASE_TARGET_NOT_ISOLATED');
    for (const search of [
      '?host=remote.example&port=6543',
      '?port=6543',
      '?sslkey=%2Ftmp%2Fclient.key',
    ]) {
      await expect(
        runDirectChatRealtimeVerify({
          ...options,
          databaseUrl: `${options.databaseUrl}${search}`,
        }),
      ).rejects.toThrow('DIRECT_REALTIME_VERIFY_DATABASE_TARGET_NOT_ISOLATED');
    }
    await expect(
      runDirectChatRealtimeVerify({
        ...options,
        rabbitmqUrl: 'amqp://verify:verify@127.0.0.1:5672/shared',
      }),
    ).rejects.toThrow('DIRECT_REALTIME_VERIFY_RABBITMQ_TARGET_NOT_ISOLATED');
    await expect(
      runDirectChatRealtimeVerify({
        ...options,
        redisUrl: 'redis://127.0.0.1:6379/0',
      }),
    ).rejects.toThrow('DIRECT_REALTIME_VERIFY_REDIS_TARGET_NOT_ISOLATED');
    expect(options.fetchImpl).not.toHaveBeenCalled();
    expect(options.openRealtime).not.toHaveBeenCalled();
    expect(options.authenticateRealtime).not.toHaveBeenCalled();
    expect(options.runtimeContourProbe.verifyTicketStored).not.toHaveBeenCalled();
    expect(options.databaseProbe.latestSequence).not.toHaveBeenCalled();
  });

  it('rejects a contour mismatch before creating a conversation or message', async () => {
    const options = validOptions(
      await token('00000000-0000-4000-8000-000000000001'),
      await token('00000000-0000-4000-8000-000000000002'),
    );
    const fetchImpl = vi.fn((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.endsWith('/health/ready')) return Promise.resolve(readyResponse(url));
      if (url.includes('/messaging/realtime-ticket')) {
        return Promise.resolve(
          Response.json({ ticket: 'synthetic-ticket-value-longer-than-thirty-two-characters' }),
        );
      }
      throw new Error(`UNEXPECTED_REQUEST_${url}`);
    });
    const verifyTicketStored = vi
      .fn()
      .mockRejectedValue(new Error('DIRECT_REALTIME_VERIFY_REDIS_TICKET_NOT_STORED'));

    await expect(
      runDirectChatRealtimeVerify({
        ...options,
        fetchImpl,
        runtimeContourProbe: { ...options.runtimeContourProbe, verifyTicketStored },
      }),
    ).rejects.toThrow('DIRECT_REALTIME_VERIFY_REDIS_TICKET_NOT_STORED');

    expect(verifyTicketStored).toHaveBeenCalledOnce();
    expect(options.authenticateRealtime).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.map(([input]) => requestUrl(input)).join('\n')).not.toContain(
      '/conversations/direct',
    );
    expect(options.databaseProbe.latestSequence).not.toHaveBeenCalled();
  });

  it.each([
    ['API', ':3000/', 'redis'],
    ['REALTIME', ':3001/', 'rabbitmq'],
    ['WORKER', ':3002/', 'database'],
  ] as const)(
    'rejects a %s target attestation mismatch before topology or ticket mutations',
    async (component, componentUrl, mismatchedTarget) => {
      const options = validOptions(
        await token('00000000-0000-4000-8000-000000000001'),
        await token('00000000-0000-4000-8000-000000000002'),
      );
      const { runtimeContourProbe, ...optionsWithoutProbe } = options;
      const fetchImpl = vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);
        if (!url.endsWith('/health/ready')) throw new Error(`UNEXPECTED_REQUEST_${url}`);
        return Promise.resolve(
          url.includes(componentUrl)
            ? readyResponse(url, { [mismatchedTarget]: 'wrong-target' })
            : readyResponse(url),
        );
      });
      const runtimeContourProbeFactory = vi.fn(() => Promise.resolve(runtimeContourProbe));

      await expect(
        runDirectChatRealtimeVerify({
          ...optionsWithoutProbe,
          fetchImpl,
          runtimeContourProbeFactory,
        }),
      ).rejects.toThrow(`DIRECT_REALTIME_VERIFY_${component}_CONTOUR_ATTESTATION_INVALID`);

      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(runtimeContourProbeFactory).not.toHaveBeenCalled();
      expect(runtimeContourProbe.verifyTicketStored).not.toHaveBeenCalled();
      expect(runtimeContourProbe.waitForRabbitEvent).not.toHaveBeenCalled();
      expect(options.authenticateRealtime).not.toHaveBeenCalled();
      expect(options.databaseProbe.latestSequence).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the realtime target sends an oversized message', async () => {
    const transport = authenticatedTransport((socket) => {
      socket.serverSend(JSON.stringify({ type: 'noise', value: 'x'.repeat(20_000) }));
    });
    const connection = await openRealtimeConnection({
      baseUrl: 'http://127.0.0.1:3001',
      tenantKey: 'local-padel',
      ticket: 'synthetic-ticket',
      conversationId: '11111111-1111-4111-8111-111111111111',
      afterSequence: 0,
      socketFactory: transport.factory,
    });

    await expect(connection.waitFor(() => false, 'UNREACHABLE_TIMEOUT')).rejects.toThrow(
      'DIRECT_REALTIME_VERIFY_SOCKET_MESSAGE_TOO_LARGE',
    );
    await connection.close();
    expect(transport.sockets[0]?.closeCodes).toContain(1009);
  });

  it('fails closed when the realtime target floods the bounded message buffer', async () => {
    const transport = authenticatedTransport((socket) => {
      for (let index = 0; index <= 100; index += 1) {
        socket.serverSend(JSON.stringify({ type: 'noise', index }));
      }
    });
    const connection = await openRealtimeConnection({
      baseUrl: 'http://127.0.0.1:3001',
      tenantKey: 'local-padel',
      ticket: 'synthetic-ticket',
      conversationId: '11111111-1111-4111-8111-111111111111',
      afterSequence: 0,
      socketFactory: transport.factory,
    });

    await expect(connection.waitFor(() => false, 'UNREACHABLE_TIMEOUT')).rejects.toThrow(
      'DIRECT_REALTIME_VERIFY_SOCKET_BUFFER_LIMIT',
    );
    await connection.close();
    expect(transport.sockets[0]?.closeCodes).toContain(1009);
  });

  it('terminates the socket when authentication receives malformed JSON', async () => {
    const transport = fakeRealtimeTransport((socket, text) => {
      const message = JSON.parse(text) as { type?: string };
      if (message.type === 'authenticate') {
        socket.serverSend('{');
      }
    });

    await expect(
      openRealtimeConnection({
        baseUrl: 'http://127.0.0.1:3001',
        tenantKey: 'local-padel',
        ticket: 'synthetic-ticket',
        timeoutMs: 100,
        socketFactory: transport.factory,
      }),
    ).rejects.toThrow('DIRECT_REALTIME_VERIFY_SOCKET_MESSAGE_INVALID');
    expect(transport.sockets[0]?.closeCodes).toContain(1007);
    expect(transport.sockets[0]?.terminated).toBe(true);
  });

  it('terminates the socket when authentication readiness times out', async () => {
    const transport = fakeRealtimeTransport((_socket, text) => {
      const message = JSON.parse(text) as { type?: string };
      expect(message.type).toBe('authenticate');
    });

    await expect(
      openRealtimeConnection({
        baseUrl: 'http://127.0.0.1:3001',
        tenantKey: 'local-padel',
        ticket: 'synthetic-ticket',
        timeoutMs: 50,
        socketFactory: transport.factory,
      }),
    ).rejects.toThrow('DIRECT_REALTIME_VERIFY_CONNECTION_READY_TIMEOUT');
    expect(transport.sockets[0]?.terminated).toBe(true);
  });
});
