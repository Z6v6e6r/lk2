import type { UserGameCommandResult } from '@phub/api-contracts';
import {
  createManagedSelfLeaveRepository,
  ManagedSelfLeaveError,
  type ManagedSelfLeaveAttempt,
  type ManagedSelfLeaveRepository,
  type ManagedSelfLeaveInput,
  type SelfLeaveCommandEvidence,
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
function commandEvidenceBody(e: SelfLeaveCommandEvidence): UserGameCommandResult {
  const refused = e.kind === 'NOT_DISPATCHED';
  return {
    commandId: e.commandId,
    operation: {
      id: e.commandId,
      type: 'LEAVE_GAME',
      status: refused ? 'FAILED' : 'SUCCEEDED',
      gameId: e.gameId,
      aggregateRevision: e.revision,
      createdAt: e.createdAt,
      updatedAt: e.completedAt,
      nextAction: { type: 'NONE' },
      error: refused
        ? {
            code: 'GAME_NOT_LEAVABLE',
            message: 'Исходный выход не отправлялся. Можно выбрать новое действие.',
          }
        : null,
      ...(refused
        ? {
            noDispatch: {
              schemaVersion: 1 as const,
              outcome: 'NOT_DISPATCHED' as const,
              idempotencyKeySha256: e.idempotencyKeySha256,
            },
          }
        : {}),
    },
    game: null,
    replayed: true,
  };
}
export interface ManagedSelfLeaveRuntime {
  reconcile(input: Actor & ManagedSelfLeaveInput): Promise<UserGameCommandResult>;
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
  const runtime: ManagedSelfLeaveRuntime = {
    read: (input) => projection(repository.read(input)),
    async readByKey(input) {
      const managed = await projection(repository.readByKey(input));
      if (managed) return managed;
      const evidence = await repository.readCommand(input);
      return evidence ? commandEvidenceBody(evidence) : null;
    },
    async reconcile(input) {
      const evidence = await repository.reconcileUndispatched(input);
      if (evidence) return commandEvidenceBody(evidence);
      const attempt = await repository.readByKey(input);
      if (!attempt) throw new ManagedSelfLeaveError('GAME_NOT_LEAVABLE');
      // PREPARED is still reserved for its original first caller. Reconciliation never starts it.
      if (attempt.state !== 'DISPATCH_STARTED') return managedSelfLeaveBody(attempt);
      return (await execute(input, true)) ?? managedSelfLeaveBody(attempt);
    },
    execute: (input) => execute(input, false),
  };
  async function execute(
    input: Actor & ManagedSelfLeaveInput,
    recoveryOnly: boolean,
  ): Promise<UserGameCommandResult | null> {
    // Same-key durable lookup precedes current membership or mapping resolution, including rollback.
    let attempt = await repository.readByKey(input);
    const replayed = Boolean(attempt);
    if (attempt?.state === 'COMPLETED') return managedSelfLeaveBody(attempt);
    if (!attempt) {
      const evidence = await repository.readCommand(input);
      if (evidence) return commandEvidenceBody(evidence);
      if (recoveryOnly) throw new ManagedSelfLeaveError('GAME_NOT_LEAVABLE');
      // Ordinary NO_PAYMENT does not require an external actor mapping. Its writer rechecks under lock.
      if (await repository.isNoPayment(input)) return null;
    }
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
    // Read does not mutate either owner or LK2. Only an explicit command may finalize a proof.
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
            ...(claim.recoveryOnly || recoveryOnly ? { recoveryOnly: true as const } : {}),
          });
        options.onMetric?.(claim.recoveryOnly || recoveryOnly ? 'recovery' : 'dispatch');
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
  }
  return runtime;
}
