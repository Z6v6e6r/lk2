import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import {
  TournamentChatError,
  parseTournamentChatRequest,
  parseTournamentChatReadRequest,
  tournamentChatUuid,
} from '@phub/domain';
import { sendApiError } from '../http-errors.js';
import type { TournamentChatOwner } from './tournament-chat-owner-client.js';
export function registerTournamentChatRoutes(
  app: FastifyInstance,
  options: {
    readonly owner?: TournamentChatOwner;
    readonly handlers: readonly preHandlerHookHandler[];
  },
) {
  for (const kind of ['send', 'status', 'history'] as const)
    app.route({
      method: kind === 'send' ? 'POST' : 'GET',
      url:
        '/user/api/v1/:tenantKey/tournaments/:tournamentId/chat/' +
        (kind === 'history'
          ? 'messages'
          : kind === 'status'
            ? 'message-requests/:requestId'
            : 'message-requests'),
      preHandler: [...options.handlers],
      bodyLimit: 65536,
      config: { rateLimit: { max: kind === 'send' ? 20 : 60, timeWindow: '1 minute' } },
      handler: async (request, reply) => {
        reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
        try {
          const p = request.params as {
              tenantKey: string;
              tournamentId: string;
              requestId?: string;
            },
            q = request.query as Record<string, unknown>;
          if (!request.tenantId || !request.padlHubClaims?.sub || !request.padlHubClaims.sid)
            return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
          if (
            !tournamentChatUuid(p.tournamentId) ||
            (kind === 'status' && !tournamentChatUuid(p.requestId)) ||
            (kind !== 'send' && request.body !== undefined) ||
            Object.keys(q).some((k) => kind !== 'history' || !['limit', 'cursor'].includes(k))
          )
            throw new TournamentChatError('TOURNAMENT_CHAT_INPUT_INVALID', 400);
          const limit =
            q.limit === undefined
              ? 50
              : typeof q.limit === 'string' && /^[1-9][0-9]?$/.test(q.limit)
                ? Number(q.limit)
                : 0;
          if (
            limit < 1 ||
            limit > 50 ||
            (q.cursor !== undefined &&
              (typeof q.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1800}$/.test(q.cursor)))
          )
            throw new TournamentChatError('TOURNAMENT_CHAT_INPUT_INVALID', 400);
          const x = kind === 'send' ? parseTournamentChatRequest(request.body) : undefined;
          if (x && request.headers['idempotency-key'] !== x.requestId)
            throw new TournamentChatError('TOURNAMENT_CHAT_INPUT_INVALID', 400);
          if (!options.owner) throw new TournamentChatError();
          const actor = {
            tenantId: request.tenantId,
            tenantKey: p.tenantKey,
            userId: request.padlHubClaims.sub,
            sessionId: request.padlHubClaims.sid,
            correlationId: request.id,
          };
          const result = x
            ? await options.owner.send(actor, p.tournamentId, x)
            : kind === 'status'
              ? await options.owner.status(actor, p.tournamentId, p.requestId!)
              : await options.owner.history(actor, p.tournamentId, limit, q.cursor);
          request.log.info(
            { tournamentChatOperation: kind, tournamentId: p.tournamentId, outcome: 'returned' },
            'tournament chat audit',
          );
          return result;
        } catch (error) {
          const e = error instanceof TournamentChatError ? error : new TournamentChatError();
          request.log.warn(
            { tournamentChatOperation: kind, outcome: e.code },
            'tournament chat unavailable',
          );
          return sendApiError(
            request,
            reply,
            e.status,
            e.code,
            'Не удалось подтвердить состояние чата.',
          );
        }
      },
    });
  for (const kind of ['position', 'advanceRead', 'readStatus'] as const)
    app.route({
      method: kind === 'advanceRead' ? 'POST' : 'GET',
      url:
        '/user/api/v1/:tenantKey/tournaments/:tournamentId/chat/' +
        (kind === 'position'
          ? 'read-position'
          : kind === 'advanceRead'
            ? 'read-requests'
            : 'read-requests/:requestId'),
      preHandler: [...options.handlers],
      bodyLimit: 4096,
      config: { rateLimit: { max: kind === 'advanceRead' ? 20 : 60, timeWindow: '1 minute' } },
      handler: async (request, reply) => {
        reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
        try {
          const p = request.params as {
            tenantKey: string;
            tournamentId: string;
            requestId?: string;
          };
          if (!request.tenantId || !request.padlHubClaims?.sub || !request.padlHubClaims.sid)
            return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
          if (
            !tournamentChatUuid(p.tournamentId) ||
            Object.keys(request.query as object).length ||
            (kind === 'readStatus' && !tournamentChatUuid(p.requestId)) ||
            (kind !== 'advanceRead' && request.body !== undefined)
          )
            throw new TournamentChatError('TOURNAMENT_CHAT_INPUT_INVALID', 400);
          const actor = {
            tenantId: request.tenantId,
            tenantKey: p.tenantKey,
            userId: request.padlHubClaims.sub,
            sessionId: request.padlHubClaims.sid,
            correlationId: request.id,
          };
          const owner = options.owner;
          if (!owner?.position || !owner.advanceRead || !owner.readStatus)
            throw new TournamentChatError();
          const input =
            kind === 'advanceRead' ? parseTournamentChatReadRequest(request.body) : undefined;
          if (input && request.headers['idempotency-key'] !== input.requestId)
            throw new TournamentChatError('TOURNAMENT_CHAT_INPUT_INVALID', 400);
          const result = input
            ? await owner.advanceRead(actor, p.tournamentId, input)
            : kind === 'position'
              ? await owner.position(actor, p.tournamentId)
              : await owner.readStatus(actor, p.tournamentId, p.requestId!);
          request.log.info(
            { tournamentChatOperation: kind, tournamentId: p.tournamentId, outcome: 'returned' },
            'tournament chat audit',
          );
          return result;
        } catch (error) {
          const e = error instanceof TournamentChatError ? error : new TournamentChatError();
          request.log.warn(
            { tournamentChatOperation: kind, outcome: e.code },
            'tournament chat unavailable',
          );
          return sendApiError(
            request,
            reply,
            e.status,
            e.code,
            'Не удалось подтвердить отметку о прочтении.',
          );
        }
      },
    });
}
