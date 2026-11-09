import { randomUUID } from 'node:crypto';

import type { AppConfig } from '@phub/config';
import type {
  ClientRoutingPlanRepository,
  ProfileProviderObservationRepository,
  StoredClientRoutingPlan,
} from '@phub/database';
import type { ClientPlatform } from '@phub/domain';
import { normalizeVivaProfileObservation, type VivaProfileObservation } from '@phub/viva-adapter';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { sendApiError } from '../http-errors.js';
import { canUseDirectViva } from '../routing/client-routing-plan.js';
import {
  PROFILE_PROVIDER_READ_JOB_TTL_SECONDS,
  type ProfileProviderReadJob,
  type ProfileProviderReadJobStore,
  type ProfileProviderReadResult,
} from './profile-read-job-store.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** The relayed provider payload must stay small: the screen needs a level and a balance. */
export const PROFILE_PROVIDER_READ_RESULT_BODY_LIMIT_BYTES = 64 * 1_024;

export interface ProfileProviderReadRoutesOptions {
  readonly config: AppConfig;
  readonly jobStore?: ProfileProviderReadJobStore;
  readonly observationRepository?: ProfileProviderObservationRepository;
  readonly clientRoutingPlanRepository?: Pick<ClientRoutingPlanRepository, 'get'>;
  readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
}

function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  const tenantId = request.tenantId;
  const userId = request.padlHubClaims?.sub;
  return tenantId && userId ? { tenantId, userId } : undefined;
}

function clientPlatform(request: FastifyRequest): ClientPlatform {
  const value = request.headers['x-app-platform'];
  return value === 'web' || value === 'ios' || value === 'android' || value === 'cup-admin'
    ? value
    : 'internal';
}

function storeUnavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'PROFILE_READ_STORE_UNAVAILABLE',
    'Обновление профиля временно недоступно.',
  );
}

function jobNotFound(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    404,
    'PROFILE_READ_JOB_NOT_FOUND',
    'Задание обновления профиля не найдено.',
  );
}

function jobExpired(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    410,
    'PROFILE_READ_JOB_EXPIRED',
    'Задание обновления профиля истекло.',
  );
}

function resultInvalid(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    400,
    'PROFILE_READ_RESULT_INVALID',
    'Некорректный результат чтения профиля.',
  );
}

function directVivaDisabled(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    403,
    'DIRECT_VIVA_DISABLED',
    'Прямое подключение к Viva отключено сервером.',
  );
}

function jobInvalid(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    400,
    'PROFILE_READ_JOB_INVALID',
    'Некорректный запрос обновления профиля.',
  );
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyBody(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (isJsonObject(value) && Object.keys(value).length === 0)
  );
}

function jobMatches(job: ProfileProviderReadJob, current: { tenantId: string; userId: string }) {
  return job.tenantId === current.tenantId && job.userId === current.userId;
}

/**
 * Android-only endpoint exception ADR-0023/0020: the native client cannot read the Viva profile
 * itself, so it receives a short-lived job and delegated access, reads the provider payload and
 * relays it here. The server re-validates that payload and keeps only the provider level and
 * balance. No provider token or identifier is accepted, returned or logged by these routes.
 */
export function registerProfileProviderReadRoutes(
  app: FastifyInstance,
  options: ProfileProviderReadRoutesOptions,
): void {
  const { config } = options;

  app.post(
    '/user/api/v1/:tenantKey/profile/provider-read-jobs',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      // The flag and the platform header are one admission decision: only the native Android
      // build performs this read, and only while the server-wide rollout flag is on.
      if (!config.PROFILE_NATIVE_READ_ENABLED || clientPlatform(request) !== 'android') {
        return sendApiError(
          request,
          reply,
          403,
          'PROFILE_NATIVE_READ_DISABLED',
          'Нативное обновление профиля отключено сервером.',
        );
      }
      if (!options.jobStore) return storeUnavailable(request, reply);
      // A deployment that cannot supply the stored routing plan cannot prove that this device is
      // allowed to read the provider directly, so it fails closed with the contract error code.
      if (!options.clientRoutingPlanRepository) {
        return directVivaDisabled(request, reply);
      }
      if (!emptyBody(request.body)) return jobInvalid(request, reply);
      let stored: StoredClientRoutingPlan | undefined;
      try {
        stored = await options.clientRoutingPlanRepository.get(current.tenantId, current.userId);
      } catch {
        return directVivaDisabled(request, reply);
      }
      if (
        !stored ||
        !canUseDirectViva({ config, stored, platform: 'android' }) ||
        !stored.directOperations.includes('profile.read')
      ) {
        return directVivaDisabled(request, reply);
      }
      const now = new Date();
      const job: ProfileProviderReadJob = {
        jobId: randomUUID(),
        tenantId: current.tenantId,
        userId: current.userId,
        commandId: randomUUID(),
        operation: 'profile.read',
        createdAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() + PROFILE_PROVIDER_READ_JOB_TTL_SECONDS * 1_000,
        ).toISOString(),
      };
      try {
        if (!(await options.jobStore.create(job, PROFILE_PROVIDER_READ_JOB_TTL_SECONDS))) {
          return storeUnavailable(request, reply);
        }
      } catch {
        return storeUnavailable(request, reply);
      }
      // Redacted rollout signal: counts only, never provider fields, identifiers or tokens.
      request.log.info(
        { outcome: 'job-created', routingRevision: stored.revision },
        'profile provider read job',
      );
      return {
        jobId: job.jobId,
        commandId: job.commandId,
        expiresAt: job.expiresAt,
      };
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/profile/provider-read-jobs/:jobId/results/:commandId',
    {
      preHandler: [...options.authenticatedTenantHandlers],
      bodyLimit: PROFILE_PROVIDER_READ_RESULT_BODY_LIMIT_BYTES,
    },
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
      if (!jobId || !commandId || !UUID_PATTERN.test(jobId) || !UUID_PATTERN.test(commandId)) {
        return jobNotFound(request, reply);
      }
      if (!options.jobStore || !options.observationRepository) {
        return storeUnavailable(request, reply);
      }
      const jobStore = options.jobStore;
      const observationRepository = options.observationRepository;
      let job: ProfileProviderReadJob | undefined;
      try {
        job = await jobStore.get(jobId);
      } catch {
        return storeUnavailable(request, reply);
      }
      // A job is bound to the authenticated principal and to the single command it was issued
      // for; any mismatch is indistinguishable from an unknown job on purpose.
      if (!job || !jobMatches(job, current) || job.commandId !== commandId) {
        return jobNotFound(request, reply);
      }
      if (Date.parse(job.expiresAt) <= Date.now()) return jobExpired(request, reply);
      const body = request.body;
      if (
        !isJsonObject(body) ||
        Object.keys(body).length !== 1 ||
        !Object.hasOwn(body, 'payload') ||
        !isJsonObject(body.payload)
      ) {
        return resultInvalid(request, reply);
      }
      let existing: ProfileProviderReadResult | undefined;
      try {
        existing = await jobStore.getResult(jobId, commandId);
      } catch {
        return storeUnavailable(request, reply);
      }
      // Idempotent replay: the same command accepted once is answered from the stored result and
      // never rewritten, so a repeated device retry cannot move the observation forward.
      if (existing) {
        return reply.send({ accepted: true, replayed: true, observedAt: existing.observedAt });
      }
      let normalized: VivaProfileObservation;
      try {
        normalized = normalizeVivaProfileObservation(body.payload);
      } catch {
        return resultInvalid(request, reply);
      }
      const observedAt = new Date().toISOString();
      let putStatus: 'accepted' | 'ignored';
      try {
        putStatus = await observationRepository.put({
          tenantId: current.tenantId,
          userId: current.userId,
          observation: { ...normalized, observedAt },
        });
      } catch {
        return storeUnavailable(request, reply);
      }
      // The stored observation is monotonic. When the relay is older than what the server
      // already holds, report the persisted instant instead of the rejected one.
      let acceptedObservedAt = observedAt;
      if (putStatus === 'ignored') {
        try {
          const stored = await observationRepository.get(current.tenantId, current.userId);
          acceptedObservedAt = stored?.observedAt ?? observedAt;
        } catch {
          acceptedObservedAt = observedAt;
        }
      }
      const ttlSeconds = Math.max(1, Math.ceil((Date.parse(job.expiresAt) - Date.now()) / 1_000));
      let status: 'accepted' | 'replayed';
      try {
        status = await jobStore.putResult(
          jobId,
          {
            commandId,
            observedAt: acceptedObservedAt,
            acceptedAt: new Date().toISOString(),
          },
          ttlSeconds,
        );
      } catch {
        return storeUnavailable(request, reply);
      }
      if (status === 'replayed') {
        try {
          const stored = await jobStore.getResult(jobId, commandId);
          acceptedObservedAt = stored?.observedAt ?? acceptedObservedAt;
        } catch {
          // Keep the instant computed above: the observation itself was already persisted.
        }
      }
      // Redacted outcome only. Two identical concurrent relays may both reach put(); the monotonic
      // upsert keeps the newest observation and the client ignores this response instant, so no
      // provider value or per-user identifier is logged here.
      request.log.info(
        { outcome: putStatus === 'ignored' ? 'ignored' : status },
        'profile provider read result',
      );
      return reply.send({
        accepted: true,
        replayed: status === 'replayed',
        observedAt: acceptedObservedAt,
      });
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/profile/provider-read-jobs/:jobId/complete',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const { jobId } = request.params as { readonly jobId?: string };
      if (!jobId || !UUID_PATTERN.test(jobId)) return jobNotFound(request, reply);
      if (!options.jobStore) return storeUnavailable(request, reply);
      const jobStore = options.jobStore;
      if (!emptyBody(request.body)) return jobInvalid(request, reply);
      let job: ProfileProviderReadJob | undefined;
      try {
        job = await jobStore.get(jobId);
      } catch {
        return storeUnavailable(request, reply);
      }
      if (!job || !jobMatches(job, current)) return jobNotFound(request, reply);
      if (Date.parse(job.expiresAt) <= Date.now()) return jobExpired(request, reply);
      let result: ProfileProviderReadResult | undefined;
      try {
        result = await jobStore.getResult(job.jobId, job.commandId);
      } catch {
        return storeUnavailable(request, reply);
      }
      // Completion only announces an already accepted observation; it never creates one.
      if (!result) {
        return sendApiError(
          request,
          reply,
          409,
          'PROFILE_READ_INCOMPLETE',
          'Профиль ещё не обновлён.',
        );
      }
      try {
        // One successful completion consumes the job: a replay of the same call is answered as
        // not found instead of becoming an endless confirmation loop.
        await jobStore.consume(job.jobId, job.commandId);
      } catch {
        return storeUnavailable(request, reply);
      }
      request.log.info({ outcome: 'completed' }, 'profile provider read completion');
      return reply.send({ state: 'refreshed', observedAt: result.observedAt });
    },
  );
}
