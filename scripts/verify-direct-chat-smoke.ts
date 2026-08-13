import { pathToFileURL } from 'node:url';

import { safeMessagingBaseUrl } from './safe-messaging-base-url.js';

const CONFIRMATION = 'SEND_DIRECT_CHAT_SMOKE';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,31}$/;
const TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const MESSAGE_PREFIX = 'PADLHUB_CHAT_SMOKE ';

interface DirectConversationResponse {
  readonly outcome: 'ok';
  readonly conversation: { readonly id: string };
  readonly replayed: boolean;
}

interface MessageResponse {
  readonly outcome: 'ok';
  readonly message: {
    readonly id: string;
    readonly conversationId: string;
    readonly sequence: number;
    readonly body: string;
  };
  readonly replayed: boolean;
}

interface ReadCursorResponse {
  readonly outcome: 'ok';
  readonly readThroughSequence: number;
  readonly replayed: boolean;
}

export interface DirectChatSmokeReport {
  readonly result: 'PASS';
  readonly conversationId: string;
  readonly messageId: string;
  readonly sequence: number;
  readonly correlations: {
    readonly direct: string;
    readonly send: string;
    readonly history: string;
    readonly read: string;
  };
  readonly mutationRequests: 6;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  return value;
}

function apiUrl(baseUrl: string, path: string): URL {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
}

async function requestJson(options: {
  readonly fetchImpl: typeof fetch;
  readonly baseUrl: string;
  readonly path: string;
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly token: string;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  readonly payload?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const response = await options.fetchImpl(apiUrl(options.baseUrl, options.path), {
    method: options.method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${options.token}`,
      'X-Correlation-ID': options.correlationId,
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
    const code = isRecord(body) && typeof body.code === 'string' ? body.code : 'INVALID_RESPONSE';
    throw new Error(`DIRECT_CHAT_SMOKE_HTTP_${response.status}_${code}`);
  }
  return body;
}

function directResponse(value: Record<string, unknown>): DirectConversationResponse {
  const conversation = isRecord(value.conversation) ? value.conversation : undefined;
  const id = conversation?.id;
  if (
    value.outcome !== 'ok' ||
    typeof id !== 'string' ||
    !UUID_PATTERN.test(id) ||
    typeof value.replayed !== 'boolean'
  ) {
    throw new Error('DIRECT_CHAT_SMOKE_DIRECT_RESPONSE_INVALID');
  }
  return { outcome: 'ok', conversation: { id }, replayed: value.replayed };
}

function messageResponse(value: Record<string, unknown>): MessageResponse {
  const message = isRecord(value.message) ? value.message : undefined;
  const id = message?.id;
  const conversationId = message?.conversationId;
  const sequence = message?.sequence;
  const body = message?.body;
  if (
    value.outcome !== 'ok' ||
    typeof id !== 'string' ||
    !UUID_PATTERN.test(id) ||
    typeof conversationId !== 'string' ||
    !UUID_PATTERN.test(conversationId) ||
    typeof sequence !== 'number' ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    typeof body !== 'string' ||
    typeof value.replayed !== 'boolean'
  ) {
    throw new Error('DIRECT_CHAT_SMOKE_MESSAGE_RESPONSE_INVALID');
  }
  return {
    outcome: 'ok',
    message: { id, conversationId, sequence, body },
    replayed: value.replayed,
  };
}

function readCursorResponse(value: Record<string, unknown>): ReadCursorResponse {
  if (
    value.outcome !== 'ok' ||
    typeof value.readThroughSequence !== 'number' ||
    !Number.isSafeInteger(value.readThroughSequence) ||
    typeof value.replayed !== 'boolean'
  ) {
    throw new Error('DIRECT_CHAT_SMOKE_READ_RESPONSE_INVALID');
  }
  return {
    outcome: 'ok',
    readThroughSequence: value.readThroughSequence,
    replayed: value.replayed,
  };
}

function sameMessage(left: MessageResponse, right: MessageResponse, expectedBody: string): boolean {
  return (
    left.message.id === right.message.id &&
    left.message.conversationId === right.message.conversationId &&
    left.message.sequence === right.message.sequence &&
    left.message.body === expectedBody &&
    right.message.body === expectedBody
  );
}

export async function runDirectChatSmoke(options: {
  readonly confirm: string;
  readonly baseUrl: string;
  readonly tenantKey: string;
  readonly recipientUserId: string;
  readonly runId: string;
  readonly message: string;
  readonly playerAToken: string;
  readonly playerBToken: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<DirectChatSmokeReport> {
  if (options.confirm !== CONFIRMATION) throw new Error('DIRECT_CHAT_SMOKE_CONFIRMATION_REQUIRED');
  const baseUrl = safeMessagingBaseUrl(options.baseUrl, 'DIRECT_CHAT_SMOKE_BASE_URL_INVALID');
  if (!TENANT_KEY_PATTERN.test(options.tenantKey))
    throw new Error('DIRECT_CHAT_SMOKE_TENANT_INVALID');
  if (!UUID_PATTERN.test(options.recipientUserId)) {
    throw new Error('DIRECT_CHAT_SMOKE_RECIPIENT_INVALID');
  }
  if (!RUN_ID_PATTERN.test(options.runId)) throw new Error('DIRECT_CHAT_SMOKE_RUN_ID_INVALID');
  if (
    !options.message.startsWith(MESSAGE_PREFIX) ||
    options.message.length > 200 ||
    options.message.trim() !== options.message
  ) {
    throw new Error('DIRECT_CHAT_SMOKE_MESSAGE_INVALID');
  }
  requiredString(options.playerAToken, 'DIRECT_CHAT_SMOKE_PLAYER_A_TOKEN_REQUIRED');
  requiredString(options.playerBToken, 'DIRECT_CHAT_SMOKE_PLAYER_B_TOKEN_REQUIRED');

  const fetchImpl = options.fetchImpl ?? fetch;
  const rootPath = `/user/api/v1/${encodeURIComponent(options.tenantKey)}`;
  const keys = {
    direct: `chat-smoke:${options.runId}:direct`,
    send: `chat-smoke:${options.runId}:send`,
    read: `chat-smoke:${options.runId}:read`,
    clientMessage: `chat-smoke:${options.runId}:client-message`,
  };
  const correlations = {
    direct: `chat-smoke.${options.runId}.direct`,
    send: `chat-smoke.${options.runId}.send`,
    history: `chat-smoke.${options.runId}.history`,
    read: `chat-smoke.${options.runId}.read`,
  };

  const directPath = `${rootPath}/conversations/direct`;
  const createPayload = { otherUserId: options.recipientUserId };
  const firstDirect = directResponse(
    await requestJson({
      fetchImpl,
      baseUrl,
      path: directPath,
      method: 'POST',
      token: options.playerAToken,
      correlationId: correlations.direct,
      idempotencyKey: keys.direct,
      payload: createPayload,
    }),
  );
  const replayedDirect = directResponse(
    await requestJson({
      fetchImpl,
      baseUrl,
      path: directPath,
      method: 'POST',
      token: options.playerAToken,
      correlationId: correlations.direct,
      idempotencyKey: keys.direct,
      payload: createPayload,
    }),
  );
  if (firstDirect.conversation.id !== replayedDirect.conversation.id || !replayedDirect.replayed) {
    throw new Error('DIRECT_CHAT_SMOKE_DIRECT_REPLAY_FAILED');
  }

  const conversationId = firstDirect.conversation.id;
  const messagesPath = `${rootPath}/conversations/${conversationId}/messages`;
  const sendPayload = { clientMessageId: keys.clientMessage, body: options.message };
  const firstMessage = messageResponse(
    await requestJson({
      fetchImpl,
      baseUrl,
      path: messagesPath,
      method: 'POST',
      token: options.playerAToken,
      correlationId: correlations.send,
      idempotencyKey: keys.send,
      payload: sendPayload,
    }),
  );
  const replayedMessage = messageResponse(
    await requestJson({
      fetchImpl,
      baseUrl,
      path: messagesPath,
      method: 'POST',
      token: options.playerAToken,
      correlationId: correlations.send,
      idempotencyKey: keys.send,
      payload: sendPayload,
    }),
  );
  if (!replayedMessage.replayed || !sameMessage(firstMessage, replayedMessage, options.message)) {
    throw new Error('DIRECT_CHAT_SMOKE_MESSAGE_REPLAY_FAILED');
  }

  const afterSequence = Math.max(0, firstMessage.message.sequence - 1);
  const history = await requestJson({
    fetchImpl,
    baseUrl,
    path: `${messagesPath}?afterSequence=${afterSequence}&limit=100`,
    method: 'GET',
    token: options.playerBToken,
    correlationId: correlations.history,
  });
  const historyMessages = Array.isArray(history.messages) ? history.messages : [];
  const exactMatches = historyMessages.filter((candidate) => {
    if (!isRecord(candidate)) return false;
    return (
      candidate.id === firstMessage.message.id &&
      candidate.conversationId === conversationId &&
      candidate.sequence === firstMessage.message.sequence &&
      candidate.body === options.message
    );
  });
  if (exactMatches.length !== 1) throw new Error('DIRECT_CHAT_SMOKE_PLAYER_B_HISTORY_FAILED');

  const readPath = `${rootPath}/conversations/${conversationId}/read-cursor`;
  const readPayload = { throughSequence: firstMessage.message.sequence };
  const firstRead = readCursorResponse(
    await requestJson({
      fetchImpl,
      baseUrl,
      path: readPath,
      method: 'PUT',
      token: options.playerBToken,
      correlationId: correlations.read,
      idempotencyKey: keys.read,
      payload: readPayload,
    }),
  );
  const replayedRead = readCursorResponse(
    await requestJson({
      fetchImpl,
      baseUrl,
      path: readPath,
      method: 'PUT',
      token: options.playerBToken,
      correlationId: correlations.read,
      idempotencyKey: keys.read,
      payload: readPayload,
    }),
  );
  if (
    firstRead.readThroughSequence !== firstMessage.message.sequence ||
    replayedRead.readThroughSequence !== firstRead.readThroughSequence ||
    !replayedRead.replayed
  ) {
    throw new Error('DIRECT_CHAT_SMOKE_READ_REPLAY_FAILED');
  }

  return {
    result: 'PASS',
    conversationId,
    messageId: firstMessage.message.id,
    sequence: firstMessage.message.sequence,
    correlations,
    mutationRequests: 6,
  };
}

function parseArguments(argv: readonly string[]): Record<string, string> {
  const allowed = new Set([
    'confirm',
    'base-url',
    'tenant-key',
    'recipient-user-id',
    'run-id',
    'message',
  ]);
  const values: Record<string, string> = {};
  for (const argument of argv) {
    if (!argument.startsWith('--') || !argument.includes('=')) {
      throw new Error('DIRECT_CHAT_SMOKE_ARGUMENT_INVALID');
    }
    const separator = argument.indexOf('=');
    const key = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (!allowed.has(key) || key in values || value.length === 0) {
      throw new Error('DIRECT_CHAT_SMOKE_ARGUMENT_INVALID');
    }
    values[key] = value;
  }
  return values;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const report = await runDirectChatSmoke({
    confirm: requiredString(args['confirm'], 'DIRECT_CHAT_SMOKE_CONFIRMATION_REQUIRED'),
    baseUrl: requiredString(args['base-url'], 'DIRECT_CHAT_SMOKE_BASE_URL_REQUIRED'),
    tenantKey: requiredString(args['tenant-key'], 'DIRECT_CHAT_SMOKE_TENANT_REQUIRED'),
    recipientUserId: requiredString(
      args['recipient-user-id'],
      'DIRECT_CHAT_SMOKE_RECIPIENT_REQUIRED',
    ),
    runId: requiredString(args['run-id'], 'DIRECT_CHAT_SMOKE_RUN_ID_REQUIRED'),
    message: requiredString(args['message'], 'DIRECT_CHAT_SMOKE_MESSAGE_REQUIRED'),
    playerAToken: requiredString(
      process.env.MESSAGING_SMOKE_PLAYER_A_TOKEN,
      'DIRECT_CHAT_SMOKE_PLAYER_A_TOKEN_REQUIRED',
    ),
    playerBToken: requiredString(
      process.env.MESSAGING_SMOKE_PLAYER_B_TOKEN,
      'DIRECT_CHAT_SMOKE_PLAYER_B_TOKEN_REQUIRED',
    ),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
