import type {
  ActivityHistoryItem as StoredActivityHistoryItem,
  ActivityHistoryKind,
  ActivityHistoryRepository,
  ActivityHistoryStatus,
  ProfileSummaryRepository,
} from '@phub/database';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { sendApiError } from '../http-errors.js';
import {
  gameCardProfilePhotoUserIds,
  stabilizeGameCardProfilePhotos,
} from '../profile/profile-photo-url.js';

const QUERY_KEYS = new Set(['kind', 'status', 'cursor', 'limit']);
const KINDS = new Set<ActivityHistoryKind>(['GAME', 'TRAINING', 'TOURNAMENT']);
const STATUSES = new Set<ActivityHistoryStatus>(['COMPLETED', 'CANCELLED']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ActivityHistoryRefreshService {
  refresh(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
    readonly reason: 'UNCOVERED' | 'STALE' | 'NEXT_PAGE';
  }): Promise<void>;
}

type HistoryCursor =
  | { readonly type: 'ITEM'; readonly occurredAt: string; readonly id: string }
  | { readonly type: 'COVERAGE' };

function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  const current = request as FastifyRequest & {
    readonly tenantId?: string;
    readonly padlHubClaims?: { readonly sub?: string };
  };
  const userId = current.padlHubClaims?.sub;
  return current.tenantId && userId ? { tenantId: current.tenantId, userId } : undefined;
}

function encodeCursor(value: HistoryCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value: unknown): HistoryCursor | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length < 16 || value.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (parsed.type === 'COVERAGE') {
      return Object.keys(parsed).every((key) => key === 'type') ? { type: 'COVERAGE' } : null;
    }
    if (
      Object.keys(parsed).some((key) => !['type', 'occurredAt', 'id'].includes(key)) ||
      parsed.type !== 'ITEM' ||
      typeof parsed.occurredAt !== 'string' ||
      Number.isNaN(Date.parse(parsed.occurredAt)) ||
      typeof parsed.id !== 'string' ||
      !UUID_PATTERN.test(parsed.id)
    ) {
      return null;
    }
    return {
      type: 'ITEM',
      occurredAt: new Date(parsed.occurredAt).toISOString(),
      id: parsed.id,
    };
  } catch {
    return null;
  }
}

function readStringDetail(
  details: Readonly<Record<string, unknown>>,
  key: 'subtitle' | 'trainerName' | 'result',
): string | null | undefined {
  const value = details[key];
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function activityItem(
  item: StoredActivityHistoryItem,
  tenantId: string,
  deliveryIds: ReadonlyMap<string, string>,
) {
  const game = item.details.game;
  return {
    id: item.id,
    kind: item.kind,
    status: item.status,
    title: item.title,
    occurredAt: item.occurredAt,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
    venue: item.venueName ?? '',
    route: item.route,
    subtitle: readStringDetail(item.details, 'subtitle') ?? null,
    trainerName: readStringDetail(item.details, 'trainerName') ?? null,
    result: readStringDetail(item.details, 'result') ?? null,
    ...(item.kind === 'GAME' && typeof game === 'object' && game !== null && !Array.isArray(game)
      ? { game: stabilizeGameCardProfilePhotos(game, tenantId, deliveryIds) }
      : {}),
  };
}

function parseQuery(request: FastifyRequest, reply: FastifyReply) {
  const query = request.query as Record<string, unknown>;
  const kind = typeof query.kind === 'string' ? query.kind : undefined;
  const status = typeof query.status === 'string' ? query.status : undefined;
  const limitText = query.limit;
  const limit =
    limitText === undefined
      ? 20
      : typeof limitText === 'string' && /^\d{1,2}$/.test(limitText)
        ? Number(limitText)
        : Number.NaN;
  const cursor = decodeCursor(query.cursor);
  if (
    Object.keys(query).some((key) => !QUERY_KEYS.has(key)) ||
    (kind !== undefined && !KINDS.has(kind as ActivityHistoryKind)) ||
    (status !== undefined && !STATUSES.has(status as ActivityHistoryStatus)) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    cursor === null
  ) {
    sendApiError(request, reply, 400, 'INVALID_REQUEST', 'Некорректные параметры истории.');
    return undefined;
  }
  return {
    limit,
    ...(kind ? { kind: kind as ActivityHistoryKind } : {}),
    ...(status ? { status: status as ActivityHistoryStatus } : {}),
    ...(cursor?.type === 'ITEM' ? { after: { occurredAt: cursor.occurredAt, id: cursor.id } } : {}),
  };
}

export function registerActivityHistoryRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: ActivityHistoryRepository;
    readonly refresher?: ActivityHistoryRefreshService;
    readonly photoRepository?: Pick<ProfileSummaryRepository, 'getPhotoDeliveryIds'>;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/user/api/v1/:tenantKey/bookings/history',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const current = principal(request);
      const query = parseQuery(request, reply);
      if (!query) return reply;
      if (!current || !options.repository) {
        return sendApiError(
          request,
          reply,
          503,
          'BOOKING_HISTORY_UNAVAILABLE',
          'История временно недоступна.',
        );
      }

      let state = await options.repository.getSyncState({
        tenantId: current.tenantId,
        userId: current.userId,
      });
      if (state.freshness === 'UNSYNCED') {
        if (!options.refresher) {
          return sendApiError(
            request,
            reply,
            503,
            'BOOKING_HISTORY_UNAVAILABLE',
            'История ещё не подготовлена.',
          );
        }
        try {
          await options.refresher.refresh({
            ...current,
            correlationId: request.id,
            reason: 'UNCOVERED',
          });
        } catch {
          reply.header('Retry-After', '5');
          return sendApiError(
            request,
            reply,
            503,
            'BOOKING_HISTORY_UNAVAILABLE',
            'История обновляется. Попробуйте ещё раз.',
          );
        }
        state = await options.repository.getSyncState({
          tenantId: current.tenantId,
          userId: current.userId,
        });
        if (state.freshness === 'UNSYNCED') {
          return sendApiError(
            request,
            reply,
            503,
            'BOOKING_HISTORY_UNAVAILABLE',
            'История ещё не подготовлена.',
          );
        }
      } else if (state.freshness === 'STALE' && options.refresher) {
        void options.refresher
          .refresh({ ...current, correlationId: request.id, reason: 'STALE' })
          .catch(() => undefined);
      }

      let page = await options.repository.list({ ...current, ...query });
      if (
        state.coverageStatus === 'PARTIAL' &&
        !page.next &&
        page.items.length < query.limit &&
        options.refresher
      ) {
        try {
          await options.refresher.refresh({
            ...current,
            correlationId: request.id,
            reason: 'NEXT_PAGE',
          });
        } catch {
          reply.header('Retry-After', '5');
          return sendApiError(
            request,
            reply,
            503,
            'BOOKING_HISTORY_UNAVAILABLE',
            'Следующая страница истории обновляется. Попробуйте ещё раз.',
          );
        }
        state = await options.repository.getSyncState({
          tenantId: current.tenantId,
          userId: current.userId,
        });
        page = await options.repository.list({ ...current, ...query });
      }

      const lastItem = page.items.at(-1);
      const deliveryIds = options.photoRepository
        ? await options.photoRepository.getPhotoDeliveryIds(
            current.tenantId,
            page.items.flatMap((item) => gameCardProfilePhotoUserIds(item.details.game)),
          )
        : new Map<string, string>();
      const nextCursor = page.next
        ? encodeCursor({ type: 'ITEM', ...page.next })
        : state.coverageStatus === 'PARTIAL' && lastItem
          ? encodeCursor({ type: 'ITEM', occurredAt: lastItem.occurredAt, id: lastItem.id })
          : state.coverageStatus === 'PARTIAL'
            ? encodeCursor({ type: 'COVERAGE' })
            : null;
      return {
        items: page.items.map((item) => activityItem(item, current.tenantId, deliveryIds)),
        nextCursor,
        freshness: state.freshness === 'STALE' ? 'STALE' : 'FRESH',
        coverage: state.coverageStatus === 'COMPLETE' ? 'COMPLETE' : 'PARTIAL',
        generatedAt: state.lastSuccessAt ?? new Date().toISOString(),
      };
    },
  );
}
