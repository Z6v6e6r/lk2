import { createHash } from 'node:crypto';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { withTenantTransaction } from '../../../../packages/database/src/connection.js';
import { AuthServiceError, type AuthService } from '../auth/auth-service.js';
import { sendApiError } from '../http-errors.js';
import type { SubscriptionRuntimeActorDelegationIssuer } from '../subscriptions/subscription-runtime-actor-delegation-issuer.js';
import type { WholeCourtPilot } from './game-whole-court-create.js';

const path = '/lk/integrations/v1/game-create-schedule';
const slotId = z.string().regex(/^[a-f0-9]{64}$/);
const querySchema = z
  .object({
    stationId: z.string().uuid(),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    durationMinutes: z.enum(['60', '90', '120']),
    slotId: slotId.optional(),
  })
  .strict();
const slotsSchema = z
  .object({
    slots: z
      .array(
        z
          .object({
            id: slotId,
            roomId: z.string().uuid(),
            courtName: z.string().trim().min(1).max(160),
            startsAt: z.iso.datetime({ offset: true }),
            endsAt: z.iso.datetime({ offset: true }),
          })
          .strict(),
      )
      .max(2000),
  })
  .strict();
const minor = z.number().int().positive().max(100_000_000);
const quoteSchema = z
  .object({
    wholeCourtMinor: minor.nullable(),
    shareMinor: minor.nullable(),
    subscriptionMinor: z.number().int().nonnegative().max(100_000_000).optional(),
    currency: z.literal('RUB'),
    observedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    residency: z.discriminatedUnion('status', [
      z.object({ status: z.literal('APPLIED'), amountMinor: minor }).strict(),
      z.object({ status: z.literal('ACTIVE_UNQUOTED') }).strict(),
      z.object({ status: z.literal('NOT_APPLICABLE') }).strict(),
      z.object({ status: z.literal('UNAVAILABLE') }).strict(),
    ]),
  })
  .strict();

interface Actor {
  readonly tenantKey: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly signal: AbortSignal;
}

type CheckoutCourt = Pick<WholeCourtPilot, 'courtId' | 'startsAt' | 'endsAt'> & {
  readonly providerStationId: string;
  readonly providerRoomId: string;
};

class ScheduleReadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function unavailable() {
  return new ScheduleReadError(503, 'GAME_CREATE_SCHEDULE_UNAVAILABLE');
}

export function gameCreateScheduleOwner(baseUrl: string, local: boolean) {
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/') return;
  if (
    base.origin === 'https://padlhub.su' ||
    (local && base.protocol === 'http:' && base.hostname === '127.0.0.1' && base.port === '24811')
  ) {
    return base.origin;
  }
}

async function readJson(response: Response) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    if (response.status === 409)
      throw new ScheduleReadError(409, 'GAME_CREATE_SCHEDULE_SLOT_CHANGED');
    if (response.status === 401 || response.status === 403)
      throw new ScheduleReadError(401, 'VIVA_REAUTH_REQUIRED');
    throw unavailable();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 524_288) {
        await reader.cancel();
        throw unavailable();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export function createGameCreateScheduleRead(input: {
  readonly baseUrl: string;
  readonly pool: Pool;
  readonly auth: Pick<AuthService, 'issueVivaAccessToken'>;
  readonly issuer?: Pick<SubscriptionRuntimeActorDelegationIssuer, 'issueGameCreateSchedule'>;
  readonly fetchImpl?: typeof fetch;
  readonly resolveCheckoutCourt?: (
    actor: Actor,
    stationId: string,
  ) => Promise<CheckoutCourt | undefined>;
}) {
  const endpoint = new URL(path, input.baseUrl);
  const pending = new Set<string>();
  const actorLimits = new Map<string, { count: number; until: number }>();
  let failures = 0;
  let blockedUntil = 0;
  return async (actor: Actor, query: z.infer<typeof querySchema>) => {
    if (endpoint.protocol === 'https:' && !input.issuer) throw unavailable();
    const key = `${actor.tenantId}:${actor.userId}`;
    if (Date.now() < blockedUntil || pending.has(key))
      throw new ScheduleReadError(429, 'GAME_CREATE_SCHEDULE_RATE_LIMITED');
    const now = Date.now();
    for (const [id, state] of actorLimits) {
      if (state.until <= now) actorLimits.delete(id);
    }
    const limit = actorLimits.get(key);
    if ((limit?.count ?? 0) >= 20 || (!limit && actorLimits.size >= 512))
      throw new ScheduleReadError(429, 'GAME_CREATE_SCHEDULE_RATE_LIMITED');
    actorLimits.set(key, { count: (limit?.count ?? 0) + 1, until: limit?.until ?? now + 60_000 });
    pending.add(key);
    try {
      const station = await withTenantTransaction(input.pool, actor.tenantId, async (client) => {
        await client.query("set local statement_timeout = '2500ms'");
        const { rows } = await client.query<{ external_id: string }>(
          `select distinct mapping.external_id from integration.external_entity_map mapping
          join locations.profiles station on station.id=mapping.internal_id
            and station.tenant_id=mapping.tenant_id and station.publication_status='PUBLISHED'
          join integration.identity_provider_bindings binding on binding.tenant_id=station.tenant_id
            and binding.provider='VIVA' and binding.provider_tenant_key='iSkq6G'
          where mapping.tenant_id=$1 and mapping.internal_id=$2
            and mapping.external_system='LK_LEGACY_SNAPSHOT' and mapping.entity_type='game_station'
            and mapping.sync_status='synced' and mapping.sync_error_code is null
            and mapping.last_synced_at is not null limit 3`,
          [actor.tenantId, query.stationId],
        );
        const ids = rows.map(({ external_id }) => external_id);
        const raw = ids.filter((value) => z.string().uuid().safeParse(value).success);
        if (raw.length !== 1) return;
        const provider = raw[0]!;
        const alias = createHash('sha256')
          .update('phub-local-public-clone-v1:station:' + provider)
          .digest('hex');
        if (ids.every((value) => value === provider || value === alias)) return provider;
      });
      if (!station) throw new ScheduleReadError(404, 'GAME_CREATE_SCHEDULE_STATION_UNAVAILABLE');
      actor.signal.throwIfAborted();
      const { accessToken, expiresAt } = await input.auth
        .issueVivaAccessToken(actor)
        .catch((error: unknown) => {
          if (error instanceof AuthServiceError) {
            if (error.code === 'VIVA_REAUTH_REQUIRED' || error.code === 'AUTH_SESSION_REVOKED')
              throw new ScheduleReadError(401, error.code);
            if (error.code === 'VIVA_DELEGATION_BUSY')
              throw new ScheduleReadError(429, 'GAME_CREATE_SCHEDULE_RATE_LIMITED');
          }
          throw unavailable();
        });
      if (!/^[A-Za-z\d._~-]{20,12000}$/.test(accessToken) || !(Date.parse(expiresAt) > Date.now()))
        throw new ScheduleReadError(401, 'VIVA_REAUTH_REQUIRED');
      const url = new URL(endpoint);
      url.search = new URLSearchParams({
        stationId: station,
        day: query.day,
        durationMinutes: query.durationMinutes,
        ...(query.slotId ? { slotId: query.slotId } : {}),
      }).toString();
      let raw: unknown;
      try {
        const delegation = await input.issuer?.issueGameCreateSchedule({
          ...actor,
          url,
          actorToken: { token: accessToken, expiresAt },
        });
        raw = await readJson(
          await (input.fetchImpl ?? fetch)(url, {
            method: 'GET',
            redirect: 'error',
            cache: 'no-store',
            signal: AbortSignal.any([actor.signal, AbortSignal.timeout(17_000)]),
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'X-Correlation-ID': actor.correlationId,
              ...(query.slotId ? { 'X-LK2-Schedule-Features': 'subscription-quote' } : {}),
              ...(delegation ? { 'X-Subscription-Actor-Delegation': delegation } : {}),
            },
          }),
        );
        failures = 0;
      } catch (error) {
        if (
          !actor.signal.aborted &&
          (!(error instanceof ScheduleReadError) || error.status === 503)
        ) {
          if (++failures >= 3) {
            blockedUntil = Date.now() + 30_000;
            failures = 0;
          }
        }
        throw error;
      }
      if (query.slotId) {
        const parsed = quoteSchema.safeParse(raw);
        if (!parsed.success) throw unavailable();
        const { wholeCourtMinor, shareMinor, subscriptionMinor, residency } = parsed.data;
        if (
          wholeCourtMinor === null
            ? shareMinor !== null || residency.status === 'APPLIED'
            : shareMinor !== Math.round(wholeCourtMinor / 4) ||
              (residency.status === 'APPLIED' && residency.amountMinor >= shareMinor)
        )
          throw unavailable();
        if (
          subscriptionMinor !== undefined &&
          (shareMinor === null || subscriptionMinor >= shareMinor)
        )
          throw unavailable();
        const expires = Date.parse(parsed.data.expiresAt);
        const observed = Date.parse(parsed.data.observedAt);
        if (
          expires <= Date.now() ||
          expires <= observed ||
          expires - observed > 30_000 ||
          observed > Date.now() + 5000
        )
          throw unavailable();
        return { quote: parsed.data };
      }
      const parsed = slotsSchema.safeParse(raw);
      if (
        !parsed.success ||
        new Set(parsed.data.slots.map(({ id }) => id)).size !== parsed.data.slots.length
      )
        throw unavailable();
      const slots = parsed.data.slots.filter(
        (slot) =>
          slot.startsAt.slice(0, 10) === query.day &&
          slot.startsAt.endsWith('+03:00') &&
          slot.endsAt.slice(0, 10) === query.day &&
          slot.endsAt.endsWith('+03:00') &&
          Date.parse(slot.startsAt) >= Date.now() + 30 * 60_000 &&
          Date.parse(slot.endsAt) - Date.parse(slot.startsAt) ===
            Number(query.durationMinutes) * 60000,
      );
      const checkout = slots.length
        ? await input.resolveCheckoutCourt?.(actor, query.stationId).catch(() => undefined)
        : undefined;
      return {
        slots: slots.map(({ roomId, ...slot }) => ({
          ...slot,
          courtKey: createHash('sha256')
            .update(`${actor.tenantId}\0${query.stationId}\0${roomId}`)
            .digest('hex'),
          amountMinor: null,
          ...(checkout &&
          checkout.providerStationId === station &&
          checkout.providerRoomId === roomId &&
          Date.parse(checkout.startsAt) === Date.parse(slot.startsAt) &&
          Date.parse(checkout.endsAt) === Date.parse(slot.endsAt)
            ? { checkoutCourtId: checkout.courtId }
            : {}),
        })),
      };
    } finally {
      pending.delete(key);
    }
  };
}

export function registerGameCreateScheduleRoutes(
  app: FastifyInstance,
  options: {
    readonly read?: ReturnType<typeof createGameCreateScheduleRead>;
    readonly handlers: readonly preHandlerHookHandler[];
  },
) {
  app.get(
    '/user/api/v1/:tenantKey/games/create-schedule',
    { preHandler: [...options.handlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const tenantKey = (request.params as { tenantKey: string }).tenantKey;
      const { tenantId, padlHubClaims: claims } = request;
      if (!tenantId || !claims?.sub || !claims.sid)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success)
        return sendApiError(
          request,
          reply,
          400,
          'GAME_CREATE_SCHEDULE_QUERY_INVALID',
          'Проверьте параметры расписания.',
        );
      const controller = new AbortController();
      reply.raw.once('close', () => controller.abort());
      try {
        if (!options.read) throw unavailable();
        const result = await options.read(
          {
            tenantKey,
            tenantId,
            userId: claims.sub,
            sessionId: claims.sid,
            correlationId: request.id,
            signal: controller.signal,
          },
          parsed.data,
        );
        request.log.info(
          {
            outcome: result.quote ? 'quote' : 'schedule',
            residency: result.quote?.residency.status,
          },
          'LK1 game create schedule',
        );
        return result;
      } catch (error) {
        const safe = error instanceof ScheduleReadError ? error : unavailable();
        request.log.info({ outcome: safe.code }, 'LK1 game create schedule');
        return sendApiError(
          request,
          reply,
          safe.status,
          safe.code,
          'Не удалось получить данные ЛК1.',
        );
      }
    },
  );
}
