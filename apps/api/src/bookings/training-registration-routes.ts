import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  trainingUuid,
  trainingDate,
  TrainingRegistrationError,
} from '@phub/domain/training-registration';
import { sendApiError } from '../http-errors.js';
import type { TrainingRegistrationRuntime } from './training-registration-runtime.js';
export function registerTrainingRegistrationRoutes(
  app: FastifyInstance,
  options: {
    runtime?: TrainingRegistrationRuntime;
    handlers: readonly ((request: FastifyRequest, reply: FastifyReply) => Promise<void> | void)[];
  },
) {
  for (const method of ['GET', 'POST'] as const)
    app.route({
      method,
      url:
        '/user/api/v1/:tenantKey/trainings/:trainingId/' +
        (method === 'GET' ? 'registration-operation' : 'registrations'),
      preHandler: [...options.handlers],
      handler: async (request, reply) => {
        reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
        try {
          const params = request.params as { tenantKey: string; trainingId: string },
            key = request.headers['idempotency-key'];
          if (
            !trainingUuid(params.trainingId) ||
            Object.keys(request.query as object).length ||
            typeof key !== 'string' ||
            !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key) ||
            /[\r\n]/.test(key)
          )
            throw new TrainingRegistrationError('TRAINING_REGISTRATION_INPUT_INVALID', 400);
          const claims = request.padlHubClaims;
          if (!claims || !request.tenantId)
            throw new TrainingRegistrationError('UNAUTHORIZED', 401);
          if (!options.runtime)
            throw new TrainingRegistrationError('TRAINING_REGISTRATION_DISABLED');
          const actor = {
            tenantId: request.tenantId,
            tenantKey: params.tenantKey,
            userId: claims.sub,
            sessionId: claims.sid,
            correlationId: request.id,
          };
          if (method === 'GET') {
            if (request.body !== undefined)
              throw new TrainingRegistrationError('TRAINING_REGISTRATION_INPUT_INVALID', 400);
            return await options.runtime.read(actor, {
              trainingId: params.trainingId,
              idempotencyKey: key,
            });
          }
          const body = request.body as Record<string, unknown>;
          if (
            !body ||
            typeof body !== 'object' ||
            Array.isArray(body) ||
            Object.keys(body).sort().join() !== 'dateHint,subscriptionId' ||
            !trainingDate(body.dateHint) ||
            !trainingUuid(body.subscriptionId)
          )
            throw new TrainingRegistrationError('TRAINING_REGISTRATION_INPUT_INVALID', 400);
          return await options.runtime.execute(actor, {
            trainingId: params.trainingId,
            dateHint: body.dateHint,
            subscriptionId: body.subscriptionId,
            idempotencyKey: key,
          });
        } catch (error) {
          return sendApiError(
            request,
            reply,
            error instanceof TrainingRegistrationError ? error.status : 503,
            error instanceof TrainingRegistrationError
              ? error.code
              : 'TRAINING_REGISTRATION_UNAVAILABLE',
            'Не удалось подтвердить запись на тренировку.',
          );
        }
      },
    });
}
