import type { UserGameCommandResult } from '@phub/api-contracts';
import {
  createManagedSelfLeaveRepository,
  ManagedSelfLeaveError,
  type ManagedSelfLeaveAttempt,
  type ManagedSelfLeaveRepository,
  type ManagedSelfLeaveInput,
} from '@phub/database/managed-self-leave';
import type { SubscriptionRuntimeActorContextRepository } from '@phub/database';
import type { AppConfig } from '@phub/config';
import {
  ManagedSelfLeaveOwnerClient,
  type ManagedSelfLeaveReadOutcome,
} from '@phub/subscription-runtime-adapter';
import type { SubscriptionRuntimeActorDelegationIssuer } from '../subscriptions/subscription-runtime-actor-delegation-issuer.js';
import type { Pool } from 'pg';

interface Actor {
  tenantId: string;
  tenantKey: string;
  actorUserId: string;
  sessionId: string;
  correlationId: string;
}
export function managedSelfLeaveBody(
  attempt: ManagedSelfLeaveAttempt,
  replayed = true,
): UserGameCommandResult {
  const done = attempt.state === 'COMPLETED';
  return {
    commandId: attempt.authority.operationId,
    operation: {
      id: attempt.authority.operationId,
      type: 'LEAVE_GAME' as const,
      status: done ? ('SUCCEEDED' as const) : ('UNKNOWN' as const),
      gameId: attempt.authority.request.target.id,
      aggregateRevision:
        attempt.result?.revision ?? attempt.authority.request.target.expectedRevision,
      createdAt: attempt.createdAt,
      updatedAt: attempt.updatedAt,
      nextAction: done
        ? { type: 'NONE' }
        : { type: 'WAIT_FOR_RECONCILIATION', retryAfterSeconds: 15 },
      error: null,
    },
    game: null,
    replayed,
  };
}
export interface ManagedSelfLeaveRuntime {
  execute(
    input: Actor & ManagedSelfLeaveInput,
  ): Promise<ReturnType<typeof managedSelfLeaveBody> | null>;
  read(input: {
    tenantId: string;
    actorUserId: string;
    operationId: string;
  }): Promise<ReturnType<typeof managedSelfLeaveBody> | null>;
  readByKey(input: {
    tenantId: string;
    actorUserId: string;
    gameId: string;
    idempotencyKey: string;
  }): Promise<ReturnType<typeof managedSelfLeaveBody> | null>;
}
interface Boundary {
  delegationIssuer: Pick<
    SubscriptionRuntimeActorDelegationIssuer,
    'issueManagedSelfLeaveAdmission' | 'issueManagedSelfLeaveRead'
  >;
  actorContextRepository: Pick<SubscriptionRuntimeActorContextRepository, 'resolve'>;
}
export function createManagedSelfLeaveRuntime(options: {
  config: Pick<
    AppConfig,
    | 'APP_ENV'
    | 'GAME_MANAGED_SELF_LEAVE_ENABLED'
    | 'GAME_COMMERCIAL_JOIN_OWNER_BASE_URL'
    | 'GAME_COMMERCIAL_JOIN_OWNER_TIMEOUT_MS'
  >;
  pool: Pool;
  repository?: ManagedSelfLeaveRepository;
  boundary?: Boundary;
  client?: Pick<ManagedSelfLeaveOwnerClient, 'admit' | 'read'>;
  issueActorToken?: (input: {
    tenantId: string;
    tenantKey: string;
    userId: string;
    sessionId: string;
    correlationId: string;
  }) => Promise<{ token: string; expiresAt: string }>;
  onMetric?: (
    outcome: 'dispatch' | 'recovery' | 'owner_unknown' | 'owner_unavailable' | 'confirmed',
  ) => void;
}): ManagedSelfLeaveRuntime {
  const repository = options.repository ?? createManagedSelfLeaveRepository(options.pool);
  const enabled =
    options.config.GAME_MANAGED_SELF_LEAVE_ENABLED &&
    Boolean(
      options.boundary &&
      options.issueActorToken &&
      options.config.GAME_COMMERCIAL_JOIN_OWNER_BASE_URL,
    );
  const client = enabled
    ? (options.client ??
      new ManagedSelfLeaveOwnerClient({
        baseUrl: options.config.GAME_COMMERCIAL_JOIN_OWNER_BASE_URL!,
        timeoutMs: options.config.GAME_COMMERCIAL_JOIN_OWNER_TIMEOUT_MS,
        environment: ['local', 'ci'].includes(options.config.APP_ENV)
          ? 'development'
          : 'production',
      }))
    : undefined;
  const projection = async (attempt: Promise<ManagedSelfLeaveAttempt | null>) => {
    const value = await attempt;
    return value ? managedSelfLeaveBody(value) : null;
  };
  return {
    read: (input) => projection(repository.read(input)),
    readByKey: (input) => projection(repository.readByKey(input)),
    async execute(input) {
      // Same-key durable lookup precedes current membership or mapping resolution, including rollback.
      let attempt = await repository.readByKey(input);
      const replayed = Boolean(attempt);
      if (attempt?.state === 'COMPLETED') return managedSelfLeaveBody(attempt);
      if (!enabled || !client || !options.boundary || !options.issueActorToken)
        return attempt ? managedSelfLeaveBody(attempt) : null;
      const actor = {
        tenantId: input.tenantId,
        tenantKey: input.tenantKey,
        userId: input.actorUserId,
        sessionId: input.sessionId,
        correlationId: input.correlationId,
      };
      const context = await options.boundary.actorContextRepository.resolve(actor);
      if (context.outcome !== 'ok') {
        if (attempt) return managedSelfLeaveBody(attempt);
        throw new ManagedSelfLeaveError('GAME_PAYMENT_REQUIRED');
      }
      if (!attempt)
        attempt = await repository.begin({
          ...input,
          providerClientId: context.providerClientId,
          providerMappingId: context.providerMappingId,
        });
      if (!attempt) return null;
      if (attempt.state === 'COMPLETED') return managedSelfLeaveBody(attempt);
      const original = attempt.authority.originalJoinReceipt;
      if (
        original.providerClientId !== context.providerClientId ||
        original.providerMappingId !== context.providerMappingId
      )
        return managedSelfLeaveBody(attempt);
      const common = { ...actor, ...context, operationId: attempt.authority.operationId };
      let outcome: ManagedSelfLeaveReadOutcome | undefined;
      // Read does not mutate either owner or LK2. Only this explicit DELETE may finalize a proof.
      if (attempt.state === 'DISPATCH_STARTED') {
        try {
          outcome = await client.read({
            actorDelegation:
              await options.boundary.delegationIssuer.issueManagedSelfLeaveRead(common),
            operationId: common.operationId,
            correlationId: input.correlationId,
          });
        } catch {
          options.onMetric?.('owner_unavailable');
          return managedSelfLeaveBody(attempt);
        }
      }
      if (outcome?.status !== 'CONFIRMED') {
        const claim = await repository.claim({
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          operationId: common.operationId,
        });
        if (!claim)
          return managedSelfLeaveBody(
            (await repository.read({
              tenantId: input.tenantId,
              actorUserId: input.actorUserId,
              operationId: common.operationId,
            })) ?? attempt,
          );
        attempt = claim.attempt;
        try {
          const actorToken = await options.issueActorToken(actor);
          const a = attempt.authority;
          const actorDelegation =
            await options.boundary.delegationIssuer.issueManagedSelfLeaveAdmission({
              ...common,
              idempotencyKey: attempt.idempotencyKey,
              request: a.request,
              legacyGameId: a.legacyGameId,
              legacyGameMappingId: a.legacyGameMappingId,
              legacyGameMappingVersion: a.legacyGameMappingVersion,
              actorToken,
              ...(claim.recoveryOnly ? { recoveryOnly: true as const } : {}),
            });
          options.onMetric?.(claim.recoveryOnly ? 'recovery' : 'dispatch');
          outcome = await client.admit(a.request, {
            actorDelegation,
            actorToken,
            operationId: a.operationId,
            correlationId: input.correlationId,
          });
        } catch {
          options.onMetric?.('owner_unavailable');
          return managedSelfLeaveBody(attempt, replayed);
        }
      }
      if (outcome?.status === 'CONFIRMED' && outcome.receipt) {
        // The repository independently validates all receipt identity/hash fields, even on completed replay.
        try {
          const final = await repository.finalize({
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            operationId: common.operationId,
            receipt: outcome.receipt,
            correlationId: input.correlationId,
          });
          options.onMetric?.('confirmed');
          return managedSelfLeaveBody(final, replayed);
        } catch (error) {
          if (
            error instanceof ManagedSelfLeaveError ||
            (error instanceof Error && error.message === 'MANAGED_SELF_LEAVE_GENERATION_CONFLICT')
          ) {
            options.onMetric?.('owner_unknown');
            return managedSelfLeaveBody(attempt, replayed);
          }
          throw error;
        }
      }
      options.onMetric?.('owner_unknown');
      return managedSelfLeaveBody(attempt, replayed);
    },
  };
}
