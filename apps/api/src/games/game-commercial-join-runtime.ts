import { createGameStationMembershipAdmission } from './game-station-membership.js';
import { createHash } from 'node:crypto';

import type { AppConfig } from '@phub/config';
import type {
  BookedOperationAdmissionTargetRepository,
  GameRosterRepository,
  SubscriptionRuntimeActorContextRepository,
  PaidJoinProviderBinding,
} from '@phub/database';
import { createBookedOperationAdmissionTargetRepository } from '../../../../packages/database/src/booked-operation-admission-target-repository.js';
import {
  ManagedJoinOwnerClient,
  ManagedJoinOwnerError,
  managedJoinAdmissionSha256,
  type ManagedJoinPreflightRequest,
  type ManagedJoinAdmissionRequest,
  BookedOperationAdmissionClient,
  BookedOperationReadClient,
  BookedOperationReadError,
  bookedOperationAdmissionRequestSha256,
  type BookedOperationAdmissionRequest,
  type BookedOperationReadOutcome,
} from '@phub/subscription-runtime-adapter';

import { subscriptionRuntimeIdempotencyKeySha256 } from '../subscriptions/subscription-runtime-actor-delegation-issuer.js';
import type { SubscriptionRuntimeActorDelegationIssuer } from '../subscriptions/subscription-runtime-actor-delegation-issuer.js';
import type {
  CommercialJoinOwnerOutcome,
  CommercialJoinOwnerPort,
} from './game-commercial-join.js';
import type { GameJoinConditionsOwner } from './game-join-conditions.js';
import type { GameCommercialJoinOptions } from './game-routes.js';

/**
 * Runtime composition of the commercial JOIN path.
 *
 * Owner: C1 (commercial server path). Purpose: let the paid JOIN reach the existing owner of
 * booking/entitlement through the already-issued actor delegation instead of inventing a second
 * executor. Activation: `GAME_COMMERCIAL_JOIN_ENABLED=true` plus the existing delegation material
 * (`SUBSCRIPTION_RUNTIME_DELEGATION_*`, composed by the subscription-runtime WARN boundary) and the
 * join-conditions owner. Removal/review condition: remove when a dedicated booked-operation owner
 * adapter replaces the WARN boundary reuse, or when the owner receiver contract lands.
 *
 * Fail-closed: without every dependency the factory returns `undefined`, so the routes keep
 * answering `GAME_PAYMENT_REQUIRED` exactly as before.
 */

type CommercialJoinConfig = Partial<
  Pick<
    AppConfig,
    | 'LK_STATION_MEMBERSHIP_LIFETIME_ENABLED'
    | 'LK2_STATION_MEMBERSHIP_DELEGATION_AUDIENCE'
    | 'SUBSCRIPTION_RUNTIME_DELEGATION_PRIVATE_KEYS'
    | 'SUBSCRIPTION_RUNTIME_DELEGATION_ACTIVE_KEY_ID'
    | 'SUBSCRIPTION_RUNTIME_DELEGATION_ISSUER'
  >
> &
  Pick<
    AppConfig,
    | 'APP_ENV'
    | 'GAME_COMMERCIAL_JOIN_ENABLED'
    | 'GAME_COMMERCIAL_JOIN_OWNER_BASE_URL'
    | 'GAME_COMMERCIAL_JOIN_OWNER_TIMEOUT_MS'
  >;

/** User-scoped, backend-issued provider credential handed to the owner for exactly one operation. */
export interface CommercialJoinActorToken {
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * Admission transport port. The default implementation wraps the shared booked-operation client and
 * intentionally cannot send the actor token yet: adding `X-Subscription-Actor-Token` and the matching
 * `actor_token_sha256` claim is the pending wire-contract extension owned by D0. A transport that can
 * carry the token is injected here once that contract exists, without touching this adapter again.
 */
export interface BookedOperationAdmissionTransport {
  admit(
    request: BookedOperationAdmissionRequest,
    envelope: {
      readonly actorDelegation: string;
      readonly correlationId: string;
      readonly operationId: string;
      readonly actorToken?: CommercialJoinActorToken;
      readonly actorTokenSha256?: string;
    },
  ): Promise<BookedOperationReadOutcome>;
}

export interface GameCommercialJoinOwnerBoundary {
  readonly delegationIssuer: Pick<
    SubscriptionRuntimeActorDelegationIssuer,
    'issueBookedOperationAdmission' | 'issueBookedOperationRead'
  > &
    Partial<
      Pick<
        SubscriptionRuntimeActorDelegationIssuer,
        'issueManagedJoinPreflight' | 'issueManagedJoinAdmission' | 'issueManagedJoinRead'
      >
    >;
  readonly managedJoinClient?: Pick<ManagedJoinOwnerClient, 'preflight' | 'admit' | 'read'>;
  readonly actorContextRepository: Pick<SubscriptionRuntimeActorContextRepository, 'resolve'>;
  readonly targetRepository?: BookedOperationAdmissionTargetRepository;
  readonly admissionTransport?: BookedOperationAdmissionTransport;
  /**
   * Server-side resolution of the provider client subscription id for the selected product. Without
   * it the owner cannot execute the subscription booking, so the flow fails closed before dispatch.
   */
  readonly resolveProviderClientSubscriptionId?: (input: {
    readonly tenantId: string;
    readonly tenantKey: string;
    readonly userId: string;
    readonly sessionId: string;
    readonly gameId: string;
    readonly subscriptionInstanceId: string;
  }) => Promise<string | undefined>;
}

/** Stable binding of a user-scoped token; the owner verifies the claim against the header value. */
export function bookedOperationActorTokenBinding(actorToken: CommercialJoinActorToken): {
  readonly actorTokenSha256: string;
  readonly actorTokenExpiresAt: string;
} {
  return {
    actorTokenSha256: `sha256:${createHash('sha256').update(actorToken.token, 'utf8').digest('hex')}`,
    actorTokenExpiresAt: actorToken.expiresAt,
  };
}

export interface GameCommercialJoinRuntimeOptions {
  readonly config: CommercialJoinConfig;
  readonly pool: Parameters<typeof createBookedOperationAdmissionTargetRepository>[0];
  readonly rosterRepository: Pick<
    GameRosterRepository,
    'beginPaidJoin' | 'getPaidJoinAttempt' | 'failPaidJoinAttempt' | 'confirmPayment'
  >;
  readonly conditionsOwner?: GameJoinConditionsOwner;
  readonly ownerBoundary?: GameCommercialJoinOwnerBoundary;
  /**
   * Issues the short-lived, user-scoped provider credential for exactly this operation. Wired from
   * the existing `AuthService.issueVivaAccessToken`; when absent the flow keeps today's fail-closed
   * behaviour and never sends an unattributable provider write.
   */
  readonly issueActorToken?: (actor: {
    readonly tenantId: string;
    readonly tenantKey: string;
    readonly userId: string;
    readonly sessionId: string;
    readonly correlationId: string;
  }) => Promise<CommercialJoinActorToken>;
}

function environment(config: CommercialJoinConfig): 'development' | 'production' {
  return config.APP_ENV === 'local' || config.APP_ENV === 'ci' ? 'development' : 'production';
}

/**
 * Adapter onto the existing owner contract. It never reports success: a booking id, an HTTP 200 or
 * an owner "confirmed" answer cannot make the LK2 attempt SUCCEEDED — only a trusted receipt can,
 * and that receipt arrives through the legacy owner channel.
 */
export function createBookedOperationOwner(options: {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly environment: 'development' | 'production';
  readonly boundary: Omit<GameCommercialJoinOwnerBoundary, 'targetRepository'>;
  readonly targetRepository: BookedOperationAdmissionTargetRepository;
  readonly issueActorToken?: (actor: {
    readonly tenantId: string;
    readonly tenantKey: string;
    readonly userId: string;
    readonly sessionId: string;
    readonly correlationId: string;
  }) => Promise<CommercialJoinActorToken>;
  readonly onMetric?: (
    outcome:
      'execute_pending' | 'execute_unknown' | 'read' | 'read_failure' | 'actor_token_unavailable',
  ) => void;
}): CommercialJoinOwnerPort {
  const admissionClient = new BookedOperationAdmissionClient({
    baseUrl: options.baseUrl,
    environment: options.environment,
    timeoutMs: options.timeoutMs,
    ...(options.onMetric
      ? { onMetric: (metric) => options.onMetric?.(`execute_${metric}` as never) }
      : {}),
  });
  // Until the wire contract can carry the token, the shared client is the only transport and the
  // token binding is computed but not transmitted. The metric keeps that state observable.
  const admissionTransport: BookedOperationAdmissionTransport = options.boundary
    .admissionTransport ?? {
    admit: (request, envelope) => admissionClient.admit(request, envelope),
  };
  const readClient = new BookedOperationReadClient({
    baseUrl: options.baseUrl,
    environment: options.environment,
    timeoutMs: options.timeoutMs,
  });

  const managedClient =
    options.boundary.managedJoinClient ??
    new ManagedJoinOwnerClient({
      baseUrl: options.baseUrl,
      environment: options.environment,
      timeoutMs: options.timeoutMs,
    });
  const resolveActor = async (actor: {
    readonly tenantId: string;
    readonly userId: string;
    readonly sessionId: string;
  }) => options.boundary.actorContextRepository.resolve(actor);

  const resolveProviderClientSubscriptionId = async (input: {
    readonly actor: {
      readonly tenantId: string;
      readonly tenantKey: string;
      readonly userId: string;
      readonly sessionId: string;
      readonly gameId: string;
    };
    readonly subscriptionInstanceId: string;
  }): Promise<string | undefined> =>
    options.boundary.resolveProviderClientSubscriptionId?.({
      tenantId: input.actor.tenantId,
      tenantKey: input.actor.tenantKey,
      userId: input.actor.userId,
      sessionId: input.actor.sessionId,
      gameId: input.actor.gameId,
      subscriptionInstanceId: input.subscriptionInstanceId,
    });

  const dispatch = async (
    input: Omit<Parameters<CommercialJoinOwnerPort['execute']>[0], 'price'>,
    recoveryOnly = false,
  ): Promise<CommercialJoinOwnerOutcome> => {
    if (recoveryOnly && (!input.managedJoin || !input.providerBinding || !input.reservationId))
      return { status: 'UNKNOWN' };
    const context = await resolveActor({
      tenantId: input.actor.tenantId,
      userId: input.actor.userId,
      sessionId: input.actor.sessionId,
    });
    // An unproven actor context must not book anything, and it must not lose the attempt either.
    if (context.outcome !== 'ok') return { status: 'UNKNOWN' } satisfies CommercialJoinOwnerOutcome;
    const target =
      input.providerBinding ??
      (await options.targetRepository.resolve({
        tenantId: input.actor.tenantId,
        targetId: input.actor.gameId,
        expectedRevision: input.actor.expectedRevision,
      }));
    // The game has no verified owner mapping: this is not a chargeable target, so fail closed
    // without keeping a seat for an operation that can never be executed.
    if (!target) return { status: 'REJECTED', code: 'GAME_PAYMENT_REQUIRED' };
    if (
      input.providerBinding &&
      (input.providerBinding.providerClientId !== context.providerClientId ||
        input.providerBinding.providerMappingId !== context.providerMappingId)
    )
      return { status: 'UNKNOWN' };
    if (!target.admissible) return { status: 'REJECTED', code: 'GAME_SERVICE_BLOCKED' };
    // The selected product must have a server-side provider subscription mapping; otherwise the
    // owner cannot execute the booking and the user has to pick a different product.
    const providerClientSubscriptionId =
      input.providerBinding?.providerClientSubscriptionId ??
      input.providerClientSubscriptionId ??
      (options.issueActorToken
        ? await options.boundary.resolveProviderClientSubscriptionId?.({
            tenantId: input.actor.tenantId,
            tenantKey: input.actor.tenantKey,
            userId: input.actor.userId,
            sessionId: input.actor.sessionId,
            gameId: input.actor.gameId,
            subscriptionInstanceId: input.subscriptionInstanceId,
          })
        : undefined);
    if (options.issueActorToken && !providerClientSubscriptionId) {
      return { status: 'REJECTED', code: 'GAME_SUBSCRIPTION_SELECTION_REQUIRED' };
    }
    const request: BookedOperationAdmissionRequest = {
      action: 'JOIN_GAME',
      target: { id: input.actor.gameId, expectedRevision: input.actor.expectedRevision },
      paymentIntent: 'USE_SUBSCRIPTION',
    };
    let actorToken: CommercialJoinActorToken | undefined;
    if (options.issueActorToken) {
      try {
        actorToken = await options.issueActorToken({
          tenantId: input.actor.tenantId,
          tenantKey: input.actor.tenantKey,
          userId: input.actor.userId,
          sessionId: input.actor.sessionId,
          correlationId: input.correlationId,
        });
      } catch {
        // No credential, no attributable provider write: unresolved, never failed.
        options.onMetric?.('actor_token_unavailable');
        return { status: 'UNKNOWN' };
      }
    }
    if (input.managedJoin) {
      const issue = options.boundary.delegationIssuer.issueManagedJoinAdmission;
      if (!issue || !actorToken || !input.reservationId || !providerClientSubscriptionId)
        return { status: 'UNKNOWN' };
      const request: ManagedJoinAdmissionRequest = {
        contractVersion: 2,
        action: 'JOIN_GAME',
        target: { id: input.actor.gameId, expectedRevision: input.actor.expectedRevision },
        paymentIntent: 'USE_SUBSCRIPTION',
        entitlement: input.managedJoin.entitlement,
      };
      if (managedJoinAdmissionSha256(request) !== input.providerBinding?.requestSha256)
        return { status: 'UNKNOWN' };
      try {
        const actorDelegation = await issue.call(options.boundary.delegationIssuer, {
          ...input.actor,
          ...context,
          ...target,
          operationId: input.operationId,
          correlationId: input.correlationId,
          idempotencyKey: input.idempotencyKey,
          request,
          actorToken,
          providerClientSubscriptionId,
          reservationId: input.reservationId,
          ...(recoveryOnly ? { recoveryOnly: true as const } : {}),
        });
        await managedClient.admit(request, {
          actorDelegation,
          actorToken,
          correlationId: input.correlationId,
          operationId: input.operationId,
        });
        return { status: 'PENDING' };
      } catch {
        return { status: 'UNKNOWN' };
      }
    }
    try {
      const actorDelegation = await options.boundary.delegationIssuer.issueBookedOperationAdmission(
        {
          tenantId: input.actor.tenantId,
          tenantKey: input.actor.tenantKey,
          userId: input.actor.userId,
          sessionId: input.actor.sessionId,
          providerClientId: context.providerClientId,
          providerMappingId: context.providerMappingId,
          providerExerciseId: target.providerExerciseId,
          targetMappingId: target.targetMappingId,
          targetVersion: target.targetVersion,
          startsAt: target.startsAt,
          durationMinutes: target.durationMinutes,
          capacity: target.capacity,
          admissible: target.admissible,
          operationId: input.operationId,
          correlationId: input.correlationId,
          idempotencyKey: input.idempotencyKey,
          request,
          ...(input.reservationId ? { reservationId: input.reservationId } : {}),
          ...(actorToken === undefined || providerClientSubscriptionId === undefined
            ? {}
            : {
                actorToken,
                providerClientSubscriptionId,
              }),
        },
      );
      await admissionTransport.admit(request, {
        actorDelegation,
        correlationId: input.correlationId,
        operationId: input.operationId,
        ...(actorToken === undefined
          ? {}
          : {
              actorToken,
              actorTokenSha256: bookedOperationActorTokenBinding(actorToken).actorTokenSha256,
            }),
      });
      options.onMetric?.('execute_pending');
      return { status: 'PENDING' };
    } catch {
      // A conflict or an unavailable owner is not a definitive rejection: keep the attempt and let
      // readback reconcile it. Only an explicit REJECTED outcome may terminate the operation.
      options.onMetric?.('execute_unknown');
      return { status: 'UNKNOWN' };
    }
  };

  const owner: CommercialJoinOwnerPort = {
    resolveProviderClientSubscriptionId,
    async prepareManaged(input) {
      const prepared = await owner.prepare!(input);
      if (prepared.outcome !== 'prepared') return prepared;
      const issuer = options.boundary.delegationIssuer;
      if (!issuer.issueManagedJoinPreflight || !options.issueActorToken)
        return { outcome: 'not_available' };
      const binding = prepared.binding;
      const actorToken = await options.issueActorToken({
        ...input.actor,
        correlationId: input.correlationId,
      });
      const request: ManagedJoinPreflightRequest = {
        contractVersion: 2,
        action: 'JOIN_GAME',
        target: { id: input.actor.gameId, expectedRevision: input.actor.expectedRevision },
        paymentIntent: 'USE_SUBSCRIPTION',
      };
      const actorDelegation = await issuer.issueManagedJoinPreflight({
        ...input.actor,
        ...binding,
        operationId: input.operationId,
        correlationId: input.correlationId,
        idempotencyKey: input.idempotencyKey,
        actorToken,
        request,
      });
      const result = await managedClient.preflight(request, {
        actorDelegation,
        actorToken,
        correlationId: input.correlationId,
        operationId: input.operationId,
      });
      if ('management' in result) return prepared; // Only the strict explicit LEGACY union reaches v1.
      const managedJoin = {
        contractVersion: 2 as const,
        requestFingerprint: input.requestFingerprint,
        entitlement: result.entitlement,
      };
      return {
        outcome: 'prepared',
        binding: {
          ...binding,
          requestSha256: managedJoinAdmissionSha256({
            ...request,
            entitlement: result.entitlement,
          }),
        },
        managedJoin,
      };
    },
    async prepare(input) {
      const context = await resolveActor(input.actor);
      if (context.outcome !== 'ok') return { outcome: 'not_available' } as const;
      const target = await options.targetRepository.resolve({
        tenantId: input.actor.tenantId,
        targetId: input.actor.gameId,
        expectedRevision: input.actor.expectedRevision,
      });
      const providerClientSubscriptionId = await resolveProviderClientSubscriptionId(input);
      if (!target || !target.admissible) return { outcome: 'not_available' } as const;
      // The selected product has no server-side provider subscription mapping. The owner cannot
      // execute that selection, so the client must choose a different product (selection problem),
      // not be told that payment is unavailable.
      if (!providerClientSubscriptionId) return { outcome: 'selection_required' } as const;
      return {
        outcome: 'prepared',
        binding: {
          ...target,
          providerClientId: context.providerClientId,
          providerMappingId: context.providerMappingId,
          providerClientSubscriptionId,
          requestSha256: bookedOperationAdmissionRequestSha256({
            action: 'JOIN_GAME',
            target: { id: input.actor.gameId, expectedRevision: input.actor.expectedRevision },
            paymentIntent: 'USE_SUBSCRIPTION',
          }),
          idempotencyKeySha256: subscriptionRuntimeIdempotencyKeySha256(input.idempotencyKey),
        } satisfies PaidJoinProviderBinding,
      };
    },
    execute: (input) => dispatch(input),
    recover: (input) => dispatch(input, true),
    async read(input) {
      const context = await resolveActor({
        tenantId: input.actor.tenantId,
        userId: input.actor.userId,
        sessionId: input.actor.sessionId,
      });
      if (context.outcome !== 'ok') return { status: 'UNKNOWN' };
      if (input.managedJoin) {
        const issue = options.boundary.delegationIssuer.issueManagedJoinRead;
        if (!issue) return { status: 'UNKNOWN' };
        try {
          const actorDelegation = await issue.call(options.boundary.delegationIssuer, {
            ...input.actor,
            ...context,
            operationId: input.operationId,
            correlationId: input.correlationId,
            includeReceipt: true,
          });
          const result = await managedClient.read({
            actorDelegation,
            correlationId: input.correlationId,
            operationId: input.operationId,
          });
          if (result.status === 'CONFIRMED' && result.receipt)
            return { status: 'CONFIRMED', receipt: result.receipt };
          return { status: result.status === 'PENDING' ? 'PENDING' : 'UNKNOWN' };
        } catch (error) {
          return error instanceof ManagedJoinOwnerError && error.status === 404
            ? null
            : { status: 'UNKNOWN' };
        }
      }
      try {
        const actorDelegation = await options.boundary.delegationIssuer.issueBookedOperationRead({
          tenantId: input.actor.tenantId,
          tenantKey: input.actor.tenantKey,
          userId: input.actor.userId,
          sessionId: input.actor.sessionId,
          providerClientId: context.providerClientId,
          providerMappingId: context.providerMappingId,
          operationId: input.operationId,
          correlationId: input.correlationId,
          includeReceipt: true,
        });
        const outcome = await readClient.read(input.operationId, {
          actorDelegation,
          correlationId: input.correlationId,
          includeReceipt: true,
        });
        options.onMetric?.('read');
        if (outcome.status === 'PENDING') return { status: 'PENDING' };
        // CONFIRMED means the owner booking exists; the LK2 participation is still finalized only by
        // the trusted receipt, so the client keeps waiting instead of being told SUCCEEDED.
        if (outcome.status === 'CONFIRMED' && outcome.receipt)
          return { status: 'CONFIRMED', receipt: outcome.receipt };
        if (outcome.status === 'CONFIRMED') return { status: 'PENDING' };
        return { status: 'UNKNOWN' };
      } catch (error) {
        if (error instanceof BookedOperationReadError && error.status === 404) return null;
        options.onMetric?.('read_failure');
        return { status: 'UNKNOWN' };
      }
    },
  };
  return owner;
}

export function createGameCommercialJoinRuntime(
  options: GameCommercialJoinRuntimeOptions,
): GameCommercialJoinOptions | undefined {
  const { config } = options;
  if (!config.GAME_COMMERCIAL_JOIN_ENABLED) return undefined;
  if (!options.conditionsOwner || !options.ownerBoundary) return undefined;
  // Without an attributable user credential and a server-side provider subscription mapping the
  // owner cannot execute the booking, so a half-composed runtime must keep the old fail-closed guard.
  if (!options.issueActorToken || !options.rosterRepository.confirmPayment) return undefined;
  if (!options.ownerBoundary.resolveProviderClientSubscriptionId) return undefined;
  const baseUrl = config.GAME_COMMERCIAL_JOIN_OWNER_BASE_URL;
  if (!baseUrl) return undefined;
  const owner = createBookedOperationOwner({
    baseUrl,
    timeoutMs: config.GAME_COMMERCIAL_JOIN_OWNER_TIMEOUT_MS,
    environment: environment(config),
    boundary: options.ownerBoundary,
    targetRepository:
      options.ownerBoundary.targetRepository ??
      createBookedOperationAdmissionTargetRepository(options.pool),
    ...(options.issueActorToken ? { issueActorToken: options.issueActorToken } : {}),
  });
  const stationMembership = createGameStationMembershipAdmission({ config, pool: options.pool });
  return {
    ...(stationMembership ? { stationMembership } : {}),
    repository: options.rosterRepository as unknown as GameCommercialJoinOptions['repository'],
    conditionsOwner: options.conditionsOwner,
    owner,
  };
}
