import type { CreateGameRequest } from './auth-gateway.js';

const ATTEMPT_VERSION = 2 as const;
const ATTEMPT_STORAGE_PREFIX = 'phub.create-game-attempt.v2';
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,200}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEVELS = ['D', 'D+', 'C', 'C+', 'B', 'B+', 'A'] as const;

export interface CreateGameAttemptPrincipal {
  readonly tenantId: string;
  readonly userId: string;
}

export interface PendingCreateGameAttempt {
  readonly version: typeof ATTEMPT_VERSION;
  readonly recoveryState: 'PENDING';
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly payloadFingerprint: string;
  readonly createdAt: string;
  readonly payload: CreateGameRequest;
}

export interface CreateGameAttemptLockManager {
  request<TResult>(
    name: string,
    options: { readonly mode: 'exclusive' },
    callback: () => TResult | PromiseLike<TResult>,
  ): Promise<TResult>;
}

export type CreateGameAttemptErrorCode =
  | 'ATTEMPT_STORAGE_UNAVAILABLE'
  | 'ATTEMPT_LOCK_UNAVAILABLE'
  | 'ATTEMPT_CRYPTO_UNAVAILABLE'
  | 'ATTEMPT_MALFORMED'
  | 'ATTEMPT_FOREIGN_PRINCIPAL'
  | 'ATTEMPT_PAYLOAD_CHANGED'
  | 'ATTEMPT_STATE_CHANGED';

export class CreateGameAttemptError extends Error {
  public constructor(public readonly code: CreateGameAttemptErrorCode) {
    super(code);
    this.name = 'CreateGameAttemptError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isLevel(value: unknown): value is (typeof LEVELS)[number] {
  return typeof value === 'string' && LEVELS.includes(value as (typeof LEVELS)[number]);
}

export function normalizeCreateGamePayload(input: CreateGameRequest): CreateGameRequest {
  return {
    title: input.title.trim(),
    kind: input.kind,
    visibility: input.visibility,
    stationId: input.stationId,
    ...(input.courtId === undefined ? {} : { courtId: input.courtId }),
    startsAt: new Date(input.startsAt).toISOString(),
    endsAt: new Date(input.endsAt).toISOString(),
    timezone: input.timezone,
    capacity: input.capacity,
    levelRange:
      input.levelRange === undefined || input.levelRange === null
        ? null
        : { from: input.levelRange.from, to: input.levelRange.to },
    paymentMode: input.paymentMode,
    waitlistEnabled: input.waitlistEnabled,
  };
}

function parsePayload(value: unknown): CreateGameRequest | null {
  if (!isRecord(value)) return null;
  if (
    !hasOnlyKeys(value, [
      'title',
      'kind',
      'visibility',
      'stationId',
      'courtId',
      'startsAt',
      'endsAt',
      'timezone',
      'capacity',
      'levelRange',
      'paymentMode',
      'waitlistEnabled',
    ]) ||
    !isString(value.title) ||
    !['FRIENDLY', 'RATING', 'PRIVATE', 'COACH_GAME'].includes(String(value.kind)) ||
    !['PUBLIC', 'PRIVATE', 'COMMUNITY'].includes(String(value.visibility)) ||
    !isString(value.stationId) ||
    !UUID_PATTERN.test(value.stationId) ||
    !(
      value.courtId === undefined ||
      value.courtId === null ||
      (isString(value.courtId) && UUID_PATTERN.test(value.courtId))
    ) ||
    !isString(value.startsAt) ||
    Number.isNaN(Date.parse(value.startsAt)) ||
    !isString(value.endsAt) ||
    Number.isNaN(Date.parse(value.endsAt)) ||
    !isString(value.timezone) ||
    ![2, 4].includes(Number(value.capacity)) ||
    value.paymentMode !== 'NO_PAYMENT' ||
    typeof value.waitlistEnabled !== 'boolean'
  ) {
    return null;
  }

  let levelRange: CreateGameRequest['levelRange'] = null;
  if (value.levelRange !== undefined && value.levelRange !== null) {
    if (
      !isRecord(value.levelRange) ||
      !hasOnlyKeys(value.levelRange, ['from', 'to']) ||
      !isLevel(value.levelRange.from) ||
      !isLevel(value.levelRange.to)
    ) {
      return null;
    }
    levelRange = { from: value.levelRange.from, to: value.levelRange.to };
  }

  try {
    return normalizeCreateGamePayload({
      title: value.title,
      kind: value.kind as CreateGameRequest['kind'],
      visibility: value.visibility as CreateGameRequest['visibility'],
      stationId: value.stationId,
      ...(value.courtId === undefined ? {} : { courtId: value.courtId }),
      startsAt: value.startsAt,
      endsAt: value.endsAt,
      timezone: value.timezone,
      capacity: value.capacity as CreateGameRequest['capacity'],
      levelRange,
      paymentMode: 'NO_PAYMENT',
      waitlistEnabled: value.waitlistEnabled,
    });
  } catch {
    return null;
  }
}

function canonicalPayload(input: CreateGameRequest): string {
  return JSON.stringify(normalizeCreateGamePayload(input));
}

async function payloadFingerprint(input: CreateGameRequest): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new CreateGameAttemptError('ATTEMPT_CRYPTO_UNAVAILABLE');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonicalPayload(input)));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

export function createGameAttemptStorageKey(principal: CreateGameAttemptPrincipal): string {
  return `${ATTEMPT_STORAGE_PREFIX}:${encodeURIComponent(principal.tenantId)}:${encodeURIComponent(principal.userId)}`;
}

function createGameAttemptLockName(principal: CreateGameAttemptPrincipal): string {
  return `${createGameAttemptStorageKey(principal)}:owner`;
}

function readRaw(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    throw new CreateGameAttemptError('ATTEMPT_STORAGE_UNAVAILABLE');
  }
}

function parseAttempt(
  raw: string,
  principal: CreateGameAttemptPrincipal,
): PendingCreateGameAttempt {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CreateGameAttemptError('ATTEMPT_MALFORMED');
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'version',
      'recoveryState',
      'tenantId',
      'actorUserId',
      'idempotencyKey',
      'payloadFingerprint',
      'createdAt',
      'payload',
    ]) ||
    value.version !== ATTEMPT_VERSION ||
    value.recoveryState !== 'PENDING' ||
    !isString(value.tenantId) ||
    !isString(value.actorUserId) ||
    !isString(value.idempotencyKey) ||
    !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey) ||
    !isString(value.payloadFingerprint) ||
    !SHA256_PATTERN.test(value.payloadFingerprint) ||
    !isString(value.createdAt) ||
    Number.isNaN(Date.parse(value.createdAt))
  ) {
    throw new CreateGameAttemptError('ATTEMPT_MALFORMED');
  }
  if (value.tenantId !== principal.tenantId || value.actorUserId !== principal.userId) {
    throw new CreateGameAttemptError('ATTEMPT_FOREIGN_PRINCIPAL');
  }
  const payload = parsePayload(value.payload);
  if (!payload) throw new CreateGameAttemptError('ATTEMPT_MALFORMED');
  return {
    version: ATTEMPT_VERSION,
    recoveryState: 'PENDING',
    tenantId: value.tenantId,
    actorUserId: value.actorUserId,
    idempotencyKey: value.idempotencyKey,
    payloadFingerprint: value.payloadFingerprint,
    createdAt: value.createdAt,
    payload,
  };
}

function writeAttempt(
  storage: Storage,
  principal: CreateGameAttemptPrincipal,
  attempt: PendingCreateGameAttempt,
): void {
  try {
    storage.setItem(createGameAttemptStorageKey(principal), JSON.stringify(attempt));
  } catch {
    throw new CreateGameAttemptError('ATTEMPT_STORAGE_UNAVAILABLE');
  }
}

export function loadCreateGameAttempt(
  principal: CreateGameAttemptPrincipal,
  storage: Storage,
): PendingCreateGameAttempt | null {
  const raw = readRaw(storage, createGameAttemptStorageKey(principal));
  return raw === null ? null : parseAttempt(raw, principal);
}

export function browserCreateGameAttemptLockManager(): CreateGameAttemptLockManager | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const candidate = (navigator as Navigator & { readonly locks?: CreateGameAttemptLockManager })
    .locks;
  return candidate && typeof candidate.request === 'function' ? candidate : undefined;
}

async function withAttemptLock<TResult>(
  principal: CreateGameAttemptPrincipal,
  lockManager: CreateGameAttemptLockManager | undefined,
  callback: () => TResult | PromiseLike<TResult>,
): Promise<TResult> {
  if (!lockManager) throw new CreateGameAttemptError('ATTEMPT_LOCK_UNAVAILABLE');
  try {
    return await lockManager.request(
      createGameAttemptLockName(principal),
      { mode: 'exclusive' },
      callback,
    );
  } catch (error) {
    if (error instanceof CreateGameAttemptError) throw error;
    throw new CreateGameAttemptError('ATTEMPT_LOCK_UNAVAILABLE');
  }
}

export async function prepareCreateGameAttempt(
  principal: CreateGameAttemptPrincipal,
  input: CreateGameRequest,
  storage: Storage,
  lockManager: CreateGameAttemptLockManager | undefined,
  options: {
    readonly now?: () => Date;
    readonly createIdempotencyKey?: () => string;
  } = {},
): Promise<PendingCreateGameAttempt> {
  const payload = normalizeCreateGamePayload(input);
  const fingerprint = await payloadFingerprint(payload);
  return withAttemptLock(principal, lockManager, async () => {
    const existing = loadCreateGameAttempt(principal, storage);
    if (existing) {
      const persistedFingerprint = await payloadFingerprint(existing.payload);
      if (persistedFingerprint !== existing.payloadFingerprint) {
        throw new CreateGameAttemptError('ATTEMPT_MALFORMED');
      }
      if (existing.payloadFingerprint !== fingerprint) {
        throw new CreateGameAttemptError('ATTEMPT_PAYLOAD_CHANGED');
      }
      return existing;
    }

    const createIdempotencyKey =
      options.createIdempotencyKey ??
      (() => {
        if (typeof globalThis.crypto?.randomUUID !== 'function') {
          throw new CreateGameAttemptError('ATTEMPT_CRYPTO_UNAVAILABLE');
        }
        return globalThis.crypto.randomUUID();
      });
    const idempotencyKey = createIdempotencyKey();
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new CreateGameAttemptError('ATTEMPT_MALFORMED');
    }
    const attempt: PendingCreateGameAttempt = {
      version: ATTEMPT_VERSION,
      recoveryState: 'PENDING',
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      idempotencyKey,
      payloadFingerprint: fingerprint,
      createdAt: (options.now?.() ?? new Date()).toISOString(),
      payload,
    };
    writeAttempt(storage, principal, attempt);
    return attempt;
  });
}

export async function clearCreateGameAttempt(
  principal: CreateGameAttemptPrincipal,
  attempt: PendingCreateGameAttempt,
  storage: Storage,
  lockManager: CreateGameAttemptLockManager | undefined,
): Promise<void> {
  await withAttemptLock(principal, lockManager, () => {
    const current = loadCreateGameAttempt(principal, storage);
    if (!current) return;
    if (
      current.idempotencyKey !== attempt.idempotencyKey ||
      current.payloadFingerprint !== attempt.payloadFingerprint
    ) {
      throw new CreateGameAttemptError('ATTEMPT_STATE_CHANGED');
    }
    try {
      storage.removeItem(createGameAttemptStorageKey(principal));
    } catch {
      throw new CreateGameAttemptError('ATTEMPT_STORAGE_UNAVAILABLE');
    }
  });
}
