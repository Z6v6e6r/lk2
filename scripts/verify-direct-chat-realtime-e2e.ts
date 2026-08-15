import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { realtimeTicketRedisKey } from '@phub/auth';
import { runtimeContourTargetFingerprint, type RuntimeContourAttestation } from '@phub/config';
import { createDatabasePool, withTenantTransaction } from '@phub/database';
import { connect as connectRabbit, type Channel, type ChannelModel } from 'amqplib';
import Redis from 'ioredis';
import { decodeJwt } from 'jose';
import WebSocket, { type RawData } from 'ws';

const CONFIRMATION = 'RUN_LOCAL_DIRECT_REALTIME_VERIFY';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,31}$/;
const TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const VERIFY_TIMEOUT_MS = 15_000;
const MAX_SOCKET_MESSAGE_BYTES = 16_384;
const MAX_SOCKET_TRANSPORT_PAYLOAD_BYTES = 65_536;
const MAX_BUFFERED_SOCKET_MESSAGES = 100;
const SOCKET_CLOSED_STATE = WebSocket.CLOSED;

export interface RealtimeSocket {
  readonly readyState: number;
  on(event: 'message', listener: (raw: RawData) => void): RealtimeSocket;
  on(event: 'error', listener: () => void): RealtimeSocket;
  on(event: 'close', listener: (code: number) => void): RealtimeSocket;
  once(event: 'open', listener: () => void): RealtimeSocket;
  once(event: 'close', listener: () => void): RealtimeSocket;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export type RealtimeSocketFactory = (
  url: URL,
  options: { readonly maxPayload: number },
) => RealtimeSocket;

interface RealtimeConnection {
  waitFor(
    predicate: (message: Readonly<Record<string, unknown>>) => boolean,
    failureCode: string,
  ): Promise<Readonly<Record<string, unknown>>>;
  close(): Promise<void>;
}

interface DatabaseProbe {
  latestSequence(conversationId: string): Promise<number>;
  waitForPublishedOutbox(input: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly sequence: number;
    readonly correlationId: string;
  }): Promise<void>;
  close(): Promise<void>;
}

interface RuntimeContourProbe {
  verifyTicketStored(ticket: string): Promise<void>;
  verifyTicketConsumed(ticket: string): Promise<void>;
  waitForRabbitEvent(input: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly messageId: string;
    readonly sequence: number;
    readonly correlationId: string;
  }): Promise<void>;
  close(): Promise<void>;
}

export interface DirectChatRealtimeVerifyReport {
  readonly result: 'PASS';
  readonly conversationId: string;
  readonly firstMessageId: string;
  readonly secondMessageId: string;
  readonly firstSequence: number;
  readonly secondSequence: number;
  readonly outboxPublished: 2;
  readonly rabbitEventMatches: 2;
  readonly redisTicketRoundTrips: 1;
  readonly realtimeHints: 2;
  readonly httpRecoveryMatches: 1;
}

export interface DirectChatRealtimeVerifyOptions {
  readonly confirm: string;
  readonly appEnv: string;
  readonly apiBaseUrl: string;
  readonly realtimeBaseUrl: string;
  readonly workerBaseUrl: string;
  readonly databaseUrl: string;
  readonly rabbitmqUrl: string;
  readonly redisUrl: string;
  readonly tenantKey: string;
  readonly recipientUserId: string;
  readonly runId: string;
  readonly playerAToken: string;
  readonly playerBToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly openRealtime?: (input: {
    readonly baseUrl: string;
    readonly tenantKey: string;
    readonly ticket: string;
    readonly conversationId: string;
    readonly afterSequence: number;
  }) => Promise<RealtimeConnection>;
  readonly authenticateRealtime?: (input: {
    readonly baseUrl: string;
    readonly tenantKey: string;
    readonly ticket: string;
  }) => Promise<void>;
  readonly databaseProbe?: DatabaseProbe;
  readonly runtimeContourProbe?: RuntimeContourProbe;
  readonly runtimeContourProbeFactory?: (
    rabbitmqUrl: string,
    redisUrl: string,
  ) => Promise<RuntimeContourProbe>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(code);
  return value;
}

function loopbackBaseUrl(value: string, code: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(code);
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    (url.hostname !== 'localhost' &&
      url.hostname !== '127.0.0.1' &&
      url.hostname !== '::1' &&
      url.hostname !== '[::1]') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new Error(code);
  }
  return url.toString();
}

function isolatedDatabaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DIRECT_REALTIME_VERIFY_DATABASE_URL_INVALID');
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (
    (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
    (url.hostname !== 'localhost' &&
      url.hostname !== '127.0.0.1' &&
      url.hostname !== '::1' &&
      url.hostname !== '[::1]') ||
    url.search ||
    url.hash ||
    !databaseName.endsWith('_verify')
  ) {
    throw new Error('DIRECT_REALTIME_VERIFY_DATABASE_TARGET_NOT_ISOLATED');
  }
  return value;
}

function isolatedRabbitmqUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DIRECT_REALTIME_VERIFY_RABBITMQ_URL_INVALID');
  }
  const vhost = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (
    (url.protocol !== 'amqp:' && url.protocol !== 'amqps:') ||
    (url.hostname !== 'localhost' &&
      url.hostname !== '127.0.0.1' &&
      url.hostname !== '::1' &&
      url.hostname !== '[::1]') ||
    url.search ||
    url.hash ||
    !vhost.endsWith('_verify')
  ) {
    throw new Error('DIRECT_REALTIME_VERIFY_RABBITMQ_TARGET_NOT_ISOLATED');
  }
  return value;
}

function isolatedRedisUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DIRECT_REALTIME_VERIFY_REDIS_URL_INVALID');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const databaseNumber = Number(database);
  if (
    (url.protocol !== 'redis:' && url.protocol !== 'rediss:') ||
    (url.hostname !== 'localhost' &&
      url.hostname !== '127.0.0.1' &&
      url.hostname !== '::1' &&
      url.hostname !== '[::1]') ||
    url.search ||
    url.hash ||
    !/^[1-9][0-9]*$/.test(database) ||
    !Number.isSafeInteger(databaseNumber)
  ) {
    throw new Error('DIRECT_REALTIME_VERIFY_REDIS_TARGET_NOT_ISOLATED');
  }
  return value;
}

function tenantIdFromTokens(playerAToken: string, playerBToken: string): string {
  let playerA: unknown;
  let playerB: unknown;
  try {
    playerA = decodeJwt(playerAToken).tenants;
    playerB = decodeJwt(playerBToken).tenants;
  } catch {
    throw new Error('DIRECT_REALTIME_VERIFY_TOKEN_CLAIMS_INVALID');
  }
  if (
    !Array.isArray(playerA) ||
    playerA.length !== 1 ||
    typeof playerA[0] !== 'string' ||
    !UUID_PATTERN.test(playerA[0]) ||
    !Array.isArray(playerB) ||
    playerB.length !== 1 ||
    playerB[0] !== playerA[0]
  ) {
    throw new Error('DIRECT_REALTIME_VERIFY_TOKEN_TENANT_MISMATCH');
  }
  return playerA[0];
}

function apiUrl(baseUrl: string, path: string): URL {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
}

async function requestJson(options: {
  readonly fetchImpl: typeof fetch;
  readonly baseUrl: string;
  readonly path: string;
  readonly method: 'GET' | 'POST';
  readonly token?: string;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  readonly payload?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const response = await options.fetchImpl(apiUrl(options.baseUrl, options.path), {
    method: options.method,
    headers: {
      Accept: 'application/json',
      'X-Correlation-ID': options.correlationId,
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      ...(options.payload ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.payload ? { body: JSON.stringify(options.payload) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.toLowerCase().includes('application/json')
    ? ((await response.json()) as unknown)
    : undefined;
  if (!response.ok || !isRecord(body)) {
    const responseCode = isRecord(body) && typeof body.code === 'string' ? body.code : 'INVALID';
    throw new Error(`DIRECT_REALTIME_VERIFY_HTTP_${response.status}_${responseCode}`);
  }
  return body;
}

async function checkReady(
  fetchImpl: typeof fetch,
  baseUrl: string,
  component: string,
  expectedContour: RuntimeContourAttestation,
): Promise<void> {
  const response = await fetchImpl(apiUrl(baseUrl, '/health/ready'), {
    method: 'GET',
    headers: { Accept: 'application/json', 'X-Correlation-ID': `verify-ready-${component}` },
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`DIRECT_REALTIME_VERIFY_${component}_NOT_READY`);
  const body = (await response.json().catch(() => undefined)) as unknown;
  const contour = isRecord(body) && isRecord(body.runtimeContour) ? body.runtimeContour : undefined;
  const expectedEntries = Object.entries(expectedContour);
  if (
    !contour ||
    Object.keys(contour).sort().join(',') !==
      expectedEntries
        .map(([key]) => key)
        .sort()
        .join(',') ||
    expectedEntries.some(([key, value]) => contour[key] !== value)
  ) {
    throw new Error(`DIRECT_REALTIME_VERIFY_${component}_CONTOUR_ATTESTATION_INVALID`);
  }
}

function conversationIdFrom(value: Record<string, unknown>): string {
  const conversation = isRecord(value.conversation) ? value.conversation : undefined;
  const conversationId = conversation?.id;
  if (
    value.outcome !== 'ok' ||
    typeof conversationId !== 'string' ||
    !UUID_PATTERN.test(conversationId)
  ) {
    throw new Error('DIRECT_REALTIME_VERIFY_CONVERSATION_RESPONSE_INVALID');
  }
  return conversationId;
}

function messageFrom(
  value: Record<string, unknown>,
  expectedConversationId: string,
  expectedBody: string,
): { readonly id: string; readonly sequence: number } {
  const message = isRecord(value.message) ? value.message : undefined;
  if (
    value.outcome !== 'ok' ||
    typeof message?.id !== 'string' ||
    !UUID_PATTERN.test(message.id) ||
    message.conversationId !== expectedConversationId ||
    !Number.isSafeInteger(message.sequence) ||
    Number(message.sequence) < 1 ||
    message.body !== expectedBody
  ) {
    throw new Error('DIRECT_REALTIME_VERIFY_MESSAGE_RESPONSE_INVALID');
  }
  return { id: message.id, sequence: Number(message.sequence) };
}

function ticketFrom(value: Record<string, unknown>): string {
  if (typeof value.ticket !== 'string' || value.ticket.length < 32) {
    throw new Error('DIRECT_REALTIME_VERIFY_TICKET_RESPONSE_INVALID');
  }
  return value.ticket;
}

function realtimeTicketIdentity(ticket: string): {
  readonly key: string;
  readonly sessionId: string;
} {
  let claims: ReturnType<typeof decodeJwt>;
  try {
    claims = decodeJwt(ticket);
  } catch {
    throw new Error('DIRECT_REALTIME_VERIFY_TICKET_CLAIMS_INVALID');
  }
  if (
    typeof claims.jti !== 'string' ||
    !UUID_PATTERN.test(claims.jti) ||
    typeof claims.sid !== 'string' ||
    !UUID_PATTERN.test(claims.sid)
  ) {
    throw new Error('DIRECT_REALTIME_VERIFY_TICKET_CLAIMS_INVALID');
  }
  return { key: realtimeTicketRedisKey(claims.jti), sessionId: claims.sid };
}

function matchesRabbitEvent(
  content: Buffer,
  input: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly messageId: string;
    readonly sequence: number;
    readonly correlationId: string;
  },
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString('utf8')) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(parsed) || !isRecord(parsed.payload)) return false;
  return (
    typeof parsed.id === 'string' &&
    UUID_PATTERN.test(parsed.id) &&
    parsed.type === 'messaging.message.created.v1' &&
    parsed.tenantId === input.tenantId &&
    parsed.correlationId === input.correlationId &&
    Object.keys(parsed.payload).sort().join(',') === 'conversationId,messageId,sequence' &&
    parsed.payload.conversationId === input.conversationId &&
    parsed.payload.messageId === input.messageId &&
    parsed.payload.sequence === input.sequence
  );
}

async function createRuntimeContourProbe(
  rabbitmqUrl: string,
  redisUrl: string,
): Promise<RuntimeContourProbe> {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  let rabbit: ChannelModel | undefined;
  let channel: Channel | undefined;
  try {
    await redis.connect();
    rabbit = await connectRabbit(rabbitmqUrl);
    channel = await rabbit.createChannel();
    await channel.assertExchange('phub.events', 'topic', { durable: true });
    const queue = await channel.assertQueue('', { exclusive: true, autoDelete: true });
    await channel.bindQueue(queue.queue, 'phub.events', 'messaging.message.created.v1');
    const activeRabbit = rabbit;
    const activeChannel = channel;

    return {
      async verifyTicketStored(ticket) {
        const identity = realtimeTicketIdentity(ticket);
        if ((await redis.get(identity.key)) !== identity.sessionId) {
          throw new Error('DIRECT_REALTIME_VERIFY_REDIS_TICKET_NOT_STORED');
        }
      },
      async verifyTicketConsumed(ticket) {
        const identity = realtimeTicketIdentity(ticket);
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
          const value = await redis.get(identity.key);
          if (value === null) return;
          if (value !== identity.sessionId) {
            throw new Error('DIRECT_REALTIME_VERIFY_REDIS_TICKET_VALUE_INVALID');
          }
          await delay(25);
        }
        throw new Error('DIRECT_REALTIME_VERIFY_REDIS_TICKET_NOT_CONSUMED');
      },
      async waitForRabbitEvent(input) {
        const deadline = Date.now() + VERIFY_TIMEOUT_MS;
        while (Date.now() < deadline) {
          const message = await activeChannel.get(queue.queue, { noAck: false });
          if (!message) {
            await delay(50);
            continue;
          }
          const matches = matchesRabbitEvent(message.content, input);
          activeChannel.ack(message);
          if (matches) return;
        }
        throw new Error('DIRECT_REALTIME_VERIFY_RABBIT_EVENT_TIMEOUT');
      },
      async close() {
        await activeChannel.close().catch(() => undefined);
        await activeRabbit.close().catch(() => undefined);
        await redis.quit().catch(() => redis.disconnect());
      },
    };
  } catch {
    await channel?.close().catch(() => undefined);
    await rabbit?.close().catch(() => undefined);
    redis.disconnect();
    throw new Error('DIRECT_REALTIME_VERIFY_CONTOUR_CONNECT_FAILED');
  }
}

function rawDataToText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return raw.toString('utf8');
}

function rawDataByteLength(raw: RawData): number {
  if (Array.isArray(raw)) return raw.reduce((total, part) => total + part.byteLength, 0);
  return raw.byteLength;
}

export async function openRealtimeConnection(input: {
  readonly baseUrl: string;
  readonly tenantKey: string;
  readonly ticket: string;
  readonly conversationId?: string;
  readonly afterSequence?: number;
  readonly timeoutMs?: number;
  readonly socketFactory?: RealtimeSocketFactory;
}): Promise<RealtimeConnection> {
  if ((input.conversationId === undefined) !== (input.afterSequence === undefined)) {
    throw new Error('DIRECT_REALTIME_VERIFY_SOCKET_SUBSCRIPTION_INVALID');
  }
  const timeoutMs = input.timeoutMs ?? VERIFY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > VERIFY_TIMEOUT_MS) {
    throw new Error('DIRECT_REALTIME_VERIFY_SOCKET_TIMEOUT_INVALID');
  }
  const url = new URL(`/realtime/v1/${encodeURIComponent(input.tenantKey)}`, input.baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = (input.socketFactory ?? ((target, options) => new WebSocket(target, options)))(
    url,
    { maxPayload: MAX_SOCKET_TRANSPORT_PAYLOAD_BYTES },
  );
  const messages: Readonly<Record<string, unknown>>[] = [];
  let wake: (() => void) | undefined;
  let terminalCode: string | undefined;
  socket.on('message', (raw) => {
    if (terminalCode) return;
    if (rawDataByteLength(raw) > MAX_SOCKET_MESSAGE_BYTES) {
      terminalCode = 'DIRECT_REALTIME_VERIFY_SOCKET_MESSAGE_TOO_LARGE';
      socket.close(1009, 'Verification message too large');
      wake?.();
      return;
    }
    if (messages.length >= MAX_BUFFERED_SOCKET_MESSAGES) {
      terminalCode = 'DIRECT_REALTIME_VERIFY_SOCKET_BUFFER_LIMIT';
      socket.close(1009, 'Verification buffer limit');
      wake?.();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToText(raw)) as unknown;
    } catch {
      terminalCode = 'DIRECT_REALTIME_VERIFY_SOCKET_MESSAGE_INVALID';
      socket.close(1007, 'Verification message invalid');
      wake?.();
      return;
    }
    if (!isRecord(parsed)) {
      terminalCode = 'DIRECT_REALTIME_VERIFY_SOCKET_MESSAGE_INVALID';
      socket.close(1007, 'Verification message invalid');
      wake?.();
      return;
    }
    messages.push(parsed);
    wake?.();
  });
  socket.on('error', () => {
    terminalCode ??= 'DIRECT_REALTIME_VERIFY_SOCKET_ERROR';
    wake?.();
  });
  socket.on('close', (code) => {
    if (code !== 1000) terminalCode ??= `DIRECT_REALTIME_VERIFY_SOCKET_CLOSED_${code}`;
    wake?.();
  });

  const connection: RealtimeConnection = {
    async waitFor(predicate, failureCode) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0]!;
        if (terminalCode) throw new Error(terminalCode);
        await Promise.race([
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
          delay(Math.max(1, deadline - Date.now())),
        ]);
        wake = undefined;
      }
      throw new Error(failureCode);
    },
    async close() {
      if (socket.readyState === SOCKET_CLOSED_STATE) return;
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.close(1000, 'Verification complete');
      await Promise.race([closed, delay(2_000)]);
    },
  };

  try {
    await Promise.race([
      new Promise<void>((resolve) => socket.once('open', () => resolve())),
      delay(timeoutMs).then(() => {
        throw new Error('DIRECT_REALTIME_VERIFY_SOCKET_OPEN_TIMEOUT');
      }),
    ]);
    socket.send(JSON.stringify({ type: 'authenticate', ticket: input.ticket }));
    await connection.waitFor(
      (message) => message.type === 'connection.ready',
      'DIRECT_REALTIME_VERIFY_CONNECTION_READY_TIMEOUT',
    );
    if (input.conversationId !== undefined && input.afterSequence !== undefined) {
      socket.send(
        JSON.stringify({
          type: 'conversation.subscribe',
          conversationId: input.conversationId,
          afterSequence: input.afterSequence,
        }),
      );
    }
    return connection;
  } catch (error) {
    if (socket.readyState !== SOCKET_CLOSED_STATE) socket.terminate();
    throw error;
  }
}

async function authenticateRealtimeTicket(input: {
  readonly baseUrl: string;
  readonly tenantKey: string;
  readonly ticket: string;
}): Promise<void> {
  const connection = await openRealtimeConnection(input);
  await connection.close();
}

function createDatabaseProbe(databaseUrl: string, tenantId: string): DatabaseProbe {
  const pool = createDatabasePool(databaseUrl);
  return {
    latestSequence(conversationId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<{ latest_sequence: number | string }>(
          `select next_sequence - 1 as latest_sequence
             from messaging.conversations
            where tenant_id = $1 and id = $2`,
          [tenantId, conversationId],
        );
        const value = Number(result.rows[0]?.latest_sequence);
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new Error('DIRECT_REALTIME_VERIFY_CONVERSATION_READBACK_INVALID');
        }
        return value;
      });
    },
    async waitForPublishedOutbox(input) {
      const deadline = Date.now() + VERIFY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const row = await withTenantTransaction(pool, tenantId, async (client) => {
          const result = await client.query<{
            published_at: Date | string | null;
            correlation_id: string;
            payload: unknown;
          }>(
            `select published_at, correlation_id, payload
               from audit.outbox_events
              where tenant_id = $1
                and event_type = 'messaging.message.created.v1'
                and payload ->> 'messageId' = $2`,
            [tenantId, input.messageId],
          );
          if (result.rows.length > 1) {
            throw new Error('DIRECT_REALTIME_VERIFY_OUTBOX_DUPLICATED');
          }
          return result.rows[0];
        });
        if (row) {
          if (
            !isRecord(row.payload) ||
            Object.keys(row.payload).sort().join(',') !== 'conversationId,messageId,sequence' ||
            row.payload.conversationId !== input.conversationId ||
            row.payload.messageId !== input.messageId ||
            row.payload.sequence !== input.sequence ||
            row.correlation_id !== input.correlationId
          ) {
            throw new Error('DIRECT_REALTIME_VERIFY_OUTBOX_PAYLOAD_INVALID');
          }
          if (row.published_at) return;
        }
        await delay(100);
      }
      throw new Error('DIRECT_REALTIME_VERIFY_OUTBOX_PUBLISH_TIMEOUT');
    },
    async close() {
      await pool.end();
    },
  };
}

export async function runDirectChatRealtimeVerify(
  options: DirectChatRealtimeVerifyOptions,
): Promise<DirectChatRealtimeVerifyReport> {
  if (options.confirm !== CONFIRMATION) {
    throw new Error('DIRECT_REALTIME_VERIFY_CONFIRMATION_REQUIRED');
  }
  if (options.appEnv !== 'local' && options.appEnv !== 'ci') {
    throw new Error('DIRECT_REALTIME_VERIFY_LOCAL_ENV_REQUIRED');
  }
  const apiBaseUrl = loopbackBaseUrl(
    options.apiBaseUrl,
    'DIRECT_REALTIME_VERIFY_API_BASE_URL_INVALID',
  );
  const realtimeBaseUrl = loopbackBaseUrl(
    options.realtimeBaseUrl,
    'DIRECT_REALTIME_VERIFY_REALTIME_BASE_URL_INVALID',
  );
  const workerBaseUrl = loopbackBaseUrl(
    options.workerBaseUrl,
    'DIRECT_REALTIME_VERIFY_WORKER_BASE_URL_INVALID',
  );
  const databaseUrl = isolatedDatabaseUrl(options.databaseUrl);
  const rabbitmqUrl = isolatedRabbitmqUrl(options.rabbitmqUrl);
  const redisUrl = isolatedRedisUrl(options.redisUrl);
  if (!TENANT_KEY_PATTERN.test(options.tenantKey)) {
    throw new Error('DIRECT_REALTIME_VERIFY_TENANT_INVALID');
  }
  if (!UUID_PATTERN.test(options.recipientUserId)) {
    throw new Error('DIRECT_REALTIME_VERIFY_RECIPIENT_INVALID');
  }
  if (!RUN_ID_PATTERN.test(options.runId)) throw new Error('DIRECT_REALTIME_VERIFY_RUN_ID_INVALID');
  requiredString(options.playerAToken, 'DIRECT_REALTIME_VERIFY_PLAYER_A_TOKEN_REQUIRED');
  requiredString(options.playerBToken, 'DIRECT_REALTIME_VERIFY_PLAYER_B_TOKEN_REQUIRED');
  const tenantId = tenantIdFromTokens(options.playerAToken, options.playerBToken);
  const fetchImpl = options.fetchImpl ?? fetch;
  const openRealtime = options.openRealtime ?? openRealtimeConnection;
  const authenticateRealtime = options.authenticateRealtime ?? authenticateRealtimeTicket;
  const databaseProbe = options.databaseProbe ?? createDatabaseProbe(databaseUrl, tenantId);
  let runtimeContourProbe = options.runtimeContourProbe;
  let firstConnection: RealtimeConnection | undefined;
  let secondConnection: RealtimeConnection | undefined;

  try {
    const databaseTarget = runtimeContourTargetFingerprint(databaseUrl);
    const redisTarget = runtimeContourTargetFingerprint(redisUrl);
    const rabbitmqTarget = runtimeContourTargetFingerprint(rabbitmqUrl);
    await Promise.all([
      checkReady(fetchImpl, apiBaseUrl, 'API', {
        database: databaseTarget,
        redis: redisTarget,
      }),
      checkReady(fetchImpl, realtimeBaseUrl, 'REALTIME', {
        database: databaseTarget,
        redis: redisTarget,
        rabbitmq: rabbitmqTarget,
      }),
      checkReady(fetchImpl, workerBaseUrl, 'WORKER', {
        database: databaseTarget,
        rabbitmq: rabbitmqTarget,
      }),
    ]);
    runtimeContourProbe ??= await (options.runtimeContourProbeFactory ?? createRuntimeContourProbe)(
      rabbitmqUrl,
      redisUrl,
    );
    const rootPath = `/user/api/v1/${encodeURIComponent(options.tenantKey)}`;
    const issueTicket = (suffix: string) =>
      requestJson({
        fetchImpl,
        baseUrl: apiBaseUrl,
        path: `${rootPath}/messaging/realtime-ticket`,
        method: 'POST',
        token: options.playerBToken,
        correlationId: `direct-realtime.${options.runId}.ticket-${suffix}`,
      }).then(ticketFrom);
    const contourTicket = await issueTicket('contour');
    await runtimeContourProbe.verifyTicketStored(contourTicket);
    await authenticateRealtime({
      baseUrl: realtimeBaseUrl,
      tenantKey: options.tenantKey,
      ticket: contourTicket,
    });
    await runtimeContourProbe.verifyTicketConsumed(contourTicket);

    const conversationCorrelation = `direct-realtime.${options.runId}.conversation`;
    const conversationId = conversationIdFrom(
      await requestJson({
        fetchImpl,
        baseUrl: apiBaseUrl,
        path: `${rootPath}/conversations/direct`,
        method: 'POST',
        token: options.playerAToken,
        correlationId: conversationCorrelation,
        idempotencyKey: `direct-realtime:${options.runId}:conversation`,
        payload: { otherUserId: options.recipientUserId },
      }),
    );
    const baselineSequence = await databaseProbe.latestSequence(conversationId);

    firstConnection = await openRealtime({
      baseUrl: realtimeBaseUrl,
      tenantKey: options.tenantKey,
      ticket: await issueTicket('one'),
      conversationId,
      afterSequence: baselineSequence,
    });
    const firstSubscribed = await firstConnection.waitFor(
      (message) => message.type === 'conversation.subscribed',
      'DIRECT_REALTIME_VERIFY_FIRST_SUBSCRIPTION_TIMEOUT',
    );
    if (
      firstSubscribed.conversationId !== conversationId ||
      firstSubscribed.latestSequence !== baselineSequence
    ) {
      throw new Error('DIRECT_REALTIME_VERIFY_FIRST_SUBSCRIPTION_INVALID');
    }

    const sendMessage = async (number: 1 | 2) => {
      const body = `PADLHUB_DIRECT_REALTIME_VERIFY ${options.runId} ${number}`;
      const correlationId = `direct-realtime.${options.runId}.message-${number}`;
      const response = await requestJson({
        fetchImpl,
        baseUrl: apiBaseUrl,
        path: `${rootPath}/conversations/${conversationId}/messages`,
        method: 'POST',
        token: options.playerAToken,
        correlationId,
        idempotencyKey: `direct-realtime:${options.runId}:message-${number}`,
        payload: {
          clientMessageId: `direct-realtime:${options.runId}:client-message-${number}`,
          body,
        },
      });
      return { ...messageFrom(response, conversationId, body), correlationId };
    };

    const firstMessage = await sendMessage(1);
    if (firstMessage.sequence !== baselineSequence + 1) {
      throw new Error('DIRECT_REALTIME_VERIFY_FIRST_SEQUENCE_INVALID');
    }
    const firstHint = await firstConnection.waitFor(
      (message) => message.type === 'message.created' && message.messageId === firstMessage.id,
      'DIRECT_REALTIME_VERIFY_FIRST_FANOUT_TIMEOUT',
    );
    if (
      firstHint.conversationId !== conversationId ||
      firstHint.sequence !== firstMessage.sequence ||
      firstHint.correlationId !== firstMessage.correlationId
    ) {
      throw new Error('DIRECT_REALTIME_VERIFY_FIRST_FANOUT_INVALID');
    }
    const firstEvent = {
      tenantId,
      conversationId,
      messageId: firstMessage.id,
      sequence: firstMessage.sequence,
      correlationId: firstMessage.correlationId,
    };
    await Promise.all([
      databaseProbe.waitForPublishedOutbox(firstEvent),
      runtimeContourProbe.waitForRabbitEvent(firstEvent),
    ]);
    await firstConnection.close();
    firstConnection = undefined;

    const secondMessage = await sendMessage(2);
    if (secondMessage.sequence !== firstMessage.sequence + 1) {
      throw new Error('DIRECT_REALTIME_VERIFY_SECOND_SEQUENCE_INVALID');
    }
    const secondEvent = {
      tenantId,
      conversationId,
      messageId: secondMessage.id,
      sequence: secondMessage.sequence,
      correlationId: secondMessage.correlationId,
    };
    await Promise.all([
      databaseProbe.waitForPublishedOutbox(secondEvent),
      runtimeContourProbe.waitForRabbitEvent(secondEvent),
    ]);

    secondConnection = await openRealtime({
      baseUrl: realtimeBaseUrl,
      tenantKey: options.tenantKey,
      ticket: await issueTicket('two'),
      conversationId,
      afterSequence: firstMessage.sequence,
    });
    const secondSubscribed = await secondConnection.waitFor(
      (message) => message.type === 'conversation.subscribed',
      'DIRECT_REALTIME_VERIFY_SECOND_SUBSCRIPTION_TIMEOUT',
    );
    const gap = await secondConnection.waitFor(
      (message) => message.type === 'conversation.gap',
      'DIRECT_REALTIME_VERIFY_GAP_TIMEOUT',
    );
    if (
      secondSubscribed.conversationId !== conversationId ||
      secondSubscribed.latestSequence !== secondMessage.sequence ||
      gap.conversationId !== conversationId ||
      gap.afterSequence !== firstMessage.sequence ||
      gap.latestSequence !== secondMessage.sequence ||
      gap.reset !== false ||
      gap.recovery !== 'HTTP'
    ) {
      throw new Error('DIRECT_REALTIME_VERIFY_GAP_INVALID');
    }

    const history = await requestJson({
      fetchImpl,
      baseUrl: apiBaseUrl,
      path: `${rootPath}/conversations/${conversationId}/messages?afterSequence=${firstMessage.sequence}&limit=100`,
      method: 'GET',
      token: options.playerBToken,
      correlationId: `direct-realtime.${options.runId}.history`,
    });
    const historyMessages = Array.isArray(history.messages) ? history.messages : [];
    const exactRecovery = historyMessages.filter(
      (candidate) =>
        isRecord(candidate) &&
        candidate.id === secondMessage.id &&
        candidate.conversationId === conversationId &&
        candidate.sequence === secondMessage.sequence,
    );
    if (exactRecovery.length !== 1) {
      throw new Error('DIRECT_REALTIME_VERIFY_HTTP_RECOVERY_INVALID');
    }

    return {
      result: 'PASS',
      conversationId,
      firstMessageId: firstMessage.id,
      secondMessageId: secondMessage.id,
      firstSequence: firstMessage.sequence,
      secondSequence: secondMessage.sequence,
      outboxPublished: 2,
      rabbitEventMatches: 2,
      redisTicketRoundTrips: 1,
      realtimeHints: 2,
      httpRecoveryMatches: 1,
    };
  } finally {
    await firstConnection?.close().catch(() => undefined);
    await secondConnection?.close().catch(() => undefined);
    if (!options.runtimeContourProbe) await runtimeContourProbe?.close().catch(() => undefined);
    if (!options.databaseProbe) await databaseProbe.close().catch(() => undefined);
  }
}

function parseArguments(argv: readonly string[]): Record<string, string> {
  const allowed = new Set([
    'confirm',
    'api-base-url',
    'realtime-base-url',
    'worker-base-url',
    'tenant-key',
    'recipient-user-id',
    'run-id',
  ]);
  const values: Record<string, string> = {};
  for (const argument of argv) {
    if (!argument.startsWith('--') || !argument.includes('=')) {
      throw new Error('DIRECT_REALTIME_VERIFY_ARGUMENT_INVALID');
    }
    const separator = argument.indexOf('=');
    const key = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (!allowed.has(key) || key in values || value.length === 0) {
      throw new Error('DIRECT_REALTIME_VERIFY_ARGUMENT_INVALID');
    }
    values[key] = value;
  }
  return values;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const report = await runDirectChatRealtimeVerify({
    confirm: requiredString(args['confirm'], 'DIRECT_REALTIME_VERIFY_CONFIRMATION_REQUIRED'),
    appEnv: requiredString(process.env.APP_ENV, 'DIRECT_REALTIME_VERIFY_APP_ENV_REQUIRED'),
    apiBaseUrl: requiredString(args['api-base-url'], 'DIRECT_REALTIME_VERIFY_API_URL_REQUIRED'),
    realtimeBaseUrl: requiredString(
      args['realtime-base-url'],
      'DIRECT_REALTIME_VERIFY_REALTIME_URL_REQUIRED',
    ),
    workerBaseUrl: requiredString(
      args['worker-base-url'],
      'DIRECT_REALTIME_VERIFY_WORKER_URL_REQUIRED',
    ),
    databaseUrl: requiredString(
      process.env.DATABASE_URL,
      'DIRECT_REALTIME_VERIFY_DATABASE_URL_REQUIRED',
    ),
    rabbitmqUrl: requiredString(
      process.env.RABBITMQ_URL,
      'DIRECT_REALTIME_VERIFY_RABBITMQ_URL_REQUIRED',
    ),
    redisUrl: requiredString(process.env.REDIS_URL, 'DIRECT_REALTIME_VERIFY_REDIS_URL_REQUIRED'),
    tenantKey: requiredString(args['tenant-key'], 'DIRECT_REALTIME_VERIFY_TENANT_REQUIRED'),
    recipientUserId: requiredString(
      args['recipient-user-id'],
      'DIRECT_REALTIME_VERIFY_RECIPIENT_REQUIRED',
    ),
    runId: requiredString(args['run-id'], 'DIRECT_REALTIME_VERIFY_RUN_ID_REQUIRED'),
    playerAToken: requiredString(
      process.env.DIRECT_REALTIME_VERIFY_PLAYER_A_TOKEN,
      'DIRECT_REALTIME_VERIFY_PLAYER_A_TOKEN_REQUIRED',
    ),
    playerBToken: requiredString(
      process.env.DIRECT_REALTIME_VERIFY_PLAYER_B_TOKEN,
      'DIRECT_REALTIME_VERIFY_PLAYER_B_TOKEN_REQUIRED',
    ),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
