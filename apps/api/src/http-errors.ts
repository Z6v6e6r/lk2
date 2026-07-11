import type { ApiErrorBody } from '@phub/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';

export function sendApiError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  const body: ApiErrorBody = { code, message, correlationId: request.id };
  return reply.status(status).send(body);
}
