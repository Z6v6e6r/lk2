import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import {
  QuarterCreateError,
  parseQuarterInput,
  qcUuid,
  qcOperationId,
  qcHash,
} from '@phub/domain/quarter-create';
import type { QuarterCreateRuntime } from './game-quarter-create-runtime.js';
export function registerQuarterCreateRoutes(
  app: FastifyInstance,
  o: {
    runtime?: QuarterCreateRuntime;
    readHandlers: readonly preHandlerHookHandler[];
    commandHandlers: readonly preHandlerHookHandler[];
  },
) {
  const actor = (r: FastifyRequest) => {
    const x = r as FastifyRequest & {
      tenantId?: string;
      padlHubClaims?: { sub?: string; sid?: string };
    };
    if (!x.tenantId || !x.padlHubClaims?.sub || !x.padlHubClaims.sid)
      throw new QuarterCreateError('AUTH_REQUIRED', 401);
    return {
      tenantKey: (r.params as { tenantKey: string }).tenantKey,
      tenantId: x.tenantId,
      userId: x.padlHubClaims.sub,
      sessionId: x.padlHubClaims.sid,
      correlationId: r.id,
    };
  };
  const key = (r: FastifyRequest) => {
    const k = r.headers['idempotency-key'];
    if (typeof k !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(k) || /[\r\n]/.test(k))
      throw new QuarterCreateError('INVALID_REQUEST', 400);
    return k;
  };
  const runtime = () => {
    if (!o.runtime) throw new QuarterCreateError();
    return o.runtime;
  };
  const prefix = '/user/api/v1/:tenantKey/game-create-operations';
  app.get(prefix + '/capability', { preHandler: [...o.readHandlers] }, async (r, p) => {
    p.header('Cache-Control', 'no-store');
    p.header('Referrer-Policy', 'no-referrer');
    try {
      actor(r);
      if (Object.keys(r.query as object).length)
        throw new QuarterCreateError('INVALID_REQUEST', 400);
      return o.runtime ? o.runtime.capability() : { contractVersion: 1, available: false };
    } catch (e) {
      const error = e instanceof QuarterCreateError ? e : new QuarterCreateError();
      return p.code(error.status).send({ code: error.code, message: 'Создание пока недоступно.' });
    }
  });
  app.get(prefix + '/locations', { preHandler: [...o.readHandlers] }, async (r, p) => {
    p.header('Cache-Control', 'no-store');
    p.header('Referrer-Policy', 'no-referrer');
    try {
      if (Object.keys(r.query as object).length)
        throw new QuarterCreateError('INVALID_REQUEST', 400);
      return await runtime().locations(actor(r));
    } catch (e) {
      const error = e instanceof QuarterCreateError ? e : new QuarterCreateError();
      return p.code(error.status).send({ code: error.code, message: 'Корты пока недоступны.' });
    }
  });
  app.get(prefix + '/by-key', { preHandler: [...o.readHandlers] }, async (r, p) => {
    p.header('Cache-Control', 'no-store');
    p.header('Referrer-Policy', 'no-referrer');
    try {
      if (Object.keys(r.query as object).length)
        throw new QuarterCreateError('INVALID_REQUEST', 400);
      const result = await runtime().read(actor(r), key(r));
      if (!result) throw new QuarterCreateError('GAME_QUARTER_CREATE_OPERATION_NOT_FOUND', 404);
      return result;
    } catch (e) {
      const error = e instanceof QuarterCreateError ? e : new QuarterCreateError();
      return p
        .code(error.status)
        .send({ code: error.code, message: 'Операция создания игры пока не завершена.' });
    }
  });
  for (const recovery of [false, true])
    app.post(
      prefix + (recovery ? '/:operationId/reconcile' : ''),
      { preHandler: [...o.commandHandlers] },
      async (r, p) => {
        p.header('Cache-Control', 'no-store');
        p.header('Referrer-Policy', 'no-referrer');
        try {
          if (Object.keys(r.query as object).length)
            throw new QuarterCreateError('INVALID_REQUEST', 400);
          const a = actor(r),
            k = key(r),
            q = (() => {
              try {
                return parseQuarterInput(r.body);
              } catch {
                throw new QuarterCreateError('INVALID_REQUEST', 400);
              }
            })();
          if (recovery) {
            const id = (r.params as { operationId: string }).operationId;
            if (!qcUuid(id)) throw new QuarterCreateError('INVALID_REQUEST', 400);
            if ((await qcOperationId(a.tenantId, a.userId, await qcHash(k))) !== id)
              throw new QuarterCreateError('GAME_QUARTER_CREATE_OPERATION_NOT_FOUND', 404);
          }
          const result = await runtime().execute(a, k, q, recovery);
          return p
            .code(
              [
                'CONFIRMED',
                'REJECTED',
                'REFUSED_NOT_DISPATCHED',
                'EXPIRED_NOT_DISPATCHED',
              ].includes(result.operation.status)
                ? 200
                : 202,
            )
            .send(result);
        } catch (e) {
          const error = e instanceof QuarterCreateError ? e : new QuarterCreateError();
          return p
            .code(error.status)
            .send({ code: error.code, message: 'Операция создания игры пока не завершена.' });
        }
      },
    );
}
