import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  TournamentLocalError,
  tournamentUuid,
  tournamentKey,
  parseTournamentLocalInput,
  parseTournamentPlayerGenderUpdate,
} from '@phub/domain';
import { sendApiError } from '../http-errors.js';
import type { TournamentLocalRuntime } from './tournament-local-runtime.js';
export function registerTournamentLocalRoutes(
  app: FastifyInstance,
  options: {
    runtime?: TournamentLocalRuntime;
    handlers: readonly ((request: FastifyRequest, reply: FastifyReply) => Promise<void> | void)[];
  },
) {
  for (const method of ['GET', 'PUT'] as const)
    app.route({
      method,
      url: '/user/api/v1/:tenantKey/profile/tournament-gender',
      preHandler: [...options.handlers],
      handler: async (request, reply) => {
        reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
        try {
          const claims = request.padlHubClaims;
          const key = request.headers['idempotency-key'];
          if (!claims || !request.tenantId) throw new TournamentLocalError('UNAUTHORIZED', 401);
          if (!claims.permissions.includes('profile.read'))
            throw new TournamentLocalError('TOURNAMENT_LOCAL_PROFILE_FORBIDDEN', 403);
          if (
            Object.keys(request.query as object).length ||
            (method === 'GET' && request.body !== undefined) ||
            (method === 'PUT' && !tournamentKey(key))
          )
            throw new TournamentLocalError('TOURNAMENT_LOCAL_PROFILE_INVALID', 400);
          if (!options.runtime)
            throw new TournamentLocalError('TOURNAMENT_LOCAL_PROFILE_UNAVAILABLE');
          const { tenantKey } = request.params as { tenantKey: string };
          const actor = {
            tenantId: request.tenantId,
            tenantKey,
            userId: claims.sub,
            sessionId: claims.sid,
            correlationId: request.id,
          };
          const command =
            method === 'PUT' && tournamentKey(key)
              ? { input: parseTournamentPlayerGenderUpdate(request.body), key }
              : undefined;
          return await options.runtime.playerGender(actor, command);
        } catch (error) {
          return sendApiError(
            request,
            reply,
            error instanceof TournamentLocalError ? error.status : 503,
            error instanceof TournamentLocalError
              ? error.code
              : 'TOURNAMENT_LOCAL_PROFILE_UNAVAILABLE',
            'Не удалось подтвердить настройки участия в турнирах.',
          );
        }
      },
    });
  for (const kind of ['command', 'read', 'retry'] as const)
    app.route({
      method: kind === 'read' ? 'GET' : 'POST',
      url:
        '/user/api/v1/:tenantKey/tournaments/:tournamentId/' +
        (kind === 'command'
          ? 'registrations'
          : kind === 'read'
            ? 'registration-operation'
            : 'registration-operations/:operationId/retry'),
      preHandler: [...options.handlers],
      handler: async (request, reply) => {
        reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
        try {
          const p = request.params as {
              tenantKey: string;
              tournamentId: string;
              operationId?: string;
            },
            q = request.query as Record<string, unknown>,
            key = request.headers['idempotency-key'];
          if (
            !tournamentUuid(p.tournamentId) ||
            Object.keys(q).some((k) => kind !== 'read' || k !== 'operationId') ||
            (q.operationId !== undefined && !tournamentUuid(q.operationId)) ||
            (kind === 'retry' && !tournamentUuid(p.operationId)) ||
            (key !== undefined && !tournamentKey(key)) ||
            (kind !== 'read' && !tournamentKey(key))
          )
            throw new TournamentLocalError('TOURNAMENT_LOCAL_INPUT_INVALID', 400);
          if (!request.padlHubClaims || !request.tenantId)
            throw new TournamentLocalError('UNAUTHORIZED', 401);
          if (!options.runtime) throw new TournamentLocalError('TOURNAMENT_LOCAL_DISABLED');
          const actor = {
            tenantId: request.tenantId,
            tenantKey: p.tenantKey,
            userId: request.padlHubClaims.sub,
            sessionId: request.padlHubClaims.sid,
            correlationId: request.id,
          };
          // Android HttpsURLConnection marks a bodyless POST text/plain to avoid
          // its implicit form Content-Type. This accepts no additional command data.
          const emptyNativeRetry =
            kind === 'retry' &&
            request.body === '' &&
            /^text\/plain(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '');
          if (kind !== 'command' && request.body !== undefined && !emptyNativeRetry)
            throw new TournamentLocalError('TOURNAMENT_LOCAL_INPUT_INVALID', 400);
          if (kind === 'read')
            return await options.runtime.read(actor, p.tournamentId, {
              ...(q.operationId ? { id: q.operationId } : {}),
              ...(key ? { key: key } : {}),
            });
          if (kind === 'retry')
            return await options.runtime.retry(actor, p.tournamentId, p.operationId!);
          return await options.runtime.execute(
            actor,
            p.tournamentId,
            key as string,
            parseTournamentLocalInput(request.body),
          );
        } catch (error) {
          return sendApiError(
            request,
            reply,
            error instanceof TournamentLocalError ? error.status : 503,
            error instanceof TournamentLocalError ? error.code : 'TOURNAMENT_LOCAL_UNAVAILABLE',
            'Не удалось подтвердить операцию турнира.',
          );
        }
      },
    });
}
