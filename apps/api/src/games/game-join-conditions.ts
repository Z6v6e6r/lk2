import type { GameJoinConditions } from '@phub/api-sdk';
import { z } from 'zod';

const uuid = z.string().uuid();
const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const instant = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const quoteSchema = z.object({
  subscriptionId: uuid,
  selectionKey: z.string(),
  status: z.enum(['AVAILABLE', 'UNAVAILABLE', 'LIMIT_USED']),
  basePriceMinor: minor.nullable(),
  amountMinor: minor.nullable(),
  freeMinutes: minor,
  paidMinutes: minor,
  reasonCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,99}$/)
    .nullable(),
  evaluatedAt: instant,
  expiresAt: instant,
});

export interface GameJoinConditionsActor {
  readonly tenantKey: string;
  readonly correlationId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly gameId: string;
  readonly expectedRevision: number;
  readonly subscriptionInstanceId: string;
}

/** One owner-resolved selection. No amount, rule, usage or external ID comes from the caller. */
export interface Lk1GamePreviewSelection extends GameJoinConditionsActor {
  readonly revision: number;
  readonly sourceVersion: string;
  readonly legacyGameId: string;
  readonly legacySubscriptionId: string;
  readonly providerClientId: string;
  readonly providerTenantKey: string;
  readonly startsAt: string;
  readonly durationMinutes: 90;
  /** Existing, actor-bound LK1 user context held only by the server. Never a system token. */
  readonly authorization: string;
  readonly providerMode: 'MOCK' | 'LIVE';
}

export interface GameJoinConditionsOwner {
  /** Must verify active session, tenant, game access and unique owned subscription mappings. */
  resolveSelection(
    actor: GameJoinConditionsActor,
    signal: AbortSignal,
  ): Promise<Lk1GamePreviewSelection | null>;
  readPreview(
    selection: Lk1GamePreviewSelection,
    signal: AbortSignal,
    correlationId: string,
  ): Promise<unknown>;
}

export class GameJoinConditionsError extends Error {
  public constructor(
    public readonly code: string,
    public readonly status = 503,
  ) {
    super(code);
  }
}

function matchesActor(selection: Lk1GamePreviewSelection, actor: GameJoinConditionsActor): boolean {
  return (
    selection.tenantKey === actor.tenantKey &&
    selection.correlationId === actor.correlationId &&
    selection.tenantId === actor.tenantId &&
    selection.userId === actor.userId &&
    selection.sessionId === actor.sessionId &&
    selection.gameId === actor.gameId &&
    selection.subscriptionInstanceId === actor.subscriptionInstanceId &&
    selection.expectedRevision === actor.expectedRevision
  );
}

function sameSelection(a: Lk1GamePreviewSelection, b: Lk1GamePreviewSelection): boolean {
  return (
    a.revision === b.revision &&
    a.sourceVersion === b.sourceVersion &&
    a.legacyGameId === b.legacyGameId &&
    a.legacySubscriptionId === b.legacySubscriptionId &&
    a.providerClientId === b.providerClientId &&
    a.providerTenantKey === b.providerTenantKey &&
    a.startsAt === b.startsAt &&
    a.durationMinutes === b.durationMinutes &&
    a.providerMode === b.providerMode
  );
}

export async function readGameJoinConditions(
  owner: GameJoinConditionsOwner,
  actor: GameJoinConditionsActor,
  correlationId: string,
  options: { readonly now?: () => number; readonly timeoutMs?: number } = {},
): Promise<GameJoinConditions> {
  const now = options.now ?? Date.now;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async (): Promise<GameJoinConditions> => {
        const selection = await owner.resolveSelection(actor, controller.signal);
        if (!selection || !matchesActor(selection, actor)) {
          throw new GameJoinConditionsError('GAME_JOIN_CONDITIONS_MAPPING_UNAVAILABLE');
        }
        if (selection.revision !== actor.expectedRevision) {
          throw new GameJoinConditionsError('GAME_JOIN_CONDITIONS_REVISION_CHANGED', 409);
        }
        if (
          !selection.sourceVersion ||
          selection.durationMinutes !== 90 ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(selection.legacyGameId) ||
          !uuid.safeParse(selection.legacySubscriptionId).success ||
          !/^Bearer \S+$/i.test(selection.authorization) ||
          !['MOCK', 'LIVE'].includes(selection.providerMode) ||
          !Number.isFinite(Date.parse(selection.startsAt)) ||
          Date.parse(selection.startsAt) <= now()
        ) {
          throw new GameJoinConditionsError('GAME_JOIN_CONDITIONS_SELECTION_INVALID');
        }
        const raw = await owner.readPreview(selection, controller.signal, correlationId);
        const parsed = z.object({ quotes: z.array(quoteSchema).length(1) }).safeParse(raw);
        if (!parsed.success)
          throw new GameJoinConditionsError('GAME_JOIN_CONDITIONS_RESPONSE_INVALID');
        const quote = parsed.data.quotes[0]!;
        const expectedSelection = JSON.stringify([
          'EXISTING_GAME',
          selection.legacyGameId,
          selection.startsAt,
          90,
        ]);
        if (
          quote.subscriptionId !== selection.legacySubscriptionId ||
          quote.selectionKey !== expectedSelection ||
          quote.evaluatedAt > now() + 5000 ||
          quote.expiresAt <= now() ||
          quote.expiresAt <= quote.evaluatedAt ||
          quote.expiresAt - quote.evaluatedAt > 60_000 ||
          (quote.status !== 'AVAILABLE' &&
            (quote.amountMinor !== null ||
              quote.reasonCode === null ||
              quote.freeMinutes !== 0 ||
              quote.paidMinutes !== 0)) ||
          (quote.status === 'AVAILABLE' &&
            (quote.reasonCode !== null ||
              quote.basePriceMinor === null ||
              quote.amountMinor === null ||
              quote.amountMinor > quote.basePriceMinor ||
              quote.freeMinutes + quote.paidMinutes !== 90)) ||
          quote.freeMinutes + quote.paidMinutes > 90
        ) {
          throw new GameJoinConditionsError('GAME_JOIN_CONDITIONS_RESPONSE_INVALID');
        }
        // Recheck the exact selection after the read; no fields are merged from the two versions.
        const current = await owner.resolveSelection(actor, controller.signal);
        if (!current || !matchesActor(current, actor) || !sameSelection(selection, current)) {
          throw new GameJoinConditionsError('GAME_JOIN_CONDITIONS_REVISION_CHANGED', 409);
        }
        if (quote.expiresAt <= now())
          throw new GameJoinConditionsError('GAME_JOIN_CONDITIONS_EXPIRED', 409);
        if (controller.signal.aborted)
          throw new GameJoinConditionsError('GAME_JOIN_CONDITIONS_TIMEOUT');
        const amount = quote.status === 'AVAILABLE' ? quote.amountMinor : null;
        return {
          gameId: actor.gameId,
          revision: selection.revision,
          ownerRevision: null,
          subscriptionInstanceId: actor.subscriptionInstanceId,
          eligibility: quote.status,
          reasonCode: quote.reasonCode,
          subscriptionApplied: quote.status === 'AVAILABLE' && amount !== null,
          price: {
            status: amount === null ? 'MISSING' : 'ADVISORY',
            amountMinor: amount,
            currency: 'RUB',
            confirmed: false,
          },
          freeMinutes: quote.freeMinutes,
          paidMinutes: quote.paidMinutes,
          evaluatedAt: new Date(quote.evaluatedAt).toISOString(),
          expiresAt: new Date(quote.expiresAt).toISOString(),
          nonBinding: true,
          requiresReservationRecheck: true,
          source: 'LK1_PRICE_PREVIEW',
          providerMode: selection.providerMode,
        };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new GameJoinConditionsError('GAME_JOIN_CONDITIONS_TIMEOUT'));
        }, options.timeoutMs ?? 28_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Narrow existing preview transport. It cannot call a business command or follow a redirect. */
export function createLk1GamePricePreviewRead(
  baseUrl: string,
  fetchImplementation: typeof fetch = fetch,
): GameJoinConditionsOwner['readPreview'] {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new GameJoinConditionsError('GAME_JOIN_CONDITIONS_ENDPOINT_INVALID');
  }
  const url = new URL('/lk/subscriptions/game-price-preview', base);
  const read: GameJoinConditionsOwner['readPreview'] = async (selection, signal, correlationId) => {
    const response = await fetchImplementation(url, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      signal,
      headers: {
        Authorization: selection.authorization,
        'Content-Type': 'application/json',
        'X-Correlation-ID': correlationId,
      },
      body: JSON.stringify({
        target: {
          targetKind: 'EXISTING_GAME',
          gameId: selection.legacyGameId,
          startsAt: selection.startsAt,
          durationMinutes: selection.durationMinutes,
        },
        subscriptionIds: [selection.legacySubscriptionId],
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new GameJoinConditionsError('GAME_JOIN_CONDITIONS_OWNER_UNAVAILABLE');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new GameJoinConditionsError('GAME_JOIN_CONDITIONS_RESPONSE_INVALID');
    let body = '',
      bytes = 0;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 32_768) {
          await reader.cancel();
          throw new GameJoinConditionsError('GAME_JOIN_CONDITIONS_RESPONSE_INVALID');
        }
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new GameJoinConditionsError('GAME_JOIN_CONDITIONS_RESPONSE_INVALID');
    }
  };
  let failures = 0,
    retryAfter = 0;
  return async (selection, signal, correlationId) => {
    if (Date.now() < retryAfter)
      throw new GameJoinConditionsError('GAME_JOIN_CONDITIONS_CIRCUIT_OPEN');
    try {
      const result = await read(selection, signal, correlationId);
      failures = 0;
      return result;
    } catch (error) {
      failures += 1;
      if (failures >= 3) retryAfter = Date.now() + 30_000;
      throw error;
    }
  };
}
