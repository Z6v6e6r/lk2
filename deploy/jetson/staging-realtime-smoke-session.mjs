import {
  closeSync,
  constants,
  fchmodSync,
  fdatasyncSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = 'https://lk.nano.padlhub.su';
const TENANT_KEY = 'local-padel';
const EXPECTED_DISPLAY_NAME = 'Staging Realtime Smoke';
const REFRESH_PATH = `/user/api/v1/${TENANT_KEY}/auth/session/refresh`;
const TICKET_PATH = `/user/api/v1/${TENANT_KEY}/messaging/realtime-ticket`;
const REALTIME_PATH = `/realtime/v1/${TENANT_KEY}`;
const STATE_KEYS = [
  'expectedPermissions',
  'expectedPhoneLast4',
  'expectedRoles',
  'expectedTenantId',
  'expectedUserId',
  'generation',
  'lastRotatedAt',
  'pendingIdempotencyKey',
  'refreshExpiresAt',
  'refreshToken',
  'tenantKey',
  'version',
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/u;
const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_RESPONSE_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 10_000;

class SmokeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SmokeError';
  }
}

function fail(code) {
  throw new SmokeError(code);
}

function maybeFail(options, point) {
  if (options.failAfter === point) {
    fail(`SMOKE_FAILPOINT_${point.toUpperCase().replaceAll('-', '_')}`);
  }
}

function exactStringArray(value, expected, code) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) fail(code);
  if (value.length !== expected.length) fail(code);
  for (let index = 0; index < expected.length; index += 1) {
    if (value[index] !== expected[index]) fail(code);
  }
}

function safeStatePath(pathInput) {
  const statePath = resolve(pathInput);
  const stateDirectory = dirname(statePath);
  const directory = lstatSync(stateDirectory);
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.nlink < 2 ||
    (directory.mode & 0o777) !== 0o700 ||
    directory.uid !== uid ||
    directory.gid !== gid
  ) {
    fail('SMOKE_STATE_DIRECTORY_UNSAFE');
  }
  for (const entry of readdirSync(stateDirectory)) {
    if (entry === 'session.json' || entry === 'session.lock') continue;
    if (
      !/^session\.json\.next-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        entry,
      )
    ) {
      fail('SMOKE_STATE_DIRECTORY_CONTENT_INVALID');
    }
    const orphanPath = resolve(stateDirectory, entry);
    const orphan = lstatSync(orphanPath);
    if (
      !orphan.isFile() ||
      orphan.isSymbolicLink() ||
      orphan.nlink !== 1 ||
      (orphan.mode & 0o777) !== 0o600 ||
      orphan.uid !== uid ||
      orphan.gid !== gid ||
      orphan.size > 16_384
    ) {
      fail('SMOKE_STATE_ORPHAN_UNSAFE');
    }
    try {
      unlinkSync(orphanPath);
    } catch {
      fail('SMOKE_STATE_ORPHAN_RECOVERY_FAILED');
    }
  }
  const recoveryDirectoryDescriptor = openSync(stateDirectory, constants.O_RDONLY);
  try {
    fsyncSync(recoveryDirectoryDescriptor);
  } finally {
    closeSync(recoveryDirectoryDescriptor);
  }
  const state = lstatSync(statePath);
  if (
    !state.isFile() ||
    state.isSymbolicLink() ||
    state.nlink !== 1 ||
    (state.mode & 0o777) !== 0o600 ||
    state.uid !== uid ||
    state.gid !== gid ||
    state.size < 128 ||
    state.size > 16_384
  ) {
    fail('SMOKE_STATE_FILE_UNSAFE');
  }
  return { statePath, stateDirectory, uid, gid };
}

function parseState(statePath) {
  let value;
  try {
    value = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    fail('SMOKE_STATE_INVALID');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SMOKE_STATE_INVALID');
  if (Object.keys(value).sort().join('\n') !== STATE_KEYS.join('\n'))
    fail('SMOKE_STATE_SHAPE_INVALID');
  if (
    value.version !== 1 ||
    value.tenantKey !== TENANT_KEY ||
    !/^[0-9]{4}$/u.test(value.expectedPhoneLast4) ||
    !UUID_PATTERN.test(value.expectedTenantId) ||
    !UUID_PATTERN.test(value.expectedUserId) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    !REFRESH_TOKEN_PATTERN.test(value.refreshToken) ||
    (value.lastRotatedAt !== null && !Number.isFinite(Date.parse(value.lastRotatedAt))) ||
    (value.refreshExpiresAt !== null && !Number.isFinite(Date.parse(value.refreshExpiresAt))) ||
    (value.lastRotatedAt === null) !== (value.refreshExpiresAt === null) ||
    (value.lastRotatedAt !== null &&
      Date.parse(value.refreshExpiresAt) <= Date.parse(value.lastRotatedAt)) ||
    (value.pendingIdempotencyKey !== null && !UUID_PATTERN.test(value.pendingIdempotencyKey))
  ) {
    fail('SMOKE_STATE_CONTENT_INVALID');
  }
  exactStringArray(value.expectedRoles, ['client'], 'SMOKE_STATE_ROLES_INVALID');
  exactStringArray(
    value.expectedPermissions,
    ['chat.direct.create'],
    'SMOKE_STATE_PERMISSIONS_INVALID',
  );
  return value;
}

function writeStateAtomic(paths, state, randomUuid) {
  const suffix = randomUuid();
  if (!UUID_PATTERN.test(suffix)) fail('SMOKE_RANDOM_UUID_INVALID');
  const temporary = `${paths.statePath}.next-${suffix}`;
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(state)}\n`, { encoding: 'utf8' });
    fdatasyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, paths.statePath);
    const directoryDescriptor = openSync(paths.stateDirectory, constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the fixed, content-free write failure below.
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary may not have been created or may already have been renamed.
    }
    fail('SMOKE_STATE_WRITE_FAILED');
  }
}

function decodeAccessToken(token) {
  if (typeof token !== 'string' || token.length < 64 || token.length > 8_192) {
    fail('SMOKE_ACCESS_TOKEN_INVALID');
  }
  const segments = token.split('.');
  if (segments.length !== 3 || segments.some((segment) => !TOKEN_PATTERN.test(segment))) {
    fail('SMOKE_ACCESS_TOKEN_INVALID');
  }
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(segments[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    fail('SMOKE_ACCESS_TOKEN_INVALID');
  }
  if (header?.alg !== 'HS256' || header?.typ !== 'JWT') fail('SMOKE_ACCESS_TOKEN_HEADER_INVALID');
  return payload;
}

function assertSessionBody(body, state, nowMs) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('SMOKE_SESSION_BODY_INVALID');
  if (body.tokenType !== 'Bearer') fail('SMOKE_SESSION_TOKEN_TYPE_INVALID');
  if (body.user?.id !== state.expectedUserId || body.user?.displayName !== EXPECTED_DISPLAY_NAME) {
    fail('SMOKE_SESSION_USER_INVALID');
  }
  if (
    body.context?.tenantId !== state.expectedTenantId ||
    body.context?.userId !== state.expectedUserId ||
    body.context?.displayName !== EXPECTED_DISPLAY_NAME ||
    body.context?.phoneLast4 !== state.expectedPhoneLast4
  ) {
    fail('SMOKE_SESSION_CONTEXT_INVALID');
  }
  exactStringArray(body.context.roles, state.expectedRoles, 'SMOKE_SESSION_ROLES_INVALID');
  exactStringArray(
    body.context.permissions,
    state.expectedPermissions,
    'SMOKE_SESSION_PERMISSIONS_INVALID',
  );
  const payload = decodeAccessToken(body.accessToken);
  if (
    payload.iss !== 'phub-identity' ||
    payload.aud !== 'phub-api' ||
    payload.sub !== state.expectedUserId ||
    !UUID_PATTERN.test(payload.sid) ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp * 1000 <= nowMs + 15_000 ||
    payload.exp * 1000 > nowMs + 15 * 60_000
  ) {
    fail('SMOKE_ACCESS_TOKEN_CLAIMS_INVALID');
  }
  exactStringArray(payload.tenants, [state.expectedTenantId], 'SMOKE_ACCESS_TENANTS_INVALID');
  exactStringArray(payload.roles, state.expectedRoles, 'SMOKE_ACCESS_ROLES_INVALID');
  exactStringArray(
    payload.permissions,
    state.expectedPermissions,
    'SMOKE_ACCESS_PERMISSIONS_INVALID',
  );
  return body.accessToken;
}

function responseCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const value = headers.get('set-cookie');
  return value === null ? [] : [value];
}

function rotatedRefreshCredential(response, currentToken) {
  const cookies = responseCookies(response.headers);
  if (cookies.length !== 1 || cookies[0].includes('\r') || cookies[0].includes('\n')) {
    fail('SMOKE_REFRESH_COOKIE_COUNT_INVALID');
  }
  const parts = cookies[0].split(';').map((part) => part.trim());
  const pair = parts.shift();
  const match = /^phub_refresh=([A-Za-z0-9_-]{43})$/u.exec(pair ?? '');
  if (!match || match[1] === currentToken) fail('SMOKE_REFRESH_COOKIE_INVALID');
  const attributes = new Set(parts.map((part) => part.toLowerCase()));
  if (
    parts.length !== 5 ||
    attributes.size !== 5 ||
    !attributes.has('httponly') ||
    !attributes.has('secure') ||
    !attributes.has('samesite=lax') ||
    !attributes.has(`path=${REFRESH_PATH.slice(0, -'/session/refresh'.length)}`) ||
    ![...attributes].some((attribute) => /^max-age=[1-9][0-9]*$/u.test(attribute)) ||
    [...attributes].some(
      (attribute) =>
        attribute !== 'httponly' &&
        attribute !== 'secure' &&
        attribute !== 'samesite=lax' &&
        attribute !== `path=${REFRESH_PATH.slice(0, -'/session/refresh'.length)}` &&
        !/^max-age=[1-9][0-9]*$/u.test(attribute),
    )
  ) {
    fail('SMOKE_REFRESH_COOKIE_ATTRIBUTES_INVALID');
  }
  const maxAge = Number(
    [...attributes].find((attribute) => /^max-age=[1-9][0-9]*$/u.test(attribute))?.slice(8),
  );
  if (!Number.isSafeInteger(maxAge) || maxAge < 60 || maxAge > 60 * 24 * 60 * 60) {
    fail('SMOKE_REFRESH_COOKIE_MAX_AGE_INVALID');
  }
  return { refreshToken: match[1], maxAgeSeconds: maxAge };
}

async function boundedJson(response, code) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    fail(code);
  }
  let source;
  try {
    source = await response.text();
  } catch {
    fail(code);
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_RESPONSE_BYTES) fail(code);
  try {
    return JSON.parse(source);
  } catch {
    fail(code);
  }
}

async function refreshSession(state, idempotencyKey, options) {
  let response;
  try {
    response = await options.fetchImpl(new URL(REFRESH_PATH, BASE_URL), {
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Cookie: `phub_refresh=${state.refreshToken}`,
        'Idempotency-Key': idempotencyKey,
        Origin: BASE_URL,
        'X-App-Platform': 'web',
        'X-App-Version': 'staging-realtime-smoke-session-v1',
        'X-Correlation-ID': options.randomUuid(),
        'X-Session-Intent': 'refresh',
      },
      body: '{}',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    fail('SMOKE_REFRESH_NETWORK_FAILED');
  }
  if (response.status !== 200) fail(`SMOKE_REFRESH_HTTP_${response.status}`);
  if (response.headers.get('cache-control') !== 'no-store') fail('SMOKE_REFRESH_CACHE_INVALID');
  const nextRefreshCredential = rotatedRefreshCredential(response, state.refreshToken);
  const body = await boundedJson(response, 'SMOKE_SESSION_BODY_INVALID');
  const accessToken = assertSessionBody(body, state, options.now());
  return { nextRefreshCredential, accessToken };
}

async function requestTicket(accessToken, options) {
  let response;
  try {
    response = await options.fetchImpl(new URL(TICKET_PATH, BASE_URL), {
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'X-App-Platform': 'web',
        'X-App-Version': 'staging-realtime-smoke-session-v1',
        'X-Correlation-ID': options.randomUuid(),
      },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    fail('SMOKE_TICKET_NETWORK_FAILED');
  }
  if (response.status !== 200) fail(`SMOKE_TICKET_HTTP_${response.status}`);
  if (response.headers.get('cache-control') !== 'no-store') fail('SMOKE_TICKET_CACHE_INVALID');
  const body = await boundedJson(response, 'SMOKE_TICKET_BODY_INVALID');
  if (
    typeof body?.ticket !== 'string' ||
    body.ticket.length < 32 ||
    body.ticket.length > 4_096 ||
    typeof body.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(body.expiresAt))
  ) {
    fail('SMOKE_TICKET_BODY_INVALID');
  }
  return body.ticket;
}

async function connectRealtime(ticket, options) {
  const socketFactory =
    options.socketFactory ??
    ((url) => {
      if (typeof globalThis.WebSocket !== 'function') fail('SMOKE_WEBSOCKET_UNAVAILABLE');
      return new globalThis.WebSocket(url);
    });
  const socket = socketFactory(new URL(REALTIME_PATH, 'wss://lk.nano.padlhub.su'));
  await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        try {
          socket.close(1008, 'Smoke verification failed');
        } catch {
          // The fixed failure remains authoritative even if close also fails.
        }
        rejectPromise(error);
      } else {
        try {
          socket.close(1000, 'Smoke verification complete');
        } catch {
          // Successful authentication is already established.
        }
        resolvePromise();
      }
    };
    const timer = setTimeout(
      () => finish(new SmokeError('SMOKE_WEBSOCKET_TIMEOUT')),
      options.timeoutMs,
    );
    socket.addEventListener('open', () => {
      try {
        socket.send(JSON.stringify({ type: 'authenticate', ticket }));
      } catch {
        finish(new SmokeError('SMOKE_WEBSOCKET_SEND_FAILED'));
      }
    });
    socket.addEventListener('message', (event) => {
      const source = typeof event.data === 'string' ? event.data : '';
      if (!source || Buffer.byteLength(source, 'utf8') > 16_384) {
        finish(new SmokeError('SMOKE_WEBSOCKET_MESSAGE_INVALID'));
        return;
      }
      let message;
      try {
        message = JSON.parse(source);
      } catch {
        finish(new SmokeError('SMOKE_WEBSOCKET_MESSAGE_INVALID'));
        return;
      }
      if (message?.type === 'connection.ready') finish();
    });
    socket.addEventListener('error', () => finish(new SmokeError('SMOKE_WEBSOCKET_ERROR')));
    socket.addEventListener('close', (event) => {
      if (!settled) finish(new SmokeError(`SMOKE_WEBSOCKET_CLOSED_${event.code}`));
    });
  });
}

export async function runStagingRealtimeSmokeSession(options) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) {
    fail('SMOKE_TIMEOUT_INVALID');
  }
  const paths = safeStatePath(options.statePath);
  let state = parseState(paths.statePath);
  const nowMs = (options.now ?? Date.now)();
  if (
    state.pendingIdempotencyKey === null &&
    state.refreshExpiresAt !== null &&
    Date.parse(state.refreshExpiresAt) <= nowMs + 15_000
  ) {
    fail('SMOKE_REFRESH_EXPIRED');
  }
  const randomUuid = options.randomUuid ?? randomUUID;
  const idempotencyKey = state.pendingIdempotencyKey ?? randomUuid();
  if (!UUID_PATTERN.test(idempotencyKey)) fail('SMOKE_IDEMPOTENCY_KEY_INVALID');
  if (state.pendingIdempotencyKey === null) {
    state = { ...state, pendingIdempotencyKey: idempotencyKey };
    writeStateAtomic(paths, state, randomUuid);
    maybeFail(options, 'pending-write');
  }
  const execution = {
    fetchImpl: options.fetchImpl ?? fetch,
    now: () => nowMs,
    randomUuid,
    socketFactory: options.socketFactory,
    timeoutMs,
  };
  const refreshed = await refreshSession(state, idempotencyKey, execution);
  maybeFail(options, 'refresh-response');
  const nextState = {
    ...state,
    generation: state.generation + 1,
    lastRotatedAt: new Date(nowMs).toISOString(),
    pendingIdempotencyKey: null,
    refreshExpiresAt: new Date(
      nowMs + refreshed.nextRefreshCredential.maxAgeSeconds * 1000,
    ).toISOString(),
    refreshToken: refreshed.nextRefreshCredential.refreshToken,
  };
  writeStateAtomic(paths, nextState, randomUuid);
  maybeFail(options, 'successor-write');
  const ticket = await requestTicket(refreshed.accessToken, execution);
  maybeFail(options, 'ticket-response');
  await connectRealtime(ticket, execution);
  return { status: 'passed', generation: nextState.generation };
}

function cli() {
  const statePath = process.argv[2];
  if (!statePath || process.argv.length !== 3) fail('SMOKE_USAGE_INVALID');
  return runStagingRealtimeSmokeSession({ statePath });
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  try {
    await cli();
    process.stdout.write(
      'staging_realtime_smoke_session tenant=local-padel credential_rotated=true authenticated=true mutation=ephemeral-ticket-only status=passed\n',
    );
  } catch (error) {
    const code = error instanceof SmokeError ? error.message : 'SMOKE_INTERNAL_ERROR';
    process.stderr.write(`staging_realtime_smoke_session status=failed code=${code}\n`);
    process.exitCode = 1;
  }
}
