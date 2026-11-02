import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendApiError } from '../http-errors.js';
import type {
  EventCatalogSnapshotStore,
  EventCatalogPage,
} from './event-catalog-snapshot-store.js';
import {
  buildTrainingEventCatalog,
  normalizeTrainingEventCatalogQuery,
  trainingEventCatalogQueryHash,
  trainingCatalogKind,
  type TrainingEventCatalogMetadata,
} from './training-event-catalog.js';
import type { EventCatalogItem } from './booking-recommendation-routes.js';
import type { TrainingCatalogueSource } from './training-catalogue-source.js';

const TTL_SECONDS = 600;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const listKeys = new Set(['localDates', 'kinds', 'categoryIds', 'stationIds']);
const numericKeys = new Set(['limit']);
function output(page: EventCatalogPage<EventCatalogItem>, now: number) {
  const metadata = page.metadata as
    (TrainingEventCatalogMetadata & { trainingCatalogueVersion?: number }) | undefined;
  if (
    !metadata ||
    metadata.trainingCatalogueVersion !== 1 ||
    !Number.isFinite(Date.parse(page.staleAt)) ||
    Date.parse(page.staleAt) <= now
  )
    return null;
  return {
    state: page.state,
    snapshotVersion: page.snapshotVersion,
    generatedAt: page.generatedAt,
    staleAt: page.staleAt,
    items: page.items,
    nextCursor: page.nextCursor,
    totalMatched: metadata.totalMatched,
    facets: metadata.facets,
    sourceStatus: metadata.sourceStatus,
  };
}

export function registerTrainingCatalogueRoutes(
  app: FastifyInstance,
  options: {
    readonly source?: TrainingCatalogueSource;
    readonly store?: EventCatalogSnapshotStore<EventCatalogItem>;
    readonly handlers: readonly ((
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void> | void)[];
    readonly now?: () => number;
  },
) {
  app.get(
    '/user/api/v1/:tenantKey/trainings/catalog',
    { preHandler: [...options.handlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer');
      const now = options.now ?? Date.now;
      const claims = request.padlHubClaims;
      if (!claims || !request.tenantId || typeof claims.sid !== 'string' || !claims.sid)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      const rawQuery = request.query as Record<string, unknown>;
      const bad = () =>
        sendApiError(
          request,
          reply,
          400,
          'TRAINING_CATALOGUE_INPUT_INVALID',
          'Параметры каталога недействительны.',
        );
      if (
        request.body !== undefined ||
        Object.values(rawQuery).some((value) => typeof value !== 'string' || /[\r\n]/.test(value))
      )
        return bad();
      const query = rawQuery as Record<string, string>;
      const limit = query.limit === undefined ? 20 : Number(query.limit);
      if (query.limit !== undefined && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(String(query.limit)))
        return bad();
      if (!options.source || !options.store)
        return sendApiError(
          request,
          reply,
          503,
          'TRAINING_CATALOGUE_UNAVAILABLE',
          'Каталог временно недоступен.',
        );
      try {
        if (query.cursor !== undefined) {
          if (
            Object.keys(query).some((key) => !['cursor', 'limit'].includes(key)) ||
            !uuid.test(String(query.cursor))
          )
            return bad();
          const result = await options.store.continuePage({
            cursor: String(query.cursor),
            tenantId: request.tenantId,
            userId: claims.sub,
            limit,
            ttlSeconds: TTL_SECONDS,
          });
          if (result.outcome === 'INVALID') return bad();
          const page = result.outcome === 'PAGE' ? output(result.page, now()) : null;
          if (!page)
            return sendApiError(
              request,
              reply,
              410,
              'CATALOG_CURSOR_EXPIRED',
              'Снимок каталога устарел. Обновите список.',
            );
          return page;
        }
        const parsed: Record<string, unknown> = { surface: 'TRAININGS', limit };
        for (const [key, value] of Object.entries(query)) {
          if (listKeys.has(key)) {
            const values = String(value).split(',');
            if (new Set(values).size !== values.length) return bad();
            parsed[key] = values;
          } else if (numericKeys.has(key)) {
            if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9])?$/.test(String(value))) return bad();
            parsed[key] = Number(value);
          } else if (['availability', 'startsAfterLocal', 'levelFrom', 'levelTo'].includes(key))
            parsed[key] = value;
          else return bad();
        }
        const normalized = normalizeTrainingEventCatalogQuery(parsed);
        if (!normalized || normalized.localDates.length > 7) return bad();
        const today = new Date(now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const allowed = new Set(
          Array.from({ length: 7 }, (_, day) =>
            new Date(Date.parse(today) + day * 86_400_000).toISOString().slice(0, 10),
          ),
        );
        if (normalized.localDates.some((date) => !allowed.has(date))) return bad();
        const generatedAt = new Date(now()).toISOString();
        const read = await options.source.read({
          tenantKey: (request.params as { tenantKey: string }).tenantKey,
          tenantId: request.tenantId,
          userId: claims.sub,
          sessionId: claims.sid,
          correlationId: request.id,
          dates: normalized.localDates,
        });
        const catalogue = buildTrainingEventCatalog({
          query: normalized,
          activities: read.activities,
          completedDates: read.completedDates,
          timezone: 'Europe/Moscow',
        });
        const snapshotId = randomUUID();
        const queryHash = trainingEventCatalogQueryHash(normalized);
        const created = await options.store.create(
          {
            snapshotId,
            tenantId: request.tenantId,
            userId: claims.sub,
            queryHash,
            version: createHash('sha256')
              .update(JSON.stringify([snapshotId, queryHash, generatedAt, catalogue.items]))
              .digest('hex'),
            generatedAt,
            staleAt: new Date(Date.parse(generatedAt) + TTL_SECONDS * 1000).toISOString(),
            state: catalogue.state,
            items: catalogue.items.map((activity) => ({
              kind: trainingCatalogKind(activity),
              activity,
            })),
            metadata: { ...catalogue.metadata, trainingCatalogueVersion: 1 },
          },
          TTL_SECONDS,
        );
        if (!created) throw new Error('CATALOGUE_STORE_UNAVAILABLE');
        const first = await options.store.firstPage({
          snapshotId,
          tenantId: request.tenantId,
          userId: claims.sub,
          queryHash,
          limit,
          ttlSeconds: TTL_SECONDS,
        });
        const page = first.outcome === 'PAGE' ? output(first.page, now()) : null;
        if (!page) throw new Error('CATALOGUE_STORE_UNAVAILABLE');
        return page;
      } catch {
        return sendApiError(
          request,
          reply,
          503,
          'TRAINING_CATALOGUE_UNAVAILABLE',
          'Каталог временно недоступен.',
        );
      }
    },
  );
}
