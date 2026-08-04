import { randomUUID } from 'node:crypto';

import type {
  ActivityHistoryItem as StoredActivityHistoryItem,
  ActivityHistoryKind,
  ActivityHistoryRepository,
  ActivityHistoryStatus,
  ProfileSummaryRepository,
} from '@phub/database';
import {
  normalizeVivaBookingHistoryPayload,
  type VivaBookingHistoryPage,
} from '@phub/viva-adapter';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import type { BookingScreenReadJobStore } from './booking-screen-read-job-store.js';
import { sendApiError } from '../http-errors.js';
import {
  gameCardProfilePhotoUserIds,
  stableProfilePhotoUrl,
  stabilizeGameCardProfilePhotos,
} from '../profile/profile-photo-url.js';

const QUERY_KEYS = new Set(['kind', 'status', 'cursor', 'limit']);
const KINDS = new Set<ActivityHistoryKind>(['GAME', 'TRAINING', 'TOURNAMENT']);
const STATUSES = new Set<ActivityHistoryStatus>(['COMPLETED', 'CANCELLED']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_ASSISTED_JOB_TTL_SECONDS = 120;

export interface ActivityHistoryRefreshService {
  refresh(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
    readonly reason: 'UNCOVERED' | 'STALE' | 'NEXT_PAGE';
  }): Promise<void>;
}

export interface ActivityHistoryProjectionService {
  project(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
    readonly reason: 'UNCOVERED' | 'STALE' | 'NEXT_PAGE';
    readonly page: VivaBookingHistoryPage;
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

interface TournamentHistoryPlayerResult {
  readonly profileId: string | null;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly place: number;
}

interface TournamentHistoryResult {
  readonly status: 'CONFIRMED';
  readonly podium: readonly TournamentHistoryPlayerResult[];
  readonly viewer: TournamentHistoryPlayerResult;
}

function tournamentPlayerResult(value: unknown): TournamentHistoryPlayerResult | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const profileId = row.profileId;
  const displayName = row.displayName;
  const avatarUrl = row.avatarUrl;
  const place = row.place;
  if (
    Object.keys(row).some(
      (key) => !['profileId', 'displayName', 'avatarUrl', 'place'].includes(key),
    ) ||
    (profileId !== null && (typeof profileId !== 'string' || !UUID_PATTERN.test(profileId))) ||
    typeof displayName !== 'string' ||
    displayName.trim().length < 1 ||
    displayName.length > 120 ||
    (avatarUrl !== null &&
      (typeof avatarUrl !== 'string' ||
        !avatarUrl.startsWith('/') ||
        avatarUrl.startsWith('//') ||
        avatarUrl.length > 512)) ||
    typeof place !== 'number' ||
    !Number.isInteger(place) ||
    place < 1 ||
    place > 10_000
  ) {
    return undefined;
  }
  return { profileId, displayName: displayName.trim(), avatarUrl, place };
}

function readTournamentResult(
  details: Readonly<Record<string, unknown>>,
): TournamentHistoryResult | undefined {
  const value = details.tournamentResult;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).some((key) => !['status', 'podium', 'viewer'].includes(key)) ||
    result.status !== 'CONFIRMED' ||
    !Array.isArray(result.podium) ||
    result.podium.length !== 3
  ) {
    return undefined;
  }
  const podium = result.podium.map(tournamentPlayerResult);
  const viewer = tournamentPlayerResult(result.viewer);
  if (
    podium.some((row) => row === undefined) ||
    podium.some((row, index) => row?.place !== index + 1) ||
    !viewer
  ) {
    return undefined;
  }
  return {
    status: 'CONFIRMED',
    podium: podium as readonly TournamentHistoryPlayerResult[],
    viewer,
  };
}

function tournamentResultProfilePhotoUserIds(
  details: Readonly<Record<string, unknown>>,
): readonly string[] {
  const result = readTournamentResult(details);
  if (!result) return [];
  return [...result.podium, result.viewer].flatMap((row) => (row.profileId ? [row.profileId] : []));
}

function stabilizeTournamentResultProfilePhotos(
  result: TournamentHistoryResult,
  tenantId: string,
  deliveryIds: ReadonlyMap<string, string>,
): TournamentHistoryResult {
  const stabilize = (row: TournamentHistoryPlayerResult): TournamentHistoryPlayerResult => ({
    ...row,
    avatarUrl: row.profileId
      ? (stableProfilePhotoUrl({
          tenantId,
          userId: row.profileId,
          currentUrl: row.avatarUrl,
          deliveryIds,
        }) as string | null)
      : row.avatarUrl,
  });
  return {
    ...result,
    podium: result.podium.map(stabilize),
    viewer: stabilize(result.viewer),
  };
}

function activityItem(
  item: StoredActivityHistoryItem,
  tenantId: string,
  deliveryIds: ReadonlyMap<string, string>,
) {
  const game = item.details.game;
  const tournamentResult =
    item.kind === 'TOURNAMENT' ? readTournamentResult(item.details) : undefined;
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
    ...(tournamentResult
      ? {
          tournamentResult: stabilizeTournamentResultProfilePhotos(
            tournamentResult,
            tenantId,
            deliveryIds,
          ),
        }
      : {}),
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
    readonly clientAssistedJobStore?: BookingScreenReadJobStore;
    readonly projector?: ActivityHistoryProjectionService;
    readonly providerPageSize?: number;
    readonly photoRepository?: Pick<ProfileSummaryRepository, 'getPhotoDeliveryIds'>;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.post(
    '/user/api/v1/:tenantKey/activity-history-read-jobs',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const current = principal(request);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const cursor = decodeCursor(body.cursor);
      const kind = typeof body.kind === 'string' ? body.kind : undefined;
      const status = typeof body.status === 'string' ? body.status : undefined;
      const limit = body.limit === undefined ? 20 : body.limit;
      if (
        !current ||
        !options.repository ||
        !options.clientAssistedJobStore ||
        !options.projector
      ) {
        return sendApiError(
          request,
          reply,
          503,
          'BOOKING_HISTORY_UNAVAILABLE',
          'История временно недоступна.',
        );
      }
      if (
        Object.keys(body).some((key) => !QUERY_KEYS.has(key)) ||
        cursor === null ||
        (body.cursor !== undefined && typeof body.cursor !== 'string') ||
        (kind !== undefined && !KINDS.has(kind as ActivityHistoryKind)) ||
        (status !== undefined && !STATUSES.has(status as ActivityHistoryStatus)) ||
        !Number.isInteger(limit) ||
        (limit as number) < 1 ||
        (limit as number) > 50
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'BOOKING_HISTORY_READ_JOB_INVALID',
          'Некорректный запрос обновления истории.',
        );
      }
      const state = await options.repository.getSyncState({
        tenantId: current.tenantId,
        userId: current.userId,
      });
      const projectedPage = cursor
        ? await options.repository.list({
            tenantId: current.tenantId,
            userId: current.userId,
            ...(kind ? { kind: kind as ActivityHistoryKind } : {}),
            ...(status ? { status: status as ActivityHistoryStatus } : {}),
            limit: limit as number,
            ...(cursor.type === 'ITEM'
              ? { after: { occurredAt: cursor.occurredAt, id: cursor.id } }
              : {}),
          })
        : undefined;
      const needsNextProviderPage =
        state.coverageStatus === 'PARTIAL' &&
        Boolean(state.nextProviderCursor) &&
        (cursor?.type === 'COVERAGE' ||
          (cursor?.type === 'ITEM' &&
            !projectedPage?.next &&
            (projectedPage?.items.length ?? 0) < (limit as number)));
      const reason =
        state.freshness === 'UNSYNCED'
          ? ('UNCOVERED' as const)
          : state.freshness === 'STALE'
            ? ('STALE' as const)
            : needsNextProviderPage
              ? ('NEXT_PAGE' as const)
              : undefined;
      const providerPage =
        reason === 'NEXT_PAGE' ? Number(state.nextProviderCursor) : reason ? 0 : undefined;
      if (providerPage !== undefined && (!Number.isInteger(providerPage) || providerPage < 0)) {
        return sendApiError(
          request,
          reply,
          503,
          'BOOKING_HISTORY_UNAVAILABLE',
          'История временно недоступна.',
        );
      }
      const now = new Date();
      const jobId = randomUUID();
      const commandId = reason ? randomUUID() : undefined;
      const job = {
        jobId,
        screen: 'ACTIVITY_HISTORY' as const,
        tenantId: current.tenantId,
        userId: current.userId,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + CLIENT_ASSISTED_JOB_TTL_SECONDS * 1_000).toISOString(),
        ...(reason ? { historyReason: reason } : {}),
        commands:
          reason && commandId && providerPage !== undefined
            ? [
                {
                  commandId,
                  operation: 'bookings.history.read' as const,
                  page: providerPage,
                  size: options.providerPageSize ?? 50,
                },
              ]
            : [],
      };
      if (!(await options.clientAssistedJobStore.create(job, CLIENT_ASSISTED_JOB_TTL_SECONDS))) {
        return sendApiError(
          request,
          reply,
          503,
          'BOOKING_HISTORY_UNAVAILABLE',
          'История временно недоступна.',
        );
      }
      return {
        jobId: job.jobId,
        screen: job.screen,
        expiresAt: job.expiresAt,
        commands: job.commands,
        concurrency: 1,
      };
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/activity-history-read-jobs/:jobId/results/:commandId',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const current = principal(request);
      const { jobId, commandId } = request.params as {
        readonly jobId?: string;
        readonly commandId?: string;
      };
      if (
        !current ||
        !jobId ||
        !commandId ||
        !UUID_PATTERN.test(jobId) ||
        !UUID_PATTERN.test(commandId) ||
        !options.clientAssistedJobStore
      ) {
        return sendApiError(
          request,
          reply,
          404,
          'BOOKING_HISTORY_READ_JOB_NOT_FOUND',
          'Задание обновления истории не найдено.',
        );
      }
      const job = await options.clientAssistedJobStore.get(jobId);
      const command = job?.commands.find((item) => item.commandId === commandId);
      if (
        !job ||
        job.screen !== 'ACTIVITY_HISTORY' ||
        job.tenantId !== current.tenantId ||
        job.userId !== current.userId ||
        command?.operation !== 'bookings.history.read'
      ) {
        return sendApiError(
          request,
          reply,
          404,
          'BOOKING_HISTORY_READ_JOB_NOT_FOUND',
          'Задание обновления истории не найдено.',
        );
      }
      const body = request.body as Record<string, unknown> | undefined;
      let page: VivaBookingHistoryPage;
      try {
        if (!body || Object.keys(body).length !== 1) throw new Error('INVALID_BODY');
        page = normalizeVivaBookingHistoryPayload(body.payload);
        if (page.page !== command.page || page.size !== command.size) {
          throw new Error('PAGE_MISMATCH');
        }
      } catch {
        return sendApiError(
          request,
          reply,
          400,
          'BOOKING_HISTORY_READ_RESULT_INVALID',
          'Некорректный результат чтения истории.',
        );
      }
      const ttlSeconds = Math.max(1, Math.ceil((Date.parse(job.expiresAt) - Date.now()) / 1_000));
      const status = await options.clientAssistedJobStore.putResult(
        jobId,
        { commandId, kind: 'history', page, acceptedAt: new Date().toISOString() },
        ttlSeconds,
      );
      return reply.status(status === 'accepted' ? 202 : 200).send({
        accepted: true,
        replayed: status === 'replayed',
        itemCount: page.records.length,
      });
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/activity-history-read-jobs/:jobId/complete',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const current = principal(request);
      const { jobId } = request.params as { readonly jobId?: string };
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (
        !current ||
        !jobId ||
        !UUID_PATTERN.test(jobId) ||
        !options.repository ||
        !options.clientAssistedJobStore ||
        !options.projector ||
        Object.keys(body).length !== 0
      ) {
        return sendApiError(
          request,
          reply,
          404,
          'BOOKING_HISTORY_READ_JOB_NOT_FOUND',
          'Задание обновления истории не найдено.',
        );
      }
      const job = await options.clientAssistedJobStore.get(jobId);
      if (
        !job ||
        job.screen !== 'ACTIVITY_HISTORY' ||
        job.tenantId !== current.tenantId ||
        job.userId !== current.userId
      ) {
        return sendApiError(
          request,
          reply,
          404,
          'BOOKING_HISTORY_READ_JOB_NOT_FOUND',
          'Задание обновления истории не найдено.',
        );
      }
      const results = await options.clientAssistedJobStore.getResults(
        job.jobId,
        job.commands.map((command) => command.commandId),
      );
      const result = results.find((item) => item.kind === 'history');
      if (job.historyReason && result?.kind === 'history') {
        try {
          await options.projector.project({
            tenantId: current.tenantId,
            userId: current.userId,
            correlationId: request.id,
            reason: job.historyReason,
            page: result.page,
          });
        } catch {
          await options.repository
            .recordSyncFailure({
              tenantId: current.tenantId,
              userId: current.userId,
              errorCode: 'CLIENT_ASSISTED_HISTORY_PROJECTION_FAILED',
            })
            .catch(() => undefined);
          return sendApiError(
            request,
            reply,
            503,
            'BOOKING_HISTORY_UNAVAILABLE',
            'Не удалось обновить историю.',
          );
        }
      } else if (job.historyReason) {
        await options.repository.recordSyncFailure({
          tenantId: current.tenantId,
          userId: current.userId,
          errorCode: 'CLIENT_ASSISTED_HISTORY_UNAVAILABLE',
        });
      }
      return {
        screen: job.screen,
        state: job.commands.length === results.length ? 'READY' : 'PARTIAL',
        completedCommands: results.length,
        totalCommands: job.commands.length,
      };
    },
  );

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
            page.items.flatMap((item) => [
              ...gameCardProfilePhotoUserIds(item.details.game),
              ...tournamentResultProfilePhotoUserIds(item.details),
            ]),
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
