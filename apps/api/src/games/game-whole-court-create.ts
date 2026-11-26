import { isDeepStrictEqual } from 'node:util';
import type { UserGameCommandResult } from '@phub/api-contracts';
import type {
  GameRepository,
  WholeCourtCheckoutBinding,
  WholeCourtCheckoutScope,
  createWholeCourtCheckoutRepository,
  SubscriptionRuntimeActorContextRepository,
} from '@phub/database';
import { qcExact, qcIso, qcUuid, qcId } from '@phub/domain/quarter-create';
import { bookedOperationAdmissionId } from '@phub/subscription-runtime-adapter';

import {
  subscriptionRuntimeIdempotencyKeySha256,
  type SubscriptionRuntimeActorDelegationIssuer,
} from '../subscriptions/subscription-runtime-actor-delegation-issuer.js';
import {
  commercialCreateDraftGameId,
  commercialCreateRequestHash,
  type CommercialCreateCommandEnvelope,
} from './game-create-commercial.js';
import {
  parseWholeCourtReceipt,
  wholeCourtAmount,
  type WholeCourtMode,
  type WholeCourtOwnerBody,
  type createWholeCourtOwner,
} from './game-whole-court-owner.js';

interface WholeCourtActor {
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly correlationId: string;
}

export interface WholeCourtPilot {
  readonly tenantId: string;
  readonly userId: string;
  readonly stationId: string;
  readonly courtId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly amountMinor: number;
}

export function parseWholeCourtPilot(raw: string): WholeCourtPilot {
  const p = qcExact(
    JSON.parse(raw) as unknown,
    'tenantId,userId,stationId,courtId,startsAt,endsAt,amountMinor',
  );
  if (
    !qcUuid(p.tenantId) ||
    !qcUuid(p.userId) ||
    !qcUuid(p.stationId) ||
    !qcUuid(p.courtId) ||
    !qcIso(p.startsAt) ||
    !qcIso(p.endsAt) ||
    !wholeCourtAmount(p.amountMinor)
  )
    throw new Error('WHOLE_COURT_PILOT_INVALID');
  const start = Date.parse(p.startsAt),
    end = Date.parse(p.endsAt);
  const localDate = (ms: number) => new Date(ms + 180 * 60_000).toISOString().slice(0, 10);
  if (
    start % 60_000 !== 0 ||
    ![60, 90, 120].includes((end - start) / 60_000) ||
    localDate(start) !== localDate(end)
  )
    throw new Error('WHOLE_COURT_PILOT_WINDOW_INVALID');
  return {
    tenantId: p.tenantId,
    userId: p.userId,
    stationId: p.stationId,
    courtId: p.courtId,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
    amountMinor: p.amountMinor,
  };
}

type Stored = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createWholeCourtCheckoutRepository>['read']>>
>;

export class WholeCourtCreateError extends Error {
  constructor(
    readonly code:
      | 'GAME_PAYMENT_REQUIRED'
      | 'GAME_PRICE_CONFIRMATION_REQUIRED'
      | 'GAME_LOCATION_INVALID'
      | 'GAME_START_TIME_PASSED'
      | 'GAME_SLOT_UNAVAILABLE'
      | 'GAME_INVITEE_INELIGIBLE'
      | 'IDEMPOTENCY_KEY_REUSED'
      | 'GAME_OPERATION_NOT_FOUND'
      | 'GAME_OWNER_UNAVAILABLE',
    readonly status: number,
  ) {
    super(code);
  }
}

function parseBinding(raw: unknown): WholeCourtCheckoutBinding {
  const b = qcExact(raw, 'providerClientId,providerStationId,providerRoomId,amountMinor');
  if (
    !qcId(b.providerClientId) ||
    !qcId(b.providerStationId) ||
    !qcId(b.providerRoomId) ||
    !wholeCourtAmount(b.amountMinor)
  )
    throw new Error('WHOLE_COURT_BINDING_INVALID');
  return {
    providerClientId: b.providerClientId,
    providerStationId: b.providerStationId,
    providerRoomId: b.providerRoomId,
    amountMinor: b.amountMinor,
  };
}

export function createWholeCourtRuntime(options: {
  readonly pilot: WholeCourtPilot;
  readonly onMetric?: (outcome: string) => void;
  readonly games: Pick<GameRepository, 'create' | 'getCardProjection' | 'projectCardEvent'>;
  readonly repository: ReturnType<typeof createWholeCourtCheckoutRepository>;
  readonly context: Pick<SubscriptionRuntimeActorContextRepository, 'resolve'>;
  readonly issuer: Pick<SubscriptionRuntimeActorDelegationIssuer, 'issueWholeCourtCheckout'>;
  readonly token: (actor: WholeCourtActor) => Promise<{ token: string; expiresAt: string }>;
  readonly location: (
    actor: WholeCourtActor & { stationId: string; courtId: string },
  ) => Promise<{ providerStationId: string; providerRoomId: string } | undefined>;
  readonly owner: ReturnType<typeof createWholeCourtOwner>;
}) {
  const pilot = options.pilot;
  const permitted = (actor: WholeCourtActor) =>
    actor.tenantId === pilot.tenantId &&
    actor.userId === pilot.userId &&
    actor.tenantKey === 'iSkq6G';

  function body(
    scope: WholeCourtCheckoutScope,
    row: Stored,
    action: UserGameCommandResult['operation']['nextAction'],
    confirmedAt?: string,
  ): UserGameCommandResult {
    const state = confirmedAt
      ? 'SUCCEEDED'
      : action.type === 'OPEN_PAYMENT'
        ? 'PROCESSING'
        : 'UNKNOWN';
    return {
      commandId: scope.operationId,
      game: null,
      replayed: true,
      operation: {
        id: scope.operationId,
        type: 'CREATE_GAME',
        status: state,
        gameId: row.gameId,
        aggregateRevision: row.revision,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        nextAction: action,
        error: null,
        commercial: {
          attemptState: confirmedAt ? 'OWNER_CONFIRMED' : 'OWNER_PENDING',
          receipt: confirmedAt ? { provider: 'VIVA', status: 'CONFIRMED', confirmedAt } : null,
          reservation: null,
          price: null,
          reason: null,
        },
      },
    };
  }

  async function advance(
    actor: WholeCourtActor,
    scope: WholeCourtCheckoutScope,
    mode: WholeCourtMode,
  ) {
    if (!permitted(actor)) throw new WholeCourtCreateError('GAME_OPERATION_NOT_FOUND', 404);
    const row = await options.repository.read(scope);
    const keySha = subscriptionRuntimeIdempotencyKeySha256(scope.idempotencyKey);
    const identity = { ...scope, idempotencyKeySha256: keySha };
    if (
      !row ||
      row.gameId !== commercialCreateDraftGameId(identity) ||
      bookedOperationAdmissionId(actor.tenantId, actor.userId, keySha) !== scope.operationId
    )
      throw new WholeCourtCreateError('GAME_OPERATION_NOT_FOUND', 404);
    const pending = (outcome: string) => {
      try {
        options.onMetric?.(outcome);
      } catch {
        /* optional telemetry */
      }
      return body(scope, row, { type: 'WAIT_FOR_RECONCILIATION', retryAfterSeconds: 3 });
    };
    let failureStage = 'ORIGINAL_BINDING_INVALID';
    try {
      const binding = parseBinding(row.binding);
      let stored = row;
      if (row.state === 'PENDING') {
        failureStage = 'ACTOR_DELEGATION_UNAVAILABLE';
        const mapped = await options.context.resolve(actor);
        if (mapped.outcome !== 'ok' || mapped.providerClientId !== binding.providerClientId)
          return pending('ACTOR_MAPPING_CHANGED');
        const token = await options.token(actor);
        const fresh = await options.context.resolve(actor);
        if (!isDeepStrictEqual(mapped, fresh)) return pending('ACTOR_MAPPING_CHANGED');
        const wire: WholeCourtOwnerBody = {
          contractVersion: 1,
          action: 'CREATE_GAME',
          operationId: scope.operationId,
          draftId: row.gameId,
          stationId: binding.providerStationId,
          roomId: binding.providerRoomId,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          amountMinor: binding.amountMinor,
          currency: 'RUB',
        };
        const delegation = await options.issuer.issueWholeCourtCheckout({
          ...actor,
          mode,
          body: wire,
          providerClientId: binding.providerClientId,
          actorToken: token,
          idempotencyKeySha256: keySha,
        });
        const result = await options.owner({
          mode,
          body: wire,
          delegation,
          token: token.token,
          correlationId: actor.correlationId,
        });
        if (result.status === 'UNKNOWN') return pending('OWNER_UNRESOLVED');
        if (result.status === 'AWAITING_PAYMENT')
          return body(scope, row, {
            type: 'OPEN_PAYMENT',
            url: result.url,
            expiresAt: result.expiresAt,
          });
        failureStage = 'RECEIPT_FINALIZATION_UNRESOLVED';
        await options.repository.finalize({
          ...scope,
          gameId: row.gameId,
          binding,
          receipt: result.receipt,
          correlationId: actor.correlationId,
        });
        stored = (await options.repository.read(scope)) ?? row;
      }
      if (stored.state !== 'SUCCEEDED' || !qcUuid(stored.projectionEventId))
        return pending('RECEIPT_NOT_STORED');
      failureStage = 'STORED_RECEIPT_INVALID';
      const receipt = parseWholeCourtReceipt(stored.receipt, binding.amountMinor);
      // Use the same outbox event and inbox claim as the Worker. The return waits for the actual
      // card, so the browser cannot navigate to a private game still missing its projection.
      failureStage = 'CARD_PROJECTION_PENDING';
      let card = await options.games.getCardProjection(actor.tenantId, row.gameId);
      if (!card || card.aggregateRevision < stored.revision) {
        await options.games.projectCardEvent({
          tenantId: actor.tenantId,
          gameId: row.gameId,
          eventId: stored.projectionEventId,
        });
        card = await options.games.getCardProjection(actor.tenantId, row.gameId);
      }
      if (!card || card.aggregateRevision < stored.revision)
        return pending('CARD_PROJECTION_PENDING');
      return body(scope, stored, { type: 'NONE' }, receipt.confirmedAt);
    } catch {
      return pending(failureStage);
    }
  }

  return {
    offer(actor: WholeCourtActor) {
      if (!permitted(actor) || Date.parse(pilot.startsAt) <= Date.now()) return { offer: null };
      const { stationId, courtId, startsAt, endsAt, amountMinor } = pilot;
      return {
        offer: { stationId, courtId, startsAt, endsAt, amountMinor, currency: 'RUB' as const },
      };
    },
    async start(input: CommercialCreateCommandEnvelope) {
      const p = input.payload;
      const validOffer =
        permitted(input) &&
        p.stationId === pilot.stationId &&
        p.courtId === pilot.courtId &&
        p.startsAt === pilot.startsAt &&
        p.endsAt === pilot.endsAt &&
        p.visibility === 'PRIVATE' &&
        p.kind === 'FRIENDLY' &&
        p.paymentMode === 'ORGANIZER_PAYS' &&
        p.capacity === 4 &&
        input.subscriptionInstanceId === undefined;
      if (!validOffer || !p.courtId) throw new WholeCourtCreateError('GAME_PAYMENT_REQUIRED', 409);
      if (
        input.priceConsent?.amountMinor !== pilot.amountMinor ||
        input.priceConsent.currency !== 'RUB'
      )
        throw new WholeCourtCreateError('GAME_PRICE_CONFIRMATION_REQUIRED', 409);
      const operationId = bookedOperationAdmissionId(
        input.tenantId,
        input.userId,
        input.idempotencyKeySha256,
      );
      const gameId = commercialCreateDraftGameId(input);
      const scope = {
        tenantId: input.tenantId,
        userId: input.userId,
        operationId,
        idempotencyKey: input.idempotencyKey,
      };
      const prior = await options.repository.read(scope);
      let binding: WholeCourtCheckoutBinding;
      if (prior) {
        binding = parseBinding(prior.binding);
      } else {
        const location = await options.location({
          ...input,
          stationId: p.stationId,
          courtId: p.courtId,
        });
        if (!location) throw new WholeCourtCreateError('GAME_LOCATION_INVALID', 409);
        const mapped = await options.context.resolve(input);
        if (mapped.outcome !== 'ok') throw new WholeCourtCreateError('GAME_OWNER_UNAVAILABLE', 503);
        binding = parseBinding({
          ...location,
          providerClientId: mapped.providerClientId,
          amountMinor: pilot.amountMinor,
        });
      }
      const joinCutoffAt = new Date(Date.parse(p.startsAt) - 30 * 60_000).toISOString();
      const result = await options.games.create({
        ...p,
        joinCutoffAt,
        tenantId: input.tenantId,
        actorUserId: input.userId,
        gameId,
        operationId,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
        requestHash: commercialCreateRequestHash(input, { joinCutoffAt }),
        wholeCourtCheckout: binding,
      });
      if (result.outcome === 'idempotency_conflict')
        throw new WholeCourtCreateError('IDEMPOTENCY_KEY_REUSED', 409);
      if (result.outcome === 'rejected') throw new WholeCourtCreateError(result.code, 409);
      if (result.gameId !== gameId || result.operationId !== operationId)
        throw new WholeCourtCreateError('IDEMPOTENCY_KEY_REUSED', 409);
      return { ...(await advance(input, scope, 'reserve')), replayed: result.replayed };
    },
    resume(
      actor: WholeCourtActor,
      body: { operationId: string; idempotencyKey: string; mode: WholeCourtMode },
    ) {
      return advance(
        actor,
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          operationId: body.operationId,
          idempotencyKey: body.idempotencyKey,
        },
        body.mode,
      );
    },
  };
}

export type WholeCourtRuntime = ReturnType<typeof createWholeCourtRuntime>;
