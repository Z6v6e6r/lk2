import { ApiClientError } from '@phub/api-sdk';

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const keyPattern = /^[A-Za-z0-9._:-]{16,128}$/;
const maximumMuteMs = 30 * 24 * 60 * 60 * 1000;

function reject(): never {
  throw new ApiClientError('Native request rejected', 400, 'NATIVE_REQUEST_REJECTED', 'native');
}

/** Text conversation commands; native code independently validates this exact command. */
export function messagingRequest(path: string, method: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (!/^Bearer \S+$/.test(headers.get('authorization') ?? '')) reject();
  if (path === '/messaging/realtime-ticket' && method === 'POST') {
    if (init?.body != null || headers.has('idempotency-key')) reject();
    return { resource: 'realtimeTicket' };
  }
  if (path === '/conversations/direct' && method === 'POST') {
    if (!keyPattern.test(headers.get('idempotency-key') ?? '') || typeof init?.body !== 'string')
      reject();
    let body: unknown;
    try {
      body = JSON.parse(init.body);
    } catch {
      reject();
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) reject();
    const value = body as Record<string, unknown>;
    if (
      Object.keys(value).length !== 1 ||
      typeof value.otherUserId !== 'string' ||
      value.otherUserId.length !== 36 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        value.otherUserId,
      )
    )
      reject();
    return { resource: 'createDirect' };
  }
  if (path === '/conversations/game' && method === 'POST') {
    if (!keyPattern.test(headers.get('idempotency-key') ?? '') || typeof init?.body !== 'string')
      reject();
    let body: unknown;
    try {
      body = JSON.parse(init.body);
    } catch {
      reject();
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) reject();
    const value = body as Record<string, unknown>;
    if (
      Object.keys(value).length !== 1 ||
      typeof value.gameId !== 'string' ||
      value.gameId.length !== 36 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        value.gameId,
      )
    )
      reject();
    return { resource: 'createGame' };
  }
  const match = new RegExp(
    `^/conversations/(${uuid})/(messages|read-cursor|notification-policy)$`,
    'i',
  ).exec(path);
  if (!match || method !== (match[2] === 'messages' ? 'POST' : 'PUT')) reject();
  if (!keyPattern.test(headers.get('idempotency-key') ?? '') || typeof init?.body !== 'string')
    reject();
  let body: unknown;
  try {
    body = JSON.parse(init.body);
  } catch {
    reject();
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) reject();
  const data = body as Record<string, unknown>;
  const keys = Object.keys(data);
  if (match[2] === 'messages') {
    if (
      keys.length !== 2 ||
      !keys.every((key) => ['clientMessageId', 'body'].includes(key)) ||
      typeof data.clientMessageId !== 'string' ||
      !keyPattern.test(data.clientMessageId) ||
      data.clientMessageId !== headers.get('idempotency-key') ||
      typeof data.body !== 'string' ||
      !data.body.trim() ||
      data.body.length > 8000
    )
      reject();
  } else if (match[2] === 'read-cursor') {
    if (
      keys.length !== 1 ||
      keys[0] !== 'throughSequence' ||
      typeof data.throughSequence !== 'number' ||
      !Number.isSafeInteger(data.throughSequence) ||
      data.throughSequence < 0
    )
      reject();
  } else {
    if (
      !keys.every((key) => ['level', 'mutedUntil'].includes(key)) ||
      !['ALL', 'MENTIONS', 'NONE'].includes(String(data.level))
    )
      reject();
    if (data.mutedUntil != null) {
      if (typeof data.mutedUntil !== 'string') reject();
      const instant = Date.parse(data.mutedUntil);
      if (
        !Number.isFinite(instant) ||
        instant <= Date.now() ||
        instant > Date.now() + maximumMuteMs
      )
        reject();
    }
  }
  return {
    resource:
      match[2] === 'messages'
        ? 'sendMessage'
        : match[2] === 'read-cursor'
          ? 'messageReadCursor'
          : 'conversationPolicy',
    resourceId: match[1]!,
  };
}
