/**
 * Durable client custody of a paid JOIN attempt.
 *
 * The paid JOIN is a CRITICAL command: the client owns nothing except the *attempt identity* and the
 * exact request it already sent. It stores `{tenantId, actorId, gameId, idempotencyKey, requestHash,
 * subscriptionInstanceId, priceConsent, operationId?, savedAt}` in localStorage before dispatch so a
 * reload, a second tab or a lost response can be recovered from the server by the same operation,
 * never by a replacement purchase.
 *
 * Safety rules encoded here:
 * - one attempt per game and principal; a repeat with the identical request reuses the same key;
 * - an unresolved attempt (PENDING after dispatch, or UNKNOWN) can never be silently replaced by a
 *   new key while the client holds custody;
 * - a durable `dispatchStartedAt` marker is written before the HTTP POST, so custody can never be
 *   forgotten between "begin" and "the request may have reached the server";
 * - all ledger mutations and dispatch use the same principal-wide Web Lock; no unsafe
 *   localStorage read/modify/write fallback is permitted when Web Locks are unavailable;
 * - strict parsing rejects unknown fields, so credentials or provider payloads can never be stored.
 */
const LEDGER_VERSION = 1 as const;
const LEDGER_PREFIX = 'phub.game-join-attempt.v1';
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ATTEMPTS = 16;
const RESOLVED_RETENTION_MS = 24 * 60 * 60_000;
const MAX_PRINCIPAL_LENGTH = 200;

/**
 * Product rule for closing custody that can no longer hide a server-side effect (review blockers of
 * #453/#466): an attempt is released only after it has been quiet for this long.
 *
 * Why an undispatched attempt is safe to release after the window:
 * - The durable marker is written under the principal-wide Web Lock immediately before the POST and
 *   the dispatch callback is awaited inside that lock, so a quiet attempt without a marker provably
 *   never dispatched. The window also keeps a concurrent tab that is between `begin` and `dispatch`
 *   from being raced, because that tab writes its marker long before the window ends. This is a
 *   proof about the write paths, not a time bound.
 *
 * Why a 404 after a dispatch may only be trusted after the window (derivation from server code):
 * - The server creates the durable operation row before the owner call
 *   (`apps/api/src/games/game-commercial-join.ts`, step 3 "The operation exists before the owner
 *   call"), but the pre-row path is NOT uniformly bounded by
 *   `GAME_COMMERCIAL_JOIN_OWNER_TIMEOUT_MS` (that setting only sizes the admission/read HTTP
 *   clients, configured max 5s). The conditions re-read has its own 28s default timeout
 *   (`apps/api/src/games/game-join-conditions.ts`, `options.timeoutMs ?? 28_000`), and the
 *   `prepare` / admission DB work before the row is limited only by DB connection handling
 *   (~3s per connection, no statement timeout). The client POST also outlives its own 8s
 *   `withJoinDeadline` race, so the server request can still be running.
 * - 180s is therefore a conservative multiple of the verified pre-row budget (28s conditions +
 *   DB/admission + network), not an exact proof: it does not cover a pathological DB stall longer
 *   than the window. Release still requires a real `GAME_OPERATION_NOT_FOUND` readback AND a
 *   lock-rechecked custody state, never auto-POSTs, and a fresh purchase needs fresh conditions +
 *   explicit consent. A wall-clock forward jump can shorten the window; the client is the payer's
 *   own device, so this is a self-inflicted recovery trade-off, not an external trust boundary.
 *   Follow-up: a server-side "no durable operation for this key" readback would remove the time
 *   guess entirely.
 */
export const GAME_JOIN_ATTEMPT_QUIET_MS = 180_000;

export type GameJoinAttemptState = 'PENDING' | 'UNKNOWN' | 'SUCCEEDED';

export interface GameJoinPriceConsent {
  readonly amountMinor: number;
  readonly currency: 'RUB';
}

export interface GameJoinAttemptPrincipal {
  readonly tenantId: string;
  readonly userId: string;
}

export interface GameJoinAttemptInput {
  readonly gameId: string;
  readonly expectedRevision: number;
  readonly subscriptionInstanceId: string;
  readonly priceConsent: GameJoinPriceConsent;
  readonly invitationId?: string;
}

/**
 * The persisted attempt. `requestHash` is the client-side mirror of the server's canonical request
 * hash; it is custody metadata only and is never sent as a decision. `dispatchStartedAt` is the
 * durable "the POST may have been sent" marker that forbids a resend.
 */
export interface GameJoinAttempt {
  readonly state: GameJoinAttemptState;
  readonly tenantId: string;
  readonly actorId: string;
  readonly gameId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly subscriptionInstanceId: string;
  readonly priceConsent: GameJoinPriceConsent;
  readonly operationId?: string;
  readonly savedAt: string;
  readonly dispatchStartedAt?: string;
  readonly resolvedAt?: string;
}

export interface GameJoinAttemptLedger {
  readonly version: typeof LEDGER_VERSION;
  readonly attempts: readonly GameJoinAttempt[];
}

export interface GameJoinAttemptLockManager {
  request<TResult>(
    name: string,
    options: { readonly mode: 'exclusive' },
    callback: () => TResult | PromiseLike<TResult>,
  ): Promise<TResult>;
}

export type GameJoinAttemptErrorCode =
  | 'ATTEMPT_STORAGE_UNAVAILABLE'
  | 'ATTEMPT_CRYPTO_UNAVAILABLE'
  | 'ATTEMPT_LOCK_UNAVAILABLE'
  | 'ATTEMPT_MALFORMED'
  | 'ATTEMPT_FOREIGN_PRINCIPAL'
  | 'ATTEMPT_INVALID_INPUT'
  | 'ATTEMPT_STATE_CHANGED'
  | 'ATTEMPT_ALREADY_DISPATCHED'
  | 'ATTEMPT_UNRESOLVED'
  | 'ATTEMPT_HISTORY_FULL';

export class GameJoinAttemptError extends Error {
  public constructor(public readonly code: GameJoinAttemptErrorCode) {
    super(code);
    this.name = 'GameJoinAttemptError';
  }
}

export interface GameJoinAttemptResolution {
  readonly state: 'SUCCEEDED' | 'UNKNOWN' | 'PENDING';
  readonly operationId?: string;
}

export type GameJoinDispatchOutcome<TResult> =
  | {
      readonly dispatched: true;
      readonly attempt: GameJoinAttempt;
      readonly value: TResult;
    }
  | {
      readonly dispatched: false;
      readonly reason: 'NO_ATTEMPT' | 'NOT_PENDING' | 'ALREADY_DISPATCHED';
      readonly attempt: GameJoinAttempt | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maximumLength = MAX_PRINCIPAL_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isAmountMinor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isState(value: unknown): value is GameJoinAttemptState {
  return value === 'PENDING' || value === 'UNKNOWN' || value === 'SUCCEEDED';
}

function validatePrincipal(principal: GameJoinAttemptPrincipal): void {
  if (!isNonEmptyString(principal.tenantId) || !isNonEmptyString(principal.userId)) {
    throw new GameJoinAttemptError('ATTEMPT_INVALID_INPUT');
  }
}

function parsePriceConsent(value: unknown): GameJoinPriceConsent {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['amountMinor', 'currency']) ||
    !isAmountMinor(value.amountMinor) ||
    value.currency !== 'RUB'
  ) {
    throw new GameJoinAttemptError('ATTEMPT_MALFORMED');
  }
  return { amountMinor: value.amountMinor, currency: 'RUB' };
}

const ATTEMPT_KEYS = [
  'state',
  'tenantId',
  'actorId',
  'gameId',
  'idempotencyKey',
  'requestHash',
  'subscriptionInstanceId',
  'priceConsent',
  'operationId',
  'savedAt',
  'dispatchStartedAt',
  'resolvedAt',
] as const;

function parseAttempt(value: unknown, principal: GameJoinAttemptPrincipal): GameJoinAttempt {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ATTEMPT_KEYS) ||
    !isState(value.state) ||
    !isNonEmptyString(value.tenantId) ||
    !isNonEmptyString(value.actorId) ||
    !isUuid(value.gameId) ||
    !isNonEmptyString(value.idempotencyKey) ||
    !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey) ||
    !isNonEmptyString(value.requestHash) ||
    !SHA256_PATTERN.test(value.requestHash) ||
    !isUuid(value.subscriptionInstanceId) ||
    !isIsoDate(value.savedAt) ||
    (value.operationId !== undefined && !isUuid(value.operationId)) ||
    (value.dispatchStartedAt !== undefined && !isIsoDate(value.dispatchStartedAt)) ||
    (value.resolvedAt !== undefined && !isIsoDate(value.resolvedAt))
  ) {
    throw new GameJoinAttemptError('ATTEMPT_MALFORMED');
  }
  if (value.tenantId !== principal.tenantId || value.actorId !== principal.userId) {
    throw new GameJoinAttemptError('ATTEMPT_FOREIGN_PRINCIPAL');
  }
  const priceConsent = parsePriceConsent(value.priceConsent);
  if (value.state === 'SUCCEEDED' && value.resolvedAt === undefined) {
    throw new GameJoinAttemptError('ATTEMPT_MALFORMED');
  }
  if (value.state !== 'SUCCEEDED' && value.resolvedAt !== undefined) {
    throw new GameJoinAttemptError('ATTEMPT_MALFORMED');
  }
  if (
    value.dispatchStartedAt !== undefined &&
    Date.parse(value.dispatchStartedAt) < Date.parse(value.savedAt)
  ) {
    throw new GameJoinAttemptError('ATTEMPT_MALFORMED');
  }
  return {
    state: value.state,
    tenantId: value.tenantId,
    actorId: value.actorId,
    gameId: value.gameId,
    idempotencyKey: value.idempotencyKey,
    requestHash: value.requestHash,
    subscriptionInstanceId: value.subscriptionInstanceId,
    priceConsent,
    ...(value.operationId === undefined ? {} : { operationId: value.operationId }),
    savedAt: new Date(value.savedAt).toISOString(),
    ...(value.dispatchStartedAt === undefined
      ? {}
      : { dispatchStartedAt: new Date(value.dispatchStartedAt).toISOString() }),
    ...(value.resolvedAt === undefined
      ? {}
      : { resolvedAt: new Date(value.resolvedAt).toISOString() }),
  };
}

function emptyLedger(): GameJoinAttemptLedger {
  return { version: LEDGER_VERSION, attempts: [] };
}

function readRaw(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    throw new GameJoinAttemptError('ATTEMPT_STORAGE_UNAVAILABLE');
  }
}

function writeLedger(
  storage: Storage,
  principal: GameJoinAttemptPrincipal,
  ledger: GameJoinAttemptLedger,
): void {
  try {
    storage.setItem(gameJoinAttemptStorageKey(principal), JSON.stringify(ledger));
  } catch {
    throw new GameJoinAttemptError('ATTEMPT_STORAGE_UNAVAILABLE');
  }
}

function pruneResolved(ledger: GameJoinAttemptLedger, now: Date): GameJoinAttemptLedger {
  const attempts = ledger.attempts.filter(
    (attempt) =>
      attempt.state !== 'SUCCEEDED' ||
      attempt.resolvedAt === undefined ||
      Date.parse(attempt.resolvedAt) + RESOLVED_RETENTION_MS > now.getTime(),
  );
  return attempts.length === ledger.attempts.length
    ? ledger
    : { version: LEDGER_VERSION, attempts };
}

function parseLedger(raw: string, principal: GameJoinAttemptPrincipal): GameJoinAttemptLedger {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new GameJoinAttemptError('ATTEMPT_MALFORMED');
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['version', 'attempts']) ||
    value.version !== LEDGER_VERSION ||
    !Array.isArray(value.attempts) ||
    value.attempts.length > MAX_ATTEMPTS
  ) {
    throw new GameJoinAttemptError('ATTEMPT_MALFORMED');
  }
  const attempts = value.attempts.map((item) => parseAttempt(item, principal));
  const gameIds = new Set(attempts.map((attempt) => attempt.gameId));
  const keys = new Set(attempts.map((attempt) => attempt.idempotencyKey));
  if (gameIds.size !== attempts.length || keys.size !== attempts.length) {
    throw new GameJoinAttemptError('ATTEMPT_MALFORMED');
  }
  return { version: LEDGER_VERSION, attempts };
}

function readLedger(
  principal: GameJoinAttemptPrincipal,
  storage: Storage,
  now = new Date(),
): GameJoinAttemptLedger {
  validatePrincipal(principal);
  const raw = readRaw(storage, gameJoinAttemptStorageKey(principal));
  return raw === null ? emptyLedger() : pruneResolved(parseLedger(raw, principal), now);
}

function findAttempt(ledger: GameJoinAttemptLedger, gameId: string): GameJoinAttempt | undefined {
  return ledger.attempts.find((attempt) => attempt.gameId === gameId);
}

function replaceAttempt(
  ledger: GameJoinAttemptLedger,
  attempt: GameJoinAttempt,
): GameJoinAttemptLedger {
  return {
    version: LEDGER_VERSION,
    attempts: [attempt, ...ledger.attempts.filter((item) => item.gameId !== attempt.gameId)],
  };
}

function assertSameAttempt(
  expected: GameJoinAttempt,
  actual: GameJoinAttempt | undefined,
): GameJoinAttempt {
  if (
    !actual ||
    actual.gameId !== expected.gameId ||
    actual.idempotencyKey !== expected.idempotencyKey ||
    actual.requestHash !== expected.requestHash ||
    actual.subscriptionInstanceId !== expected.subscriptionInstanceId ||
    actual.priceConsent.amountMinor !== expected.priceConsent.amountMinor ||
    actual.priceConsent.currency !== expected.priceConsent.currency
  ) {
    throw new GameJoinAttemptError('ATTEMPT_STATE_CHANGED');
  }
  return actual;
}

export function browserGameJoinAttemptStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function browserGameJoinAttemptLockManager(): GameJoinAttemptLockManager | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const candidate = (navigator as Navigator & { readonly locks?: GameJoinAttemptLockManager })
    .locks;
  return candidate && typeof candidate.request === 'function' ? candidate : undefined;
}

export function gameJoinAttemptStorageKey(principal: GameJoinAttemptPrincipal): string {
  return `${LEDGER_PREFIX}:${encodeURIComponent(principal.tenantId)}:${encodeURIComponent(principal.userId)}`;
}

export function gameJoinDispatchLockName(
  principal: GameJoinAttemptPrincipal,
  gameId: string,
): string {
  if (!isUuid(gameId)) throw new GameJoinAttemptError('ATTEMPT_INVALID_INPUT');
  return gameJoinLedgerLockName(principal);
}

function gameJoinLedgerLockName(principal: GameJoinAttemptPrincipal): string {
  validatePrincipal(principal);
  return `${LEDGER_PREFIX}:ledger:${encodeURIComponent(principal.tenantId)}:${encodeURIComponent(
    principal.userId,
  )}`;
}

async function withGameJoinLedgerLock<TResult>(
  principal: GameJoinAttemptPrincipal,
  manager: GameJoinAttemptLockManager | undefined,
  run: () => TResult | PromiseLike<TResult>,
): Promise<TResult> {
  if (!manager) throw new GameJoinAttemptError('ATTEMPT_LOCK_UNAVAILABLE');
  let entered = false;
  try {
    return await manager.request(gameJoinLedgerLockName(principal), { mode: 'exclusive' }, () => {
      entered = true;
      return run();
    });
  } catch (error) {
    if (entered || error instanceof GameJoinAttemptError) throw error;
    throw new GameJoinAttemptError('ATTEMPT_LOCK_UNAVAILABLE');
  }
}

function canonicalRequestHashInput(
  principal: GameJoinAttemptPrincipal,
  input: GameJoinAttemptInput,
): string {
  // Mirrors the server's `commercialJoinRequestHash` (apps/api/src/games/game-commercial-join.ts).
  // The client value is custody metadata only; the server always recomputes its own binding.
  return JSON.stringify({
    command: 'JOIN_GAME',
    contract: 'game.join.paid.v1',
    tenantId: principal.tenantId,
    userId: principal.userId,
    gameId: input.gameId,
    expectedRevision: input.expectedRevision,
    subscriptionInstanceId: input.subscriptionInstanceId,
    amountMinor: input.priceConsent.amountMinor,
    currency: input.priceConsent.currency,
    invitationId: input.invitationId ?? null,
  });
}

function validateInput(input: GameJoinAttemptInput): void {
  if (
    !isUuid(input.gameId) ||
    !isUuid(input.subscriptionInstanceId) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    !isAmountMinor(input.priceConsent.amountMinor) ||
    input.priceConsent.currency !== 'RUB' ||
    (input.invitationId !== undefined && !isUuid(input.invitationId))
  ) {
    throw new GameJoinAttemptError('ATTEMPT_INVALID_INPUT');
  }
}

export async function gameJoinRequestHash(
  principal: GameJoinAttemptPrincipal,
  input: GameJoinAttemptInput,
): Promise<string> {
  validatePrincipal(principal);
  validateInput(input);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new GameJoinAttemptError('ATTEMPT_CRYPTO_UNAVAILABLE');
  const digest = await subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalRequestHashInput(principal, input)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function readGameJoinAttemptLedger(
  principal: GameJoinAttemptPrincipal,
  storage: Storage,
  options: { readonly now?: Date } = {},
): GameJoinAttemptLedger {
  return readLedger(principal, storage, options.now ?? new Date());
}

export function loadGameJoinAttempt(
  principal: GameJoinAttemptPrincipal,
  storage: Storage,
  gameId: string,
  options: { readonly now?: Date } = {},
): GameJoinAttempt | null {
  if (!isUuid(gameId)) throw new GameJoinAttemptError('ATTEMPT_INVALID_INPUT');
  return findAttempt(readLedger(principal, storage, options.now ?? new Date()), gameId) ?? null;
}

/**
 * Creates the durable attempt before the POST, or reuses the identical one. An attempt whose request
 * changed but whose outcome is unresolved is never replaced: the caller must recover first.
 */
export async function beginGameJoinAttempt(
  principal: GameJoinAttemptPrincipal,
  input: GameJoinAttemptInput,
  storage: Storage,
  options: {
    readonly now?: () => Date;
    readonly createIdempotencyKey?: () => string;
    readonly lockManager?: GameJoinAttemptLockManager;
  } = {},
): Promise<{ readonly attempt: GameJoinAttempt; readonly created: boolean }> {
  validatePrincipal(principal);
  validateInput(input);
  const requestHash = await gameJoinRequestHash(principal, input);
  return withGameJoinLedgerLock(
    principal,
    options.lockManager ?? browserGameJoinAttemptLockManager(),
    () => {
      const now = options.now?.() ?? new Date();
      let ledger = readLedger(principal, storage, now);
      const existing = findAttempt(ledger, input.gameId);
      if (existing) {
        const identical =
          existing.requestHash === requestHash &&
          existing.subscriptionInstanceId === input.subscriptionInstanceId &&
          existing.priceConsent.amountMinor === input.priceConsent.amountMinor &&
          existing.priceConsent.currency === input.priceConsent.currency;
        if (identical) return { attempt: existing, created: false };
        if (existing.state !== 'SUCCEEDED') {
          throw new GameJoinAttemptError('ATTEMPT_UNRESOLVED');
        }
      }
      if (ledger.attempts.length >= MAX_ATTEMPTS) {
        // Only fully resolved successes may be evicted to make room; unresolved custody is never dropped.
        const successes = ledger.attempts
          .filter((attempt) => attempt.state === 'SUCCEEDED')
          .sort(
            (left, right) =>
              Date.parse(left.resolvedAt ?? left.savedAt) -
              Date.parse(right.resolvedAt ?? right.savedAt),
          );
        const evictCount = ledger.attempts.length - (MAX_ATTEMPTS - 1);
        if (successes.length < evictCount) throw new GameJoinAttemptError('ATTEMPT_HISTORY_FULL');
        const evictable = new Set(
          successes.slice(0, evictCount).map((attempt) => attempt.idempotencyKey),
        );
        ledger = {
          version: LEDGER_VERSION,
          attempts: ledger.attempts.filter((attempt) => !evictable.has(attempt.idempotencyKey)),
        };
        if (ledger.attempts.length >= MAX_ATTEMPTS) {
          throw new GameJoinAttemptError('ATTEMPT_HISTORY_FULL');
        }
      }
      const createIdempotencyKey =
        options.createIdempotencyKey ??
        (() => {
          if (typeof globalThis.crypto?.randomUUID !== 'function') {
            throw new GameJoinAttemptError('ATTEMPT_CRYPTO_UNAVAILABLE');
          }
          return globalThis.crypto.randomUUID();
        });
      const idempotencyKey = createIdempotencyKey();
      if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        throw new GameJoinAttemptError('ATTEMPT_INVALID_INPUT');
      }
      const attempt: GameJoinAttempt = {
        state: 'PENDING',
        tenantId: principal.tenantId,
        actorId: principal.userId,
        gameId: input.gameId,
        idempotencyKey,
        requestHash,
        subscriptionInstanceId: input.subscriptionInstanceId,
        priceConsent: { amountMinor: input.priceConsent.amountMinor, currency: 'RUB' },
        savedAt: now.toISOString(),
      };
      writeLedger(storage, principal, replaceAttempt(ledger, attempt));
      return { attempt, created: true };
    },
  );
}

/**
 * Writes the durable "a POST may be on the wire now" marker. A second caller that sees the marker
 * must read the original operation instead of sending another POST.
 */
function markGameJoinAttemptDispatchStartedLocked(
  principal: GameJoinAttemptPrincipal,
  attempt: GameJoinAttempt,
  storage: Storage,
  options: { readonly now?: () => Date } = {},
): GameJoinAttempt {
  validatePrincipal(principal);
  const now = options.now?.() ?? new Date();
  const ledger = readLedger(principal, storage, now);
  const current = assertSameAttempt(attempt, findAttempt(ledger, attempt.gameId));
  if (current.state !== 'PENDING') throw new GameJoinAttemptError('ATTEMPT_STATE_CHANGED');
  if (current.dispatchStartedAt !== undefined) {
    throw new GameJoinAttemptError('ATTEMPT_ALREADY_DISPATCHED');
  }
  const marked: GameJoinAttempt = { ...current, dispatchStartedAt: now.toISOString() };
  writeLedger(storage, principal, replaceAttempt(ledger, marked));
  return marked;
}

export async function markGameJoinAttemptDispatchStarted(
  principal: GameJoinAttemptPrincipal,
  attempt: GameJoinAttempt,
  storage: Storage,
  options: { readonly now?: () => Date; readonly lockManager?: GameJoinAttemptLockManager } = {},
): Promise<GameJoinAttempt> {
  return withGameJoinLedgerLock(
    principal,
    options.lockManager ?? browserGameJoinAttemptLockManager(),
    () => markGameJoinAttemptDispatchStartedLocked(principal, attempt, storage, options),
  );
}

/**
 * Records the server-owned state of the same attempt. `SUCCEEDED` is only ever passed here after a
 * trusted server signal (`commercial.receipt` or `attemptState === 'OWNER_CONFIRMED'`).
 */
function resolveGameJoinAttemptLocked(
  principal: GameJoinAttemptPrincipal,
  attempt: GameJoinAttempt,
  resolution: GameJoinAttemptResolution,
  storage: Storage,
  options: { readonly now?: () => Date } = {},
): GameJoinAttempt {
  validatePrincipal(principal);
  if (resolution.operationId !== undefined && !isUuid(resolution.operationId)) {
    throw new GameJoinAttemptError('ATTEMPT_INVALID_INPUT');
  }
  const now = options.now?.() ?? new Date();
  const ledger = readLedger(principal, storage, now);
  const current = assertSameAttempt(attempt, findAttempt(ledger, attempt.gameId));
  const operationId = resolution.operationId ?? current.operationId;
  if (current.operationId && operationId !== current.operationId)
    throw new GameJoinAttemptError('ATTEMPT_STATE_CHANGED');
  if (current.state === 'SUCCEEDED') return current;
  const state: GameJoinAttemptState =
    resolution.state === 'PENDING' ? current.state : resolution.state;

  const resolved: GameJoinAttempt = {
    ...current,
    ...(operationId === undefined ? {} : { operationId }),
    ...(state === 'PENDING' ? {} : { state }),
    ...(state === 'SUCCEEDED' ? { resolvedAt: now.toISOString() } : {}),
  };
  writeLedger(storage, principal, replaceAttempt(ledger, resolved));
  return resolved;
}

export async function resolveGameJoinAttempt(
  principal: GameJoinAttemptPrincipal,
  attempt: GameJoinAttempt,
  resolution: GameJoinAttemptResolution,
  storage: Storage,
  options: { readonly now?: () => Date; readonly lockManager?: GameJoinAttemptLockManager } = {},
): Promise<GameJoinAttempt> {
  return withGameJoinLedgerLock(
    principal,
    options.lockManager ?? browserGameJoinAttemptLockManager(),
    () => resolveGameJoinAttemptLocked(principal, attempt, resolution, storage, options),
  );
}

/**
 * Forgets the attempt. An unresolved attempt may only be discarded when the server gave a definite
 * rejection that created no purchase; recovery/custody paths must keep it.
 */
function discardGameJoinAttemptLocked(
  principal: GameJoinAttemptPrincipal,
  attempt: GameJoinAttempt,
  storage: Storage,
  options: { readonly allowUnresolved?: boolean } = {},
): void {
  validatePrincipal(principal);
  const ledger = readLedger(principal, storage);
  const current = findAttempt(ledger, attempt.gameId);
  if (!current) return;
  assertSameAttempt(attempt, current);
  if (current.state !== 'SUCCEEDED' && !options.allowUnresolved) {
    throw new GameJoinAttemptError('ATTEMPT_UNRESOLVED');
  }
  writeLedger(storage, principal, {
    version: LEDGER_VERSION,
    attempts: ledger.attempts.filter((item) => item.gameId !== attempt.gameId),
  });
}

export async function discardGameJoinAttempt(
  principal: GameJoinAttemptPrincipal,
  attempt: GameJoinAttempt,
  storage: Storage,
  options: {
    readonly allowUnresolved?: boolean;
    readonly lockManager?: GameJoinAttemptLockManager;
  } = {},
): Promise<void> {
  return withGameJoinLedgerLock(
    principal,
    options.lockManager ?? browserGameJoinAttemptLockManager(),
    () => discardGameJoinAttemptLocked(principal, attempt, storage, options),
  );
}

export interface GameJoinQuietReleaseOptions {
  /** Overrides the quiet window; production callers keep the product constant. */
  readonly quietMs?: number;
  readonly now?: Date;
  readonly lockManager?: GameJoinAttemptLockManager;
}

/**
 * Closes a quiet, unresolved attempt under the same principal-wide Web Lock as begin/dispatch/resolve.
 * The decision is re-read inside the lock, so a dispatch that has already written
 * `dispatchStartedAt` keeps its custody instead of being raced: the caller gets `false` and the
 * attempt stays durable. Success custody is never removed here.
 *
 * The caller states which product rule it is applying, because the quiet clock and the proof differ:
 * an undispatched attempt is only released while the marker is still absent, and a 404 release only
 * after a marked dispatch.
 */
function releaseQuietGameJoinAttemptLocked(
  principal: GameJoinAttemptPrincipal,
  attempt: GameJoinAttempt,
  reason: 'UNDISPATCHED' | 'NOT_FOUND',
  storage: Storage,
  options: GameJoinQuietReleaseOptions,
): boolean {
  validatePrincipal(principal);
  const quietMs = options.quietMs ?? GAME_JOIN_ATTEMPT_QUIET_MS;
  if (!Number.isSafeInteger(quietMs) || quietMs < 0) {
    throw new GameJoinAttemptError('ATTEMPT_INVALID_INPUT');
  }
  const now = (options.now ?? new Date()).getTime();
  const ledger = readLedger(principal, storage, new Date(now));
  const current = findAttempt(ledger, attempt.gameId);
  if (!current) return true;
  assertSameAttempt(attempt, current);
  if (current.state === 'SUCCEEDED') return false;
  if (reason === 'UNDISPATCHED' && current.dispatchStartedAt !== undefined) return false;
  if (reason === 'NOT_FOUND' && current.dispatchStartedAt === undefined) return false;
  // Rule (a) measures from creation; rule (b) from the durable dispatch marker.
  const quietSince = Date.parse(
    reason === 'UNDISPATCHED' ? current.savedAt : (current.dispatchStartedAt as string),
  );
  if (Number.isNaN(quietSince)) throw new GameJoinAttemptError('ATTEMPT_MALFORMED');
  if (now - quietSince < quietMs) return false;
  writeLedger(storage, principal, {
    version: LEDGER_VERSION,
    attempts: ledger.attempts.filter((item) => item.gameId !== attempt.gameId),
  });
  return true;
}

/**
 * Rule (a): a `PENDING` attempt without `dispatchStartedAt` provably never sent a POST. Once quiet it
 * may be closed so a crash between "begin" and "dispatch" cannot block JOIN forever. If another tab
 * marked the dispatch meanwhile, custody is kept (`false`).
 */
export async function releaseUndispatchedGameJoinAttempt(
  principal: GameJoinAttemptPrincipal,
  attempt: GameJoinAttempt,
  storage: Storage,
  options: GameJoinQuietReleaseOptions = {},
): Promise<boolean> {
  return withGameJoinLedgerLock(
    principal,
    options.lockManager ?? browserGameJoinAttemptLockManager(),
    () => releaseQuietGameJoinAttemptLocked(principal, attempt, 'UNDISPATCHED', storage, options),
  );
}

/**
 * Rule (b): after a `GAME_OPERATION_NOT_FOUND` readback, a marked attempt is released only once the
 * dispatch is quiet enough that no durable server operation can still appear under the key. `false`
 * means custody was kept and the caller must keep offering readback only, never a new dispatch.
 */
export async function releaseNotFoundGameJoinAttempt(
  principal: GameJoinAttemptPrincipal,
  attempt: GameJoinAttempt,
  storage: Storage,
  options: GameJoinQuietReleaseOptions = {},
): Promise<boolean> {
  return withGameJoinLedgerLock(
    principal,
    options.lockManager ?? browserGameJoinAttemptLockManager(),
    () => releaseQuietGameJoinAttemptLocked(principal, attempt, 'NOT_FOUND', storage, options),
  );
}

/**
 * Dispatches the frozen attempt at most once. The principal-wide Web Lock serializes creation,
 * updates and dispatch across all games; the durable marker forbids a resend after lock release.
 * Without Web Locks dispatch fails closed and leaves the original custody intact.
 */
export async function withGameJoinDispatchGuard<TResult>(
  principal: GameJoinAttemptPrincipal,
  gameId: string,
  storage: Storage,
  lockManager: GameJoinAttemptLockManager | undefined,
  dispatch: (attempt: GameJoinAttempt) => Promise<TResult>,
  options: { readonly now?: () => Date } = {},
): Promise<GameJoinDispatchOutcome<TResult>> {
  validatePrincipal(principal);
  if (!isUuid(gameId)) throw new GameJoinAttemptError('ATTEMPT_INVALID_INPUT');
  const run = async (): Promise<GameJoinDispatchOutcome<TResult>> => {
    const ledger = readLedger(principal, storage, options.now?.() ?? new Date());
    const attempt = findAttempt(ledger, gameId) ?? null;
    if (!attempt) return { dispatched: false, reason: 'NO_ATTEMPT', attempt: null };
    if (attempt.state !== 'PENDING') {
      return { dispatched: false, reason: 'NOT_PENDING', attempt };
    }
    if (attempt.dispatchStartedAt !== undefined) {
      return { dispatched: false, reason: 'ALREADY_DISPATCHED', attempt };
    }
    let marked: GameJoinAttempt;
    try {
      marked = markGameJoinAttemptDispatchStartedLocked(principal, attempt, storage, options);
    } catch (error) {
      if (
        error instanceof GameJoinAttemptError &&
        (error.code === 'ATTEMPT_ALREADY_DISPATCHED' || error.code === 'ATTEMPT_STATE_CHANGED')
      ) {
        const current = findAttempt(
          readLedger(principal, storage, options.now?.() ?? new Date()),
          gameId,
        );
        return { dispatched: false, reason: 'ALREADY_DISPATCHED', attempt: current ?? attempt };
      }
      throw error;
    }
    return { dispatched: true, attempt: marked, value: await dispatch(marked) };
  };
  return withGameJoinLedgerLock(principal, lockManager, run);
}
