import { createHash, randomUUID } from 'node:crypto';

import type {
  BookingPreferencesRepository,
  BookingScreenMappingRepository,
  GameRepository,
  ProfileFriendshipRepository,
  ProfileSummaryRepository,
} from '@phub/database';
import {
  localVivaExerciseAssociationId,
  type PublicTournamentSummary,
} from '@phub/legacy-games-adapter';
import {
  isGroupTrainingCatalogActivity,
  normalizeVivaExerciseRecommendationPayload,
  normalizeVivaUpcomingBookingPayload,
  vivaReadSnapshotUuid,
  type VivaExerciseRecommendation,
  type VivaExerciseRecommendationSourceAdapter,
} from '@phub/viva-adapter';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import type { EventAvatarMedia } from '../event-avatar-media.js';
import { sendApiError } from '../http-errors.js';
import type { TournamentSummarySource } from '../tournaments/tournament-summary-routes.js';
import type {
  BookingScreenReadJob,
  BookingScreenReadJobStore,
} from './booking-screen-read-job-store.js';
import { listBookingRecommendations } from './booking-recommendations.js';

type CardReadRepository = Pick<GameRepository, 'listRecommendationCardProjections'>;
type ExerciseRecommendationSource = Pick<VivaExerciseRecommendationSourceAdapter, 'readDate'> &
  Partial<
    Pick<
      VivaExerciseRecommendationSourceAdapter,
      | 'readAvatarSource'
      | 'registerAvatarSource'
      | 'readTrainerAvatarSource'
      | 'registerTrainerAvatarSource'
    >
  >;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_ASSISTED_JOB_TTL_SECONDS = 120;
const CLIENT_ASSISTED_DAYS = 7;

function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  const tenantId = request.tenantId;
  const userId = request.padlHubClaims?.sub;
  return tenantId && userId ? { tenantId, userId } : undefined;
}

function limitValue(value: unknown): number | undefined {
  if (value === undefined) return 6;
  if (typeof value !== 'string' || !/^\d{1,2}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 20 ? parsed : undefined;
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'BOOKING_RECOMMENDATIONS_UNAVAILABLE',
    'Персональные рекомендации временно недоступны.',
  );
}

function moscowDate(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

function recommendationDates(now: Date): readonly string[] {
  return Array.from({ length: CLIENT_ASSISTED_DAYS }, (_, index) =>
    moscowDate(new Date(now.getTime() + index * 24 * 60 * 60 * 1_000)),
  );
}

function validProviderSchedulePayload(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.content) || Array.isArray(record.items);
}

function exerciseAssociationIds(externalId: string): readonly string[] {
  try {
    return [externalId, localVivaExerciseAssociationId(externalId)];
  } catch {
    return [externalId];
  }
}

function snapshotVersion(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function samePrincipal(
  job: BookingScreenReadJob,
  current: { readonly tenantId: string; readonly userId: string },
): boolean {
  return (
    job.tenantId === current.tenantId &&
    job.userId === current.userId &&
    Date.parse(job.expiresAt) > Date.now()
  );
}

async function readActivities(input: {
  readonly source?: ExerciseRecommendationSource;
  readonly getAccessToken?: (input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
  }) => Promise<string>;
  readonly tenantId: string;
  readonly userId: string;
  readonly correlationId: string;
  readonly now: Date;
}): Promise<readonly VivaExerciseRecommendation[]> {
  if (!input.source || !input.getAccessToken) return [];
  try {
    const source = input.source;
    const accessToken = await input.getAccessToken({
      tenantId: input.tenantId,
      userId: input.userId,
      correlationId: input.correlationId,
    });
    const pages = await Promise.allSettled(
      recommendationDates(input.now).map((date) =>
        source.readDate({
          date,
          accessToken,
          correlationId: input.correlationId,
        }),
      ),
    );
    return pages.flatMap((page) =>
      page.status === 'fulfilled'
        ? page.value.filter((activity) => activity.kind === 'TRAINING')
        : [],
    );
  } catch {
    return [];
  }
}

async function readTournaments(input: {
  readonly source?: TournamentSummarySource;
  readonly dates: readonly string[];
}): Promise<readonly PublicTournamentSummary[]> {
  if (!input.source) return [];
  const pages = await Promise.allSettled(input.dates.map((date) => input.source!.readDate(date)));
  const byId = new Map<string, PublicTournamentSummary>();
  for (const tournament of pages.flatMap((page) =>
    page.status === 'fulfilled' ? page.value : [],
  )) {
    byId.set(tournament.id, tournament);
  }
  return [...byId.values()];
}

function completedScheduleDates(
  job: BookingScreenReadJob,
  results: readonly { readonly commandId: string; readonly kind: string }[],
): readonly string[] {
  const completedCommandIds = new Set(
    results.filter((result) => result.kind === 'schedule').map((result) => result.commandId),
  );
  return job.commands.flatMap((command) =>
    command.operation === 'schedule.read' && completedCommandIds.has(command.commandId)
      ? [command.date]
      : [],
  );
}

function activityHostAvatarUrl(tenantKey: string, activityId: string): string {
  return `/public/api/v1/${encodeURIComponent(tenantKey)}/booking-activities/${encodeURIComponent(activityId)}/host-avatar`;
}

function withHostAvatarUrls(
  activities: readonly VivaExerciseRecommendation[],
  source: ExerciseRecommendationSource | undefined,
  tenantKey: string,
): readonly VivaExerciseRecommendation[] {
  if (!source?.readAvatarSource && !source?.readTrainerAvatarSource) return activities;
  return activities.map((activity) =>
    activity.host &&
    (source.readTrainerAvatarSource?.(activity.id) || source.readAvatarSource?.(activity.id))
      ? {
          ...activity,
          host: {
            ...activity.host,
            avatarUrl: activityHostAvatarUrl(tenantKey, activity.id),
          },
        }
      : activity,
  );
}

function withTournamentOrganizerAvatarUrls(
  tournaments: readonly PublicTournamentSummary[],
  source: TournamentSummarySource | undefined,
  tenantKey: string,
): readonly PublicTournamentSummary[] {
  if (!source?.readAvatarSource && !source?.readTrainerAvatarSource) return tournaments;
  return tournaments.map((tournament) =>
    tournament.organizer &&
    (source.readTrainerAvatarSource?.(tournament.id) || source.readAvatarSource?.(tournament.id))
      ? {
          ...tournament,
          organizer: {
            ...tournament.organizer,
            avatarUrl: `/public/api/v1/${encodeURIComponent(tenantKey)}/tournaments/${encodeURIComponent(tournament.id)}/organizer-avatar`,
          },
        }
      : tournament,
  );
}

export function registerBookingRecommendationRoutes(
  app: FastifyInstance,
  options: {
    readonly gameRepository?: CardReadRepository;
    readonly photoRepository?: Pick<ProfileSummaryRepository, 'getPhotoDeliveryIds'>;
    readonly preferencesRepository?: BookingPreferencesRepository;
    readonly friendshipRepository?: Pick<ProfileFriendshipRepository, 'list'>;
    readonly exerciseSource?: ExerciseRecommendationSource;
    readonly tournamentSource?: TournamentSummarySource;
    readonly clientAssistedJobStore?: BookingScreenReadJobStore;
    readonly bookingScreenMappingRepository?: BookingScreenMappingRepository;
    readonly getExerciseAccessToken?: (input: {
      readonly tenantId: string;
      readonly userId: string;
      readonly correlationId: string;
    }) => Promise<string>;
    readonly avatarMedia?: EventAvatarMedia;
    readonly publicTenantHandlers: readonly preHandlerHookHandler[];
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.post(
    '/user/api/v1/:tenantKey/booking-screen-read-jobs',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const body = request.body as Record<string, unknown> | undefined;
      if (
        !body ||
        Object.keys(body).length !== 1 ||
        (body.screen !== 'FOR_ME' &&
          body.screen !== 'GROUP_TRAININGS' &&
          body.screen !== 'MY_BOOKINGS')
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'BOOKING_SCREEN_READ_JOB_INVALID',
          'Некорректный запрос экрана записей.',
        );
      }
      if (!options.clientAssistedJobStore) return unavailable(request, reply);

      const now = new Date();
      const jobId = randomUUID();
      const screen = body.screen;
      const job: BookingScreenReadJob = {
        jobId,
        screen,
        tenantId: current.tenantId,
        userId: current.userId,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + CLIENT_ASSISTED_JOB_TTL_SECONDS * 1_000).toISOString(),
        commands:
          screen !== 'MY_BOOKINGS'
            ? recommendationDates(now).map((date) => ({
                commandId: randomUUID(),
                operation: 'schedule.read' as const,
                date,
              }))
            : [
                {
                  commandId: randomUUID(),
                  operation: 'bookings.read',
                  detailsOperation: 'bookings.details.read',
                  page: 0,
                  size: 50,
                },
              ],
      };
      if (!(await options.clientAssistedJobStore.create(job, CLIENT_ASSISTED_JOB_TTL_SECONDS))) {
        return unavailable(request, reply);
      }
      return {
        jobId: job.jobId,
        screen: job.screen,
        expiresAt: job.expiresAt,
        commands: job.commands,
        concurrency: job.screen === 'MY_BOOKINGS' ? 1 : 3,
      };
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/booking-screen-read-jobs/:jobId/results/:commandId',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const { jobId, commandId } = request.params as {
        readonly jobId?: string;
        readonly commandId?: string;
      };
      if (
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
          'BOOKING_SCREEN_READ_JOB_NOT_FOUND',
          'Задание чтения не найдено.',
        );
      }
      const job = await options.clientAssistedJobStore.get(jobId);
      const command = job?.commands.find((item) => item.commandId === commandId);
      if (!job || !command || !samePrincipal(job, current)) {
        return sendApiError(
          request,
          reply,
          404,
          'BOOKING_SCREEN_READ_JOB_NOT_FOUND',
          'Задание чтения не найдено.',
        );
      }
      const body = request.body as Record<string, unknown> | undefined;
      if (
        !body ||
        Object.keys(body).length !== 1 ||
        (command.operation === 'schedule.read'
          ? !validProviderSchedulePayload(body.payload)
          : typeof body.payload !== 'object' ||
            body.payload === null ||
            Array.isArray(body.payload))
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'BOOKING_SCREEN_READ_RESULT_INVALID',
          'Некорректный результат чтения.',
        );
      }
      let result:
        | {
            readonly kind: 'schedule';
            readonly activities: readonly VivaExerciseRecommendation[];
          }
        | {
            readonly kind: 'upcoming';
            readonly bookings: readonly {
              readonly id: string;
              readonly kind: 'game' | 'training' | 'tournament';
              readonly title: string;
              readonly startsAt: string;
              readonly endsAt?: string;
              readonly venue: string;
              readonly status: 'confirmed' | 'waitlist' | 'payment_required';
              readonly route: string;
            }[];
          };
      try {
        if (command.operation === 'schedule.read') {
          result = {
            kind: 'schedule',
            activities: normalizeVivaExerciseRecommendationPayload(body.payload, {
              onAvatarSource: (activityId, sourceUrl) =>
                options.exerciseSource?.registerAvatarSource?.(activityId, sourceUrl),
              onTrainerAvatarSource: (activityId, source) =>
                options.exerciseSource?.registerTrainerAvatarSource?.(activityId, source),
            }).filter(
              (activity) =>
                activity.kind === 'TRAINING' &&
                moscowDate(new Date(activity.startsAt)) === command.date,
            ),
          };
        } else {
          const sources = normalizeVivaUpcomingBookingPayload(body.payload);
          const mappings = options.bookingScreenMappingRepository
            ? await options.bookingScreenMappingRepository.resolve({
                tenantId: current.tenantId,
                bookingExternalIds: sources.map((item) => item.bookingRef),
                exerciseAssociationIds: sources.flatMap((item) =>
                  item.exerciseRef ? exerciseAssociationIds(item.exerciseRef) : [],
                ),
              })
            : { bookings: [], games: [] };
          const bookingIds = new Map(
            mappings.bookings.map((item) => [item.externalId, item.bookingId]),
          );
          const gameIds = new Map(mappings.games.map((item) => [item.associationId, item.gameId]));
          result = {
            kind: 'upcoming',
            bookings: sources.map((item) => {
              const gameId = item.exerciseRef
                ? exerciseAssociationIds(item.exerciseRef)
                    .map((associationId) => gameIds.get(associationId))
                    .find((value): value is string => Boolean(value))
                : undefined;
              const bookingId =
                bookingIds.get(item.bookingRef) ?? vivaReadSnapshotUuid('booking', item.bookingRef);
              const activityId = item.exerciseRef
                ? vivaReadSnapshotUuid('exercise', item.exerciseRef)
                : bookingId;
              const kind = gameId
                ? ('game' as const)
                : item.kind === 'TOURNAMENT'
                  ? ('tournament' as const)
                  : item.kind === 'GAME'
                    ? ('game' as const)
                    : ('training' as const);
              return {
                id: bookingId,
                kind,
                title: item.title,
                startsAt: item.startsAt,
                ...(item.endsAt ? { endsAt: item.endsAt } : {}),
                venue: item.venue,
                status: item.status,
                route: gameId
                  ? `/games/${gameId}`
                  : kind === 'tournament'
                    ? `/tournaments?event=${activityId}`
                    : kind === 'game'
                      ? `/games?event=${activityId}`
                      : `/trainings?event=${activityId}`,
              };
            }),
          };
        }
      } catch {
        return sendApiError(
          request,
          reply,
          400,
          'BOOKING_SCREEN_READ_RESULT_INVALID',
          'Некорректный результат чтения.',
        );
      }
      const ttlSeconds = Math.max(1, Math.ceil((Date.parse(job.expiresAt) - Date.now()) / 1_000));
      const status = await options.clientAssistedJobStore.putResult(
        jobId,
        {
          commandId,
          ...result,
          acceptedAt: new Date().toISOString(),
        },
        ttlSeconds,
      );
      return reply.status(status === 'accepted' ? 202 : 200).send({
        accepted: true,
        replayed: status === 'replayed',
        itemCount: result.kind === 'schedule' ? result.activities.length : result.bookings.length,
      });
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/booking-screen-read-jobs/:jobId/complete',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const { jobId } = request.params as { readonly jobId?: string };
      const body = request.body as Record<string, unknown> | undefined;
      const limit = body?.limit;
      const phase = body?.phase;
      if (
        !jobId ||
        !UUID_PATTERN.test(jobId) ||
        !body ||
        Object.keys(body).some((key) => key !== 'limit' && key !== 'phase') ||
        (phase !== undefined &&
          phase !== 'HOME_INITIAL' &&
          phase !== 'HOME_TOURNAMENTS' &&
          phase !== 'FULL') ||
        typeof limit !== 'number' ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 500 ||
        !options.clientAssistedJobStore
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'BOOKING_SCREEN_READ_JOB_INVALID',
          'Некорректное завершение чтения.',
        );
      }
      const job = await options.clientAssistedJobStore.get(jobId);
      if (!job || !samePrincipal(job, current)) {
        return sendApiError(
          request,
          reply,
          404,
          'BOOKING_SCREEN_READ_JOB_NOT_FOUND',
          'Задание чтения не найдено.',
        );
      }
      if (job.screen !== 'FOR_ME' && phase !== undefined) {
        return sendApiError(
          request,
          reply,
          400,
          'BOOKING_SCREEN_READ_JOB_INVALID',
          'Некорректное завершение чтения.',
        );
      }
      if (job.screen === 'FOR_ME' && limit > 20) {
        return sendApiError(
          request,
          reply,
          400,
          'BOOKING_SCREEN_READ_JOB_INVALID',
          'Некорректное завершение чтения.',
        );
      }
      if (job.screen === 'MY_BOOKINGS' && limit > 50) {
        return sendApiError(
          request,
          reply,
          400,
          'BOOKING_SCREEN_READ_JOB_INVALID',
          'Некорректное завершение чтения.',
        );
      }
      const results = await options.clientAssistedJobStore.getResults(
        job.jobId,
        job.commands.map((command) => command.commandId),
      );
      if (job.screen === 'MY_BOOKINGS') {
        const generatedAt = new Date();
        const items = results
          .flatMap((result) => (result.kind === 'upcoming' ? result.bookings : []))
          .sort(
            (left, right) =>
              left.startsAt.localeCompare(right.startsAt) || left.id.localeCompare(right.id),
          )
          .slice(0, limit);
        const ready = results.length === job.commands.length;
        return {
          screen: job.screen,
          state: ready ? 'READY' : 'PARTIAL',
          completedCommands: results.length,
          totalCommands: job.commands.length,
          bookings: {
            version: snapshotVersion(items),
            generatedAt: generatedAt.toISOString(),
            staleAt: new Date(generatedAt.getTime() + (ready ? 60_000 : 0)).toISOString(),
            items,
          },
        };
      }
      if (job.screen === 'GROUP_TRAININGS') {
        const generatedAt = new Date();
        const tenantKey = (request.params as { tenantKey: string }).tenantKey;
        const activitiesById = new Map(
          results
            .flatMap((result) => (result.kind === 'schedule' ? result.activities : []))
            .filter(isGroupTrainingCatalogActivity)
            .map((activity) => [activity.id, activity]),
        );
        const items = withHostAvatarUrls(
          [...activitiesById.values()].sort(
            (left, right) =>
              left.startsAt.localeCompare(right.startsAt) || left.id.localeCompare(right.id),
          ),
          options.exerciseSource,
          tenantKey,
        ).slice(0, limit);
        const ready = results.length === job.commands.length;
        return {
          screen: job.screen,
          state: ready ? 'READY' : 'PARTIAL',
          completedCommands: results.length,
          totalCommands: job.commands.length,
          trainings: {
            version: snapshotVersion(items),
            generatedAt: generatedAt.toISOString(),
            staleAt: new Date(generatedAt.getTime() + (ready ? 60_000 : 0)).toISOString(),
            items,
          },
        };
      }
      if (!options.gameRepository || !options.preferencesRepository) {
        return unavailable(request, reply);
      }
      try {
        const tenantKey = (request.params as { tenantKey: string }).tenantKey;
        const completedDates = completedScheduleDates(job, results);
        const tournamentDates =
          phase === 'HOME_INITIAL'
            ? []
            : phase === 'HOME_TOURNAMENTS' ||
                (phase === undefined && results.length < job.commands.length)
              ? completedDates.slice(0, 2)
              : completedDates;
        const [profile, tournaments] = await Promise.all([
          options.preferencesRepository.getRecommendationProfile(current.tenantId, current.userId),
          readTournaments({
            ...(options.tournamentSource ? { source: options.tournamentSource } : {}),
            dates: tournamentDates,
          }),
        ]);
        const activitiesById = new Map(
          results
            .flatMap((result) => (result.kind === 'schedule' ? result.activities : []))
            .map((activity) => [activity.id, activity]),
        );
        const page = await listBookingRecommendations({
          repository: options.gameRepository,
          ...(options.photoRepository ? { photoRepository: options.photoRepository } : {}),
          tenantId: current.tenantId,
          userId: current.userId,
          preferences: profile.preferences,
          playerLevel: profile.playerLevel,
          activities: withHostAvatarUrls(
            [...activitiesById.values()],
            options.exerciseSource,
            tenantKey,
          ),
          tournaments: withTournamentOrganizerAvatarUrls(
            tournaments,
            options.tournamentSource,
            tenantKey,
          ),
          now: new Date().toISOString(),
          limit,
        });
        return {
          screen: job.screen,
          state: results.length === job.commands.length ? 'READY' : 'PARTIAL',
          completedCommands: results.length,
          totalCommands: job.commands.length,
          page,
        };
      } catch {
        return unavailable(request, reply);
      }
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/recommendations/bookings',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const query = request.query as Record<string, unknown>;
      const limit = limitValue(query.limit);
      const cursor =
        query.cursor === undefined
          ? undefined
          : typeof query.cursor === 'string' &&
              query.cursor.length >= 16 &&
              query.cursor.length <= 512
            ? query.cursor
            : null;
      if (
        Object.keys(query).some((key) => key !== 'limit' && key !== 'cursor') ||
        limit === undefined ||
        cursor === null
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'BOOKING_RECOMMENDATIONS_QUERY_INVALID',
          'Некорректные параметры рекомендаций.',
        );
      }
      if (!options.gameRepository || !options.preferencesRepository) {
        return unavailable(request, reply);
      }
      try {
        const now = new Date();
        const tenantKey = (request.params as { tenantKey: string }).tenantKey;
        const profilePromise = options.preferencesRepository.getRecommendationProfile(
          current.tenantId,
          current.userId,
        );
        const [profile, activities, tournaments, friends] = await Promise.all([
          profilePromise,
          cursor
            ? Promise.resolve([])
            : readActivities({
                ...(options.exerciseSource ? { source: options.exerciseSource } : {}),
                ...(options.getExerciseAccessToken
                  ? { getAccessToken: options.getExerciseAccessToken }
                  : {}),
                tenantId: current.tenantId,
                userId: current.userId,
                correlationId: request.id,
                now,
              }),
          cursor
            ? Promise.resolve([])
            : readTournaments({
                ...(options.tournamentSource ? { source: options.tournamentSource } : {}),
                dates: recommendationDates(now),
              }),
          profilePromise.then((recommendationProfile) =>
            !cursor &&
            recommendationProfile.preferences.recommendFriends &&
            options.friendshipRepository
              ? options.friendshipRepository
                  .list(current.tenantId, current.userId, 500)
                  .catch(() => ({ items: [] }))
              : { items: [] },
          ),
        ]);
        return await listBookingRecommendations({
          repository: options.gameRepository,
          ...(options.photoRepository ? { photoRepository: options.photoRepository } : {}),
          tenantId: current.tenantId,
          userId: current.userId,
          preferences: profile.preferences,
          playerLevel: profile.playerLevel,
          friendUserIds: friends.items.map((friend) => friend.userId),
          activities: withHostAvatarUrls(activities, options.exerciseSource, tenantKey),
          tournaments: withTournamentOrganizerAvatarUrls(
            tournaments,
            options.tournamentSource,
            tenantKey,
          ),
          now: now.toISOString(),
          limit,
          ...(cursor ? { cursor } : {}),
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'BOOKING_RECOMMENDATION_CURSOR_INVALID') {
          return sendApiError(
            request,
            reply,
            400,
            'BOOKING_RECOMMENDATION_CURSOR_INVALID',
            'Курсор рекомендаций недействителен.',
          );
        }
        return unavailable(request, reply);
      }
    },
  );

  app.get(
    '/public/api/v1/:tenantKey/booking-activities/:activityId/host-avatar',
    {
      preHandler: [...options.publicTenantHandlers],
      config: { rateLimit: { max: 300, timeWindow: 60_000 } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { activityId } = request.params as { activityId?: string };
      if (!activityId || !UUID_PATTERN.test(activityId)) {
        return sendApiError(request, reply, 404, 'EVENT_AVATAR_NOT_FOUND', 'Аватар не найден.');
      }
      const trainer = options.exerciseSource?.readTrainerAvatarSource?.(activityId);
      const sourceUrl =
        trainer?.sourceUrl ?? options.exerciseSource?.readAvatarSource?.(activityId);
      if ((!sourceUrl && !trainer) || !options.avatarMedia) {
        return sendApiError(request, reply, 404, 'EVENT_AVATAR_NOT_FOUND', 'Аватар не найден.');
      }
      try {
        const media = await options.avatarMedia.read({
          cacheKey: `booking-activity:${activityId}`,
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
        request.log.error(
          { err: error, activityId },
          'booking activity host avatar delivery failed',
        );
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
