import type {
  PublicTournamentSummary,
  TournamentParticipantRoster,
} from '@phub/legacy-games-adapter';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import type { EventAvatarMedia } from '../event-avatar-media.js';
import { sendApiError } from '../http-errors.js';

const QUERY_KEYS = new Set(['dateFrom', 'dateTo', 'availability', 'limit']);
const DETAIL_QUERY_KEYS = new Set(['dateFrom', 'dateTo']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TournamentSummarySource {
  readonly readDate: (date: string) => Promise<readonly PublicTournamentSummary[]>;
  /** One-way integration association key resolved to a PadlHub location before any client DTO. */
  readonly readStationExternalId?: (summaryId: string) => string | undefined;
  /** Private exercise identity used only for trusted canonical Game duplicate resolution. */
  readonly readExerciseExternalId?: (summaryId: string) => string | undefined;
  readonly readAvatarSource?: (summaryId: string) => string | undefined;
  readonly readTrainerAvatarSource?: (summaryId: string) =>
    | {
        readonly provider: 'VIVA';
        readonly providerTrainerId: string;
        readonly displayName: string;
        readonly sourceUrl?: string;
      }
    | undefined;
  readonly readParticipants?: (summaryId: string) => Promise<TournamentParticipantRoster>;
}

function dateValue(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function nextDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function datesBetween(from: string, to: string): readonly string[] | undefined {
  const dates: string[] = [];
  for (let current = from; current < to && dates.length <= 15; current = nextDate(current)) {
    dates.push(current);
  }
  return dates.length >= 1 && dates.length <= 15 ? dates : undefined;
}

function withOrganizerAvatar(
  item: PublicTournamentSummary,
  tenantKey: string,
  source: TournamentSummarySource,
): PublicTournamentSummary {
  if (
    !item.organizer ||
    (!source.readTrainerAvatarSource?.(item.id) && !source.readAvatarSource?.(item.id))
  )
    return item;
  return {
    ...item,
    organizer: {
      ...item.organizer,
      avatarUrl: `/public/api/v1/${encodeURIComponent(tenantKey)}/tournaments/${encodeURIComponent(item.id)}/organizer-avatar`,
    },
  };
}

export function registerTournamentSummaryRoutes(
  app: FastifyInstance,
  options: {
    readonly source?: TournamentSummarySource;
    readonly avatarMedia?: EventAvatarMedia;
    readonly publicTenantHandlers: readonly preHandlerHookHandler[];
    readonly authenticatedTenantHandlers?: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/public/api/v1/:tenantKey/tournaments',
    { preHandler: [...options.publicTenantHandlers] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as Record<string, unknown>;
      const dateFrom = dateValue(query.dateFrom);
      const dateTo = dateValue(query.dateTo);
      const availability =
        typeof query.availability === 'string' ? query.availability : 'INCLUDE_FULL';
      const limit = query.limit === undefined ? 20 : Number(query.limit);
      const dates = dateFrom && dateTo ? datesBetween(dateFrom, dateTo) : undefined;
      if (
        Object.keys(query).some((key) => !QUERY_KEYS.has(key)) ||
        !dates ||
        !['JOINABLE', 'INCLUDE_FULL'].includes(availability) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 50
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'INVALID_REQUEST',
          'Некорректные фильтры поиска турниров.',
        );
      }
      if (!options.source) {
        return sendApiError(
          request,
          reply,
          503,
          'TOURNAMENT_DISCOVERY_UNAVAILABLE',
          'Турниры временно недоступны.',
        );
      }
      const source = options.source;
      try {
        const pages: PublicTournamentSummary[][] = [];
        for (let index = 0; index < dates.length; index += 2) {
          const batch = dates.slice(index, index + 2);
          pages.push(
            ...(await Promise.all(batch.map((date) => source.readDate(date)))).map((items) => [
              ...items,
            ]),
          );
        }
        const items = pages
          .flat()
          .filter((item) => availability === 'INCLUDE_FULL' || item.capacity.open > 0)
          .sort(
            (left, right) =>
              left.startsAt.localeCompare(right.startsAt) || left.id.localeCompare(right.id),
          )
          .slice(0, limit)
          .map((item) =>
            withOrganizerAvatar(item, (request.params as { tenantKey: string }).tenantKey, source),
          );
        reply.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=90');
        return { items };
      } catch {
        return sendApiError(
          request,
          reply,
          503,
          'TOURNAMENT_DISCOVERY_UNAVAILABLE',
          'Турниры временно недоступны.',
        );
      }
    },
  );

  app.get(
    '/public/api/v1/:tenantKey/tournaments/:summaryId',
    { preHandler: [...options.publicTenantHandlers] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { summaryId, tenantKey } = request.params as {
        summaryId?: string;
        tenantKey: string;
      };
      const query = request.query as Record<string, unknown>;
      const dateFrom = dateValue(query.dateFrom);
      const dateTo = dateValue(query.dateTo);
      const dates = dateFrom && dateTo ? datesBetween(dateFrom, dateTo) : undefined;
      if (!summaryId || !UUID_PATTERN.test(summaryId)) {
        return sendApiError(request, reply, 404, 'TOURNAMENT_NOT_FOUND', 'Турнир не найден.');
      }
      if (Object.keys(query).some((key) => !DETAIL_QUERY_KEYS.has(key)) || !dates) {
        return sendApiError(
          request,
          reply,
          400,
          'INVALID_REQUEST',
          'Некорректные параметры турнира.',
        );
      }
      if (!options.source) {
        return sendApiError(
          request,
          reply,
          503,
          'TOURNAMENT_DISCOVERY_UNAVAILABLE',
          'Турниры временно недоступны.',
        );
      }
      const source = options.source;
      try {
        for (let index = 0; index < dates.length; index += 2) {
          const batch = dates.slice(index, index + 2);
          const pages = await Promise.all(batch.map((date) => source.readDate(date)));
          const item = pages.flat().find((candidate) => candidate.id === summaryId);
          if (item) {
            reply.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=90');
            return withOrganizerAvatar(item, tenantKey, source);
          }
        }
        return sendApiError(request, reply, 404, 'TOURNAMENT_NOT_FOUND', 'Турнир не найден.');
      } catch (error) {
        request.log.warn({ error, summaryId }, 'tournament summary read failed');
        return sendApiError(
          request,
          reply,
          503,
          'TOURNAMENT_DISCOVERY_UNAVAILABLE',
          'Турниры временно недоступны.',
        );
      }
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/tournaments/:summaryId/participants',
    {
      preHandler: [...(options.authenticatedTenantHandlers ?? [])],
      config: { rateLimit: { max: 60, timeWindow: 60_000 } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { summaryId } = request.params as { summaryId?: string };
      if (!summaryId || !UUID_PATTERN.test(summaryId)) {
        return sendApiError(request, reply, 404, 'TOURNAMENT_NOT_FOUND', 'Турнир не найден.');
      }
      if (!options.source?.readParticipants) {
        return sendApiError(
          request,
          reply,
          503,
          'TOURNAMENT_PARTICIPANTS_UNAVAILABLE',
          'Список участников временно недоступен.',
        );
      }
      try {
        const roster = await options.source.readParticipants(summaryId);
        reply.header('Cache-Control', 'private, no-store');
        return roster;
      } catch (error) {
        request.log.warn({ error, summaryId }, 'tournament participants read failed');
        return sendApiError(
          request,
          reply,
          503,
          'TOURNAMENT_PARTICIPANTS_UNAVAILABLE',
          'Список участников временно недоступен.',
        );
      }
    },
  );

  app.get(
    '/public/api/v1/:tenantKey/tournaments/:summaryId/organizer-avatar',
    {
      preHandler: [...options.publicTenantHandlers],
      config: { rateLimit: { max: 300, timeWindow: 60_000 } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { summaryId } = request.params as { summaryId?: string };
      if (!summaryId || !UUID_PATTERN.test(summaryId)) {
        return sendApiError(request, reply, 404, 'EVENT_AVATAR_NOT_FOUND', 'Аватар не найден.');
      }
      const trainer = options.source?.readTrainerAvatarSource?.(summaryId);
      const sourceUrl = trainer?.sourceUrl ?? options.source?.readAvatarSource?.(summaryId);
      if ((!sourceUrl && !trainer) || !options.avatarMedia) {
        return sendApiError(request, reply, 404, 'EVENT_AVATAR_NOT_FOUND', 'Аватар не найден.');
      }
      try {
        const media = await options.avatarMedia.read({
          cacheKey: `tournament:${summaryId}`,
          ...(sourceUrl ? { sourceUrl } : {}),
          ...(request.tenantId ? { tenantId: request.tenantId } : {}),
          ...(trainer ? { trainer } : {}),
        });
        reply.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
        reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
        reply.header('ETag', media.etag);
        reply.type('image/webp');
        return reply.send(media.body);
      } catch (error) {
        request.log.error({ err: error, summaryId }, 'tournament organizer avatar delivery failed');
        return sendApiError(
          request,
          reply,
          503,
          'EVENT_AVATAR_UNAVAILABLE',
          'Аватар временно недоступен.',
        );
      }
    },
  );
}
