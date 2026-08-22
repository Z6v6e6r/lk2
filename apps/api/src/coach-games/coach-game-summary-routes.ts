import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';

function addRetirementHeaders(reply: FastifyReply, tenantKey: string): void {
  reply.header('Cache-Control', 'no-store');
  reply.header('Deprecation', 'true');
  reply.header(
    'Link',
    `</user/api/v1/${encodeURIComponent(tenantKey)}/booking-screen-read-jobs>; rel="successor-version"`,
  );
}

export function registerCoachGameSummaryRoutes(
  app: FastifyInstance,
  options: { readonly publicTenantHandlers: readonly preHandlerHookHandler[] },
): void {
  app.get(
    '/public/api/v1/:tenantKey/coach-games',
    { preHandler: [...options.publicTenantHandlers] },
    (request, reply) => {
      const { tenantKey } = request.params as { readonly tenantKey: string };
      addRetirementHeaders(reply, tenantKey);
      return { items: [] };
    },
  );
  app.get(
    '/public/api/v1/:tenantKey/coach-games/:summaryId/trainer-avatar',
    {
      preHandler: [...options.publicTenantHandlers],
      config: { rateLimit: { max: 300, timeWindow: 60_000 } },
    },
    (request, reply) => {
      const { tenantKey } = request.params as { readonly tenantKey: string };
      addRetirementHeaders(reply, tenantKey);
      return reply.status(204).send();
    },
  );
}
