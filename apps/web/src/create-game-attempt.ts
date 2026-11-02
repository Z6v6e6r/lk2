import type { CreateGameRequest } from './auth-gateway.js';

export const CREATE_GAME_ATTEMPT_LEDGER_VERSION = 4 as const;
const LEDGER_VERSION = CREATE_GAME_ATTEMPT_LEDGER_VERSION;
/**
 * Earlier envelopes stay readable so an in-flight attempt survives a deploy: recovery must keep the
 * original key instead of stranding the operation. They never carried a managed confirmation, so a
 * legacy `PENDING_CONFIRMATION` record is malformed, and every write upgrades to the current version.
 */
const LEGACY_LEDGER_VERSIONS: ReadonlySet<unknown> = new Set([3]);
/**
 * Accepted deviation from the "unknown version fails closed" rule: an in-flight attempt written by
 * the previous release must keep its original key instead of being stranded after a deploy. A legacy
 * envelope is therefore readable ONLY with the exact semantics that release could produce — a
 * free-only `PENDING` attempt — and every write upgrades the envelope to the current version.
 */
const legacyLedgerVersion3 = 3 as const;
// Keep the principal-scoped key stable so an older mounted tab fails closed on the v3 envelope.
const ATTEMPT_STORAGE_PREFIX = 'phub.create-game-attempt.v2';
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,200}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEVELS = ['D', 'D+', 'C', 'C+', 'B', 'B+', 'A'] as const;
const RESOLVED_SAFETY_WINDOW_MS = 24 * 60 * 60_000;
const MAX_RESOLVED_ATTEMPTS = 32;

export interface CreateGameAttemptPrincipal {
  readonly tenantId: string;
  readonly userId: string;
}

export interface PendingCreateGameAttempt {
  readonly state: 'PENDING';
  readonly attemptId: string;
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly payloadFingerprint: string;
  readonly createdAt: string;
  readonly startsAt: string;
  readonly payload: CreateGameRequest;
}

export interface ResolvedCreateGameAttempt {
  readonly state: 'RESOLVED';
  readonly attemptId: string;
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly payloadFingerprint: string;
  readonly gameId: string;
  readonly resolvedAt: string;
  readonly expiresAt: string;
}

/**
 * Managed commercial CREATE accepted by the server (`202 CREATE_GAME`, status UNKNOWN/PROCESSING):
 * the game aggregate exists in `PROVISIONING` and the operation is unresolved. The browser keeps
 * the attempt (and its original idempotency key) so recovery is a readback of the same operation,
 * never a replacement POST.
 */
export interface PendingConfirmationCreateGameAttempt {
  readonly state: 'PENDING_CONFIRMATION';
  readonly attemptId: string;
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly payloadFingerprint: string;
  readonly createdAt: string;
  readonly startsAt: string;
  readonly payload: CreateGameRequest;
  readonly gameId: string;
  readonly operationId: string;
  readonly paymentMode: 'SPLIT' | 'SUBSCRIPTION';
}

export type ActiveCreateGameAttempt =
  PendingCreateGameAttempt | PendingConfirmationCreateGameAttempt;

export type CreateGameAttempt = ActiveCreateGameAttempt | ResolvedCreateGameAttempt;

export interface CreateGameAttemptLedger {
  readonly version: typeof LEDGER_VERSION;
  readonly activeAttempt?: ActiveCreateGameAttempt;
  readonly resolvedAttempts: readonly ResolvedCreateGameAttempt[];
}

export function isPendingConfirmationAttempt(
  attempt: CreateGameAttempt | null | undefined,
): attempt is PendingConfirmationCreateGameAttempt {
  return attempt?.state === 'PENDING_CONFIRMATION';
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
  | 'ATTEMPT_STATE_CHANGED'
  | 'ATTEMPT_HISTORY_FULL';

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
    ...(input.subscriptionInstanceId === undefined
      ? {}
      : { subscriptionInstanceId: input.subscriptionInstanceId }),
    ...(input.priceConsent === undefined
      ? {}
      : {
          priceConsent: {
            amountMinor: input.priceConsent.amountMinor,
            currency: input.priceConsent.currency,
          },
        }),
  };
}

type ManagedPaymentMode = 'SPLIT' | 'SUBSCRIPTION';

function parseManagedPaymentMode(value: unknown): 'NO_PAYMENT' | ManagedPaymentMode | null {
  if (value === 'NO_PAYMENT' || value === 'SPLIT' || value === 'SUBSCRIPTION') return value;
  return null;
}

function parsePriceConsent(
  value: unknown,
): { readonly amountMinor: number; readonly currency: 'RUB' } | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['amountMinor', 'currency'])) return null;
  if (
    !Number.isSafeInteger(value.amountMinor) ||
    Number(value.amountMinor) < 0 ||
    value.currency !== 'RUB'
  ) {
    return null;
  }
  return { amountMinor: Number(value.amountMinor), currency: 'RUB' };
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
      'subscriptionInstanceId',
      'priceConsent',
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
    parseManagedPaymentMode(value.paymentMode) === null ||
    typeof value.waitlistEnabled !== 'boolean'
  ) {
    return null;
  }
  const paymentMode = parseManagedPaymentMode(value.paymentMode);
  if (paymentMode === null) return null;
  if (paymentMode === 'NO_PAYMENT' && value.subscriptionInstanceId !== undefined) return null;
  if (paymentMode === 'NO_PAYMENT' && value.priceConsent !== undefined) return null;
  if (
    value.subscriptionInstanceId !== undefined &&
    (!isString(value.subscriptionInstanceId) || !UUID_PATTERN.test(value.subscriptionInstanceId))
  ) {
    return null;
  }
  const priceConsent =
    value.priceConsent === undefined ? undefined : parsePriceConsent(value.priceConsent);
  if (value.priceConsent !== undefined && priceConsent === null) return null;

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
      paymentMode,
      waitlistEnabled: value.waitlistEnabled,
      ...(value.subscriptionInstanceId === undefined
        ? {}
        : { subscriptionInstanceId: value.subscriptionInstanceId }),
      ...(priceConsent === undefined || priceConsent === null ? {} : { priceConsent }),
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

function parsePrincipalFields(
  value: Record<string, unknown>,
  principal: CreateGameAttemptPrincipal,
): { tenantId: string; actorUserId: string } {
  if (!isString(value.tenantId) || !isString(value.actorUserId)) {
    throw new CreateGameAttemptError('ATTEMPT_MALFORMED');
  }
  if (value.tenantId !== principal.tenantId || value.actorUserId !== principal.userId) {
    throw new CreateGameAttemptError('ATTEMPT_FOREIGN_PRINCIPAL');
  }
  return { tenantId: value.tenantId, actorUserId: value.actorUserId };
}

function parsePending(
  value: unknown,
  principal: CreateGameAttemptPrincipal,
): PendingCreateGameAttempt {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'state',
      'attemptId',
      'tenantId',
      'actorUserId',
      'idempotencyKey',
      'payloadFingerprint',
      'createdAt',
      'startsAt',
      'payload',
    ]) ||
    value.state !== 'PENDING' ||
    !isString(value.attemptId) ||
    !UUID_PATTERN.test(value.attemptId) ||
    !isString(value.idempotencyKey) ||
    !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey) ||
    !isString(value.payloadFingerprint) ||
    !SHA256_PATTERN.test(value.payloadFingerprint) ||
    !isString(value.createdAt) ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    !isString(value.startsAt) ||
    Number.isNaN(Date.parse(value.startsAt))
  ) {
    throw new CreateGameAttemptError('ATTEMPT_MALFORMED');
  }
  const { tenantId, actorUserId } = parsePrincipalFields(value, principal);
  const payload = parsePayload(value.payload);
  if (!payload || payload.startsAt !== new Date(value.startsAt).toISOString()) {
    throw new CreateGameAttemptError('ATTEMPT_MALFORMED');
  }
  return {
    state: 'PENDING',
    attemptId: value.attemptId,
    tenantId,
    actorUserId,
    idempotencyKey: value.idempotencyKey,
    payloadFingerprint: value.payloadFingerprint,
    createdAt: new Date(value.createdAt).toISOString(),
    startsAt: payload.startsAt,
    payload,
  };
}

function parsePendingConfirmation(
  value: unknown,
  principal: CreateGameAttemptPrincipal,
): PendingConfirmationCreateGameAttempt {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'state',
      'attemptId',
      'tenantId',
      'actorUserId',
      'idempotencyKey',
      'payloadFingerprint',
      'createdAt',
      'startsAt',
      'payload',
      'gameId',
      'operationId',
      'paymentMode',
    ]) ||
    value.state !== 'PENDING_CONFIRMATION' ||
    !isString(value.attemptId) ||
    !UUID_PATTERN.test(value.attemptId) ||
    !isString(value.idempotencyKey) ||
    !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey) ||
    !isString(value.payloadFingerprint) ||
    !SHA256_PATTERN.test(value.payloadFingerprint) ||
    !isString(value.createdAt) ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    !isString(value.startsAt) ||
    Number.isNaN(Date.parse(value.startsAt)) ||
    !isString(value.gameId) ||
    !UUID_PATTERN.test(value.gameId) ||
    !isString(value.operationId) ||
    !UUID_PATTERN.test(value.operationId) ||
    (value.paymentMode !== 'SPLIT' && value.paymentMode !== 'SUBSCRIPTION')
  ) {
    throw new CreateGameAttemptError('ATTEMPT_MALFORMED');
  }
  const { tenantId, actorUserId } = parsePrincipalFields(value, principal);
  const payload = parsePayload(value.payload);
  if (
    !payload ||
    payload.paymentMode !== value.paymentMode ||
    payload.startsAt !== new Date(value.startsAt).toISOString()
  ) {
    throw new CreateGameAttemptError('ATTEMPT_MALFORMED');
  }
  return {
    state: 'PENDING_CONFIRMATION',
    attemptId: value.attemptId,
    tenantId,
    actorUserId,
    idempotencyKey: value.idempotencyKey,
    payloadFingerprint: value.payloadFingerprint,
    createdAt: new Date(value.createdAt).toISOString(),
    startsAt: payload.startsAt,
    payload,
    gameId: value.gameId,
    operationId: value.operationId,
    paymentMode: value.paymentMode,
  };
}

function parseActiveAttempt(
  value: unknown,
  principal: CreateGameAttemptPrincipal,
): ActiveCreateGameAttempt {
  if (isRecord(value) && value.state === 'PENDING_CONFIRMATION') {
    return parsePendingConfirmation(value, principal);
  }
  return parsePending(value, principal);
}

/** Version 3 only ever wrote a free `NO_PAYMENT` pending attempt; anything richer is malformed. */
function parseLegacyPending(
  value: unknown,
  principal: CreateGameAttemptPrincipal,
): PendingCreateGameAttempt {
  const attempt = parsePending(value, principal);
  if (attempt.payload.paymentMode !== 'NO_PAYMENT') {
    throw new CreateGameAttemptError('ATTEMPT_MALFORMED');
  }
  return attempt;
}

function parseResolved(
  value: unknown,
  principal: CreateGameAttemptPrincipal,
): ResolvedCreateGameAttempt {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'state',
      'attemptId',
      'tenantId',
      'actorUserId',
      'idempotencyKey',
      'payloadFingerprint',
      'gameId',
      'resolvedAt',
      'expiresAt',
    ]) ||
    value.state !== 'RESOLVED' ||
    !isString(value.attemptId) ||
    !UUID_PATTERN.test(value.attemptId) ||
    !isString(value.idempotencyKey) ||
    !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey) ||
    !isString(value.payloadFingerprint) ||
    !SHA256_PATTERN.test(value.payloadFingerprint) ||
    !isString(value.gameId) ||
    !UUID_PATTERN.test(value.gameId) ||
    !isString(value.resolvedAt) ||
    Number.isNaN(Date.parse(value.resolvedAt)) ||
    !isString(value.expiresAt) ||
    Number.isNaN(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= Date.parse(value.resolvedAt)
  ) {
    throw new CreateGameAttemptError('ATTEMPT_MALFORMED');
  }
  const { tenantId, actorUserId } = parsePrincipalFields(value, principal);
  return {
    state: 'RESOLVED',
    attemptId: value.attemptId,
    tenantId,
    actorUserId,
    idempotencyKey: value.idempotencyKey,
    payloadFingerprint: value.payloadFingerprint,
    gameId: value.gameId,
    resolvedAt: new Date(value.resolvedAt).toISOString(),
    expiresAt: new Date(value.expiresAt).toISOString(),
  };
}

function emptyLedger(): CreateGameAttemptLedger {
  return { version: LEDGER_VERSION, resolvedAttempts: [] };
}

function parseLedger(raw: string, principal: CreateGameAttemptPrincipal): CreateGameAttemptLedger {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CreateGameAttemptError('ATTEMPT_MALFORMED');
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['version', 'activeAttempt', 'resolvedAttempts']) ||
    (value.version !== LEDGER_VERSION && !LEGACY_LEDGER_VERSIONS.has(value.version)) ||
    !Array.isArray(value.resolvedAttempts)
  ) {
    throw new CreateGameAttemptError('ATTEMPT_MALFORMED');
  }
  const legacy = value.version === legacyLedgerVersion3;
  const activeAttempt =
    value.activeAttempt === undefined
      ? undefined
      : legacy
        ? parseLegacyPending(value.activeAttempt, principal)
        : parseActiveAttempt(value.activeAttempt, principal);
  const resolvedAttempts = value.resolvedAttempts.map((item) => parseResolved(item, principal));
  const identities = [
    ...(activeAttempt
      ? [`attempt:${activeAttempt.attemptId}`, `key:${activeAttempt.idempotencyKey}`]
      : []),
    ...resolvedAttempts.flatMap((item) => [
      `attempt:${item.attemptId}`,
      `key:${item.idempotencyKey}`,
    ]),
  ];
  if (new Set(identities).size !== identities.length) {
    throw new CreateGameAttemptError('ATTEMPT_MALFORMED');
  }
  return {
    version: LEDGER_VERSION,
    ...(activeAttempt ? { activeAttempt } : {}),
    resolvedAttempts,
  };
}

function pruneExpired(ledger: CreateGameAttemptLedger, now: Date): CreateGameAttemptLedger {
  const resolvedAttempts = ledger.resolvedAttempts.filter(
    (attempt) => Date.parse(attempt.expiresAt) > now.getTime(),
  );
  return {
    version: LEDGER_VERSION,
    ...(ledger.activeAttempt ? { activeAttempt: ledger.activeAttempt } : {}),
    resolvedAttempts,
  };
}

function readLedger(
  principal: CreateGameAttemptPrincipal,
  storage: Storage,
  now = new Date(),
): CreateGameAttemptLedger {
  const raw = readRaw(storage, createGameAttemptStorageKey(principal));
  return raw === null ? emptyLedger() : pruneExpired(parseLedger(raw, principal), now);
}

function writeLedger(
  storage: Storage,
  principal: CreateGameAttemptPrincipal,
  ledger: CreateGameAttemptLedger,
): void {
  try {
    storage.setItem(createGameAttemptStorageKey(principal), JSON.stringify(ledger));
  } catch {
    throw new CreateGameAttemptError('ATTEMPT_STORAGE_UNAVAILABLE');
  }
}

function latestResolved(
  resolvedAttempts: readonly ResolvedCreateGameAttempt[],
): ResolvedCreateGameAttempt | undefined {
  return [...resolvedAttempts].sort(
    (left, right) => Date.parse(right.resolvedAt) - Date.parse(left.resolvedAt),
  )[0];
}

export function loadCreateGameAttemptLedger(
  principal: CreateGameAttemptPrincipal,
  storage: Storage,
): CreateGameAttemptLedger {
  return readLedger(principal, storage);
}

export function loadCreateGameAttempt(
  principal: CreateGameAttemptPrincipal,
  storage: Storage,
): CreateGameAttempt | null {
  const ledger = readLedger(principal, storage);
  return ledger.activeAttempt ?? latestResolved(ledger.resolvedAttempts) ?? null;
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

async function validatePendingFingerprint(attempt: ActiveCreateGameAttempt): Promise<void> {
  if ((await payloadFingerprint(attempt.payload)) !== attempt.payloadFingerprint) {
    throw new CreateGameAttemptError('ATTEMPT_MALFORMED');
  }
}

function assertPrincipal(
  principal: CreateGameAttemptPrincipal,
  attempt: ActiveCreateGameAttempt,
): void {
  if (attempt.tenantId !== principal.tenantId || attempt.actorUserId !== principal.userId) {
    throw new CreateGameAttemptError('ATTEMPT_FOREIGN_PRINCIPAL');
  }
}

export async function prepareCreateGameAttempt(
  principal: CreateGameAttemptPrincipal,
  input: CreateGameRequest,
  storage: Storage,
  lockManager: CreateGameAttemptLockManager | undefined,
  options: {
    readonly now?: () => Date;
    readonly createAttemptId?: () => string;
    readonly createIdempotencyKey?: () => string;
    readonly mountedAttempt?: ActiveCreateGameAttempt | null;
    readonly allowNewIntent?: boolean;
  } = {},
): Promise<CreateGameAttempt> {
  const payload = normalizeCreateGamePayload(input);
  // The write side enforces the same rule as the read side: managed-only fields never ride on a
  // free create, even if a caller constructs such a payload directly.
  if (
    payload.paymentMode === 'NO_PAYMENT' &&
    (payload.subscriptionInstanceId !== undefined || payload.priceConsent !== undefined)
  ) {
    throw new CreateGameAttemptError('ATTEMPT_MALFORMED');
  }
  const fingerprint = await payloadFingerprint(payload);
  return withAttemptLock(principal, lockManager, async () => {
    if (
      storage.getItem('phub.quarter-create.v1:' + principal.tenantId + ':' + principal.userId) !==
      null
    )
      throw new CreateGameAttemptError('ATTEMPT_STATE_CHANGED');
    const now = options.now?.() ?? new Date();
    let ledger = readLedger(principal, storage, now);
    const mounted = options.mountedAttempt ?? undefined;
    if (mounted) {
      assertPrincipal(principal, mounted);
      await validatePendingFingerprint(mounted);
      const resolved = ledger.resolvedAttempts.find(
        (item) =>
          item.attemptId === mounted.attemptId || item.idempotencyKey === mounted.idempotencyKey,
      );
      if (resolved) {
        if (
          resolved.attemptId !== mounted.attemptId ||
          resolved.idempotencyKey !== mounted.idempotencyKey ||
          resolved.payloadFingerprint !== mounted.payloadFingerprint
        ) {
          throw new CreateGameAttemptError('ATTEMPT_STATE_CHANGED');
        }
        return resolved;
      }
      if (ledger.activeAttempt) {
        if (
          ledger.activeAttempt.attemptId !== mounted.attemptId ||
          ledger.activeAttempt.idempotencyKey !== mounted.idempotencyKey ||
          ledger.activeAttempt.state !== mounted.state
        ) {
          throw new CreateGameAttemptError('ATTEMPT_STATE_CHANGED');
        }
        await validatePendingFingerprint(ledger.activeAttempt);
        if (ledger.activeAttempt.payloadFingerprint !== fingerprint) {
          throw new CreateGameAttemptError('ATTEMPT_PAYLOAD_CHANGED');
        }
        return ledger.activeAttempt;
      }
      if (mounted.payloadFingerprint !== fingerprint) {
        throw new CreateGameAttemptError('ATTEMPT_PAYLOAD_CHANGED');
      }
      ledger = { ...ledger, activeAttempt: mounted };
      writeLedger(storage, principal, ledger);
      return mounted;
    }

    if (ledger.activeAttempt) {
      await validatePendingFingerprint(ledger.activeAttempt);
      if (ledger.activeAttempt.payloadFingerprint !== fingerprint) {
        throw new CreateGameAttemptError('ATTEMPT_PAYLOAD_CHANGED');
      }
      return ledger.activeAttempt;
    }

    if (!options.allowNewIntent) {
      const resolved = latestResolved(ledger.resolvedAttempts);
      if (resolved) return resolved;
    }
    if (ledger.resolvedAttempts.length >= MAX_RESOLVED_ATTEMPTS) {
      throw new CreateGameAttemptError('ATTEMPT_HISTORY_FULL');
    }

    const randomUuid = () => {
      if (typeof globalThis.crypto?.randomUUID !== 'function') {
        throw new CreateGameAttemptError('ATTEMPT_CRYPTO_UNAVAILABLE');
      }
      return globalThis.crypto.randomUUID();
    };
    const attemptId = (options.createAttemptId ?? randomUuid)();
    const idempotencyKey = (options.createIdempotencyKey ?? randomUuid)();
    if (
      !UUID_PATTERN.test(attemptId) ||
      !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey) ||
      attemptId === idempotencyKey
    ) {
      throw new CreateGameAttemptError('ATTEMPT_MALFORMED');
    }
    const attempt: PendingCreateGameAttempt = {
      state: 'PENDING',
      attemptId,
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      idempotencyKey,
      payloadFingerprint: fingerprint,
      createdAt: now.toISOString(),
      startsAt: payload.startsAt,
      payload,
    };
    writeLedger(storage, principal, { ...ledger, activeAttempt: attempt });
    return attempt;
  });
}

export async function resolveCreateGameAttempt(
  principal: CreateGameAttemptPrincipal,
  attempt: ActiveCreateGameAttempt,
  gameId: string,
  storage: Storage,
  lockManager: CreateGameAttemptLockManager | undefined,
  options: { readonly now?: () => Date } = {},
): Promise<ResolvedCreateGameAttempt> {
  if (!UUID_PATTERN.test(gameId)) throw new CreateGameAttemptError('ATTEMPT_MALFORMED');
  // A managed confirmation names exactly one accepted game; a different readback is a conflict.
  if (attempt.state === 'PENDING_CONFIRMATION' && attempt.gameId !== gameId) {
    throw new CreateGameAttemptError('ATTEMPT_STATE_CHANGED');
  }
  assertPrincipal(principal, attempt);
  await validatePendingFingerprint(attempt);
  return withAttemptLock(principal, lockManager, () => {
    const now = options.now?.() ?? new Date();
    const ledger = readLedger(principal, storage, now);
    const existing = ledger.resolvedAttempts.find(
      (item) =>
        item.attemptId === attempt.attemptId || item.idempotencyKey === attempt.idempotencyKey,
    );
    if (existing) {
      if (
        existing.attemptId !== attempt.attemptId ||
        existing.idempotencyKey !== attempt.idempotencyKey ||
        existing.payloadFingerprint !== attempt.payloadFingerprint ||
        existing.gameId !== gameId
      ) {
        throw new CreateGameAttemptError('ATTEMPT_STATE_CHANGED');
      }
      return existing;
    }
    if (
      ledger.activeAttempt &&
      (ledger.activeAttempt.attemptId !== attempt.attemptId ||
        ledger.activeAttempt.idempotencyKey !== attempt.idempotencyKey ||
        ledger.activeAttempt.payloadFingerprint !== attempt.payloadFingerprint)
    ) {
      throw new CreateGameAttemptError('ATTEMPT_STATE_CHANGED');
    }
    if (ledger.resolvedAttempts.length >= MAX_RESOLVED_ATTEMPTS) {
      throw new CreateGameAttemptError('ATTEMPT_HISTORY_FULL');
    }
    const expiresAt = new Date(
      Math.max(
        Date.parse(attempt.startsAt) + RESOLVED_SAFETY_WINDOW_MS,
        now.getTime() + RESOLVED_SAFETY_WINDOW_MS,
      ),
    ).toISOString();
    const resolved: ResolvedCreateGameAttempt = {
      state: 'RESOLVED',
      attemptId: attempt.attemptId,
      tenantId: attempt.tenantId,
      actorUserId: attempt.actorUserId,
      idempotencyKey: attempt.idempotencyKey,
      payloadFingerprint: attempt.payloadFingerprint,
      gameId,
      resolvedAt: now.toISOString(),
      expiresAt,
    };
    writeLedger(storage, principal, {
      version: LEDGER_VERSION,
      resolvedAttempts: [resolved, ...ledger.resolvedAttempts],
    });
    return resolved;
  });
}

/**
 * Records the managed commercial CREATE acceptance (`202 CREATE_GAME`, UNKNOWN/PROCESSING). The
 * attempt keeps its original idempotency key and payload; it becomes a PENDING_CONFIRMATION record
 * so a reload or a repeat offers operation readback instead of a replacement POST.
 */
export async function recordCreateGameConfirmation(
  principal: CreateGameAttemptPrincipal,
  attempt: PendingCreateGameAttempt,
  accepted: { readonly gameId: string; readonly operationId: string },
  storage: Storage,
  lockManager: CreateGameAttemptLockManager | undefined,
  options: { readonly now?: () => Date } = {},
): Promise<PendingConfirmationCreateGameAttempt> {
  if (!UUID_PATTERN.test(accepted.gameId) || !UUID_PATTERN.test(accepted.operationId)) {
    throw new CreateGameAttemptError('ATTEMPT_MALFORMED');
  }
  if (attempt.payload.paymentMode !== 'SPLIT' && attempt.payload.paymentMode !== 'SUBSCRIPTION') {
    throw new CreateGameAttemptError('ATTEMPT_MALFORMED');
  }
  const paymentMode = attempt.payload.paymentMode;
  assertPrincipal(principal, attempt);
  await validatePendingFingerprint(attempt);
  return withAttemptLock(principal, lockManager, () => {
    const now = options.now?.() ?? new Date();
    const ledger = readLedger(principal, storage, now);
    const existing = ledger.activeAttempt;
    if (
      !existing ||
      existing.attemptId !== attempt.attemptId ||
      existing.idempotencyKey !== attempt.idempotencyKey ||
      existing.payloadFingerprint !== attempt.payloadFingerprint
    ) {
      throw new CreateGameAttemptError('ATTEMPT_STATE_CHANGED');
    }
    if (existing.state === 'PENDING_CONFIRMATION') {
      if (existing.gameId === accepted.gameId && existing.operationId === accepted.operationId) {
        return existing;
      }
      // One attempt can only ever name one accepted operation.
      throw new CreateGameAttemptError('ATTEMPT_STATE_CHANGED');
    }
    const confirmation: PendingConfirmationCreateGameAttempt = {
      state: 'PENDING_CONFIRMATION',
      attemptId: attempt.attemptId,
      tenantId: attempt.tenantId,
      actorUserId: attempt.actorUserId,
      idempotencyKey: attempt.idempotencyKey,
      payloadFingerprint: attempt.payloadFingerprint,
      createdAt: attempt.createdAt,
      startsAt: attempt.startsAt,
      payload: attempt.payload,
      gameId: accepted.gameId,
      operationId: accepted.operationId,
      paymentMode,
    };
    writeLedger(storage, principal, { ...ledger, activeAttempt: confirmation });
    return confirmation;
  });
}

export async function clearCreateGameAttempt(
  principal: CreateGameAttemptPrincipal,
  attempt: ActiveCreateGameAttempt,
  storage: Storage,
  lockManager: CreateGameAttemptLockManager | undefined,
): Promise<void> {
  await withAttemptLock(principal, lockManager, () => {
    const ledger = readLedger(principal, storage);
    if (!ledger.activeAttempt) return;
    if (
      ledger.activeAttempt.attemptId !== attempt.attemptId ||
      ledger.activeAttempt.idempotencyKey !== attempt.idempotencyKey ||
      ledger.activeAttempt.payloadFingerprint !== attempt.payloadFingerprint
    ) {
      throw new CreateGameAttemptError('ATTEMPT_STATE_CHANGED');
    }
    writeLedger(storage, principal, {
      version: LEDGER_VERSION,
      resolvedAttempts: ledger.resolvedAttempts,
    });
  });
}
