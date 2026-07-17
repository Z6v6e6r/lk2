import type { GameRepository } from '@phub/database';
import { GAME_KINDS, GAME_PLAYER_LEVELS, type GameKind, type GamePlayerLevel } from '@phub/games';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { sendApiError } from '../http-errors.js';
import {
  getPublicGameCard,
  getViewerGameCard,
  listPublicGameCards,
  listViewerGameCards,
  type PublicGameFilters,
} from './game-card-queries.js';

type CardReadRepository = Pick<
  GameRepository,
  'getCardProjection' | 'listPublicCardProjections' | 'listViewerCardProjections'
>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_QUERY_KEYS = new Set([
  'stationId',
  'startsFrom',
  'startsTo',
  'kind',
  'levelFrom',
  'levelTo',
  'availability',
  'limit',
  'cursor',
]);
const VIEWER_QUERY_KEYS = new Set(['scope', 'limit', 'cursor']);

function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  const current = request as FastifyRequest & {
    readonly tenantId?: string;
    readonly padlHubClaims?: { readonly sub?: string };
  };
  const userId = current.padlHubClaims?.sub;
  return current.tenantId && userId ? { tenantId: current.tenantId, userId } : undefined;
}

function tenantId(request: FastifyRequest): string | undefined {
  return (request as FastifyRequest & { readonly tenantId?: string }).tenantId;
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'GAMES_RUNTIME_UNAVAILABLE',
    'Игровой модуль временно недоступен.',
  );
}

function invalid(request: FastifyRequest, reply: FastifyReply, message: string) {
  return sendApiError(request, reply, 400, 'INVALID_REQUEST', message);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function limitValue(value: unknown): number | undefined {
  if (value === undefined) return 20;
  if (typeof value !== 'string' || !/^\d{1,2}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 50 ? parsed : undefined;
}

function cursorValue(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' && value.length >= 16 && value.length <= 512 ? value : null;
}

function instantValue(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function parsePublicQuery(
  request: FastifyRequest,
  reply: FastifyReply,
):
  | { readonly filters: PublicGameFilters; readonly limit: number; readonly cursor?: string }
  | undefined {
  const query = request.query as Record<string, unknown>;
  if (Object.keys(query).some((key) => !PUBLIC_QUERY_KEYS.has(key))) {
    invalid(request, reply, 'Некорректные фильтры поиска игр.');
    return undefined;
  }
  const stationId = stringValue(query.stationId);
  const startsFrom = instantValue(query.startsFrom);
  const startsTo = instantValue(query.startsTo);
  const kind = stringValue(query.kind);
  const levelFrom = stringValue(query.levelFrom);
  const levelTo = stringValue(query.levelTo);
  const availability = stringValue(query.availability) ?? 'JOINABLE';
  const limit = limitValue(query.limit);
  const cursor = cursorValue(query.cursor);
  if (
    (query.stationId !== undefined && (!stationId || !UUID_PATTERN.test(stationId))) ||
    startsFrom === null ||
    startsTo === null ||
    (startsFrom && startsTo && Date.parse(startsFrom) >= Date.parse(startsTo)) ||
    (kind !== undefined && !GAME_KINDS.includes(kind as GameKind)) ||
    (levelFrom !== undefined && !GAME_PLAYER_LEVELS.includes(levelFrom as GamePlayerLevel)) ||
    (levelTo !== undefined && !GAME_PLAYER_LEVELS.includes(levelTo as GamePlayerLevel)) ||
    (levelFrom !== undefined &&
      levelTo !== undefined &&
      GAME_PLAYER_LEVELS.indexOf(levelFrom as GamePlayerLevel) >
        GAME_PLAYER_LEVELS.indexOf(levelTo as GamePlayerLevel)) ||
    !['JOINABLE', 'INCLUDE_FULL'].includes(availability) ||
    limit === undefined ||
    cursor === null
  ) {
    invalid(request, reply, 'Некорректные фильтры поиска игр.');
    return undefined;
  }
  return {
    filters: {
      ...(stationId ? { stationId } : {}),
      ...(startsFrom ? { startsFrom } : {}),
      ...(startsTo ? { startsTo } : {}),
      ...(kind ? { kind: kind as GameKind } : {}),
      ...(levelFrom ? { levelFrom: levelFrom as GamePlayerLevel } : {}),
      ...(levelTo ? { levelTo: levelTo as GamePlayerLevel } : {}),
      availability: availability as 'JOINABLE' | 'INCLUDE_FULL',
    },
    limit,
    ...(cursor ? { cursor } : {}),
  };
}

function parseViewerQuery(
  request: FastifyRequest,
  reply: FastifyReply,
):
  | { readonly scope: 'UPCOMING' | 'HISTORY'; readonly limit: number; readonly cursor?: string }
  | undefined {
  const query = request.query as Record<string, unknown>;
  const scope = stringValue(query.scope) ?? 'UPCOMING';
  const limit = limitValue(query.limit);
  const cursor = cursorValue(query.cursor);
  if (
    Object.keys(query).some((key) => !VIEWER_QUERY_KEYS.has(key)) ||
    !['UPCOMING', 'HISTORY'].includes(scope) ||
    limit === undefined ||
    cursor === null
  ) {
    invalid(request, reply, 'Некорректные параметры списка игр.');
    return undefined;
  }
  return {
    scope: scope as 'UPCOMING' | 'HISTORY',
    limit,
    ...(cursor ? { cursor } : {}),
  };
}

function gameId(request: FastifyRequest, reply: FastifyReply): string | undefined {
  const value = (request.params as { gameId?: string }).gameId;
  if (!value || !UUID_PATTERN.test(value)) {
    invalid(request, reply, 'Некорректный идентификатор игры.');
    return undefined;
  }
  return value;
}

export function registerGameReadRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: CardReadRepository;
    readonly publicTenantHandlers: readonly preHandlerHookHandler[];
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/public/api/v1/:tenantKey/games',
    { preHandler: [...options.publicTenantHandlers] },
    async (request, reply) => {
      const currentTenantId = tenantId(request);
      const query = parsePublicQuery(request, reply);
      if (!query) return reply;
      if (!currentTenantId) return unavailable(request, reply);
      if (!options.repository) return unavailable(request, reply);
      try {
        const result = await listPublicGameCards({
          repository: options.repository,
          tenantId: currentTenantId,
          now: new Date().toISOString(),
          limit: query.limit,
          filters: query.filters,
          ...(query.cursor ? { cursor: query.cursor } : {}),
        });
        reply.header('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
        return result;
      } catch (error) {
        if (error instanceof Error && error.message === 'GAME_CURSOR_INVALID') {
          return invalid(request, reply, 'Курсор списка игр недействителен.');
        }
        throw error;
      }
    },
  );

  app.get(
    '/public/api/v1/:tenantKey/games/:gameId',
    { preHandler: [...options.publicTenantHandlers] },
    async (request, reply) => {
      const currentTenantId = tenantId(request);
      const currentGameId = gameId(request, reply);
      if (!currentGameId) return reply;
      if (!currentTenantId || !options.repository) return unavailable(request, reply);
      const game = await getPublicGameCard({
        repository: options.repository,
        tenantId: currentTenantId,
        gameId: currentGameId,
        now: new Date().toISOString(),
      });
      if (!game) return sendApiError(request, reply, 404, 'GAME_NOT_FOUND', 'Игра не найдена.');
      reply.header('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
      return { game };
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/games',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const current = principal(request);
      const query = parseViewerQuery(request, reply);
      if (!query) return reply;
      if (!current || !options.repository) return unavailable(request, reply);
      try {
        return await listViewerGameCards({
          repository: options.repository,
          tenantId: current.tenantId,
          viewerUserId: current.userId,
          scope: query.scope,
          now: new Date().toISOString(),
          limit: query.limit,
          ...(query.cursor ? { cursor: query.cursor } : {}),
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'GAME_CURSOR_INVALID') {
          return invalid(request, reply, 'Курсор списка игр недействителен.');
        }
        throw error;
      }
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/games/:gameId',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const current = principal(request);
      const currentGameId = gameId(request, reply);
      if (!currentGameId) return reply;
      if (!current || !options.repository) return unavailable(request, reply);
      const game = await getViewerGameCard({
        repository: options.repository,
        tenantId: current.tenantId,
        viewerUserId: current.userId,
        gameId: currentGameId,
        now: new Date().toISOString(),
      });
      if (!game) return sendApiError(request, reply, 404, 'GAME_NOT_FOUND', 'Игра не найдена.');
      return { game };
    },
  );
}
