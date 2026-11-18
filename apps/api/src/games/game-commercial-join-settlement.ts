import {
  BOOKED_OPERATION_V3_ADMISSION_PATH,
  BOOKED_OPERATION_V3_PREFLIGHT_PATH,
  BOOKED_OPERATION_V3_READ_PREFIX,
  BOOKED_OPERATION_V3_CANCEL_PREFIX,
} from '@phub/subscription-runtime-adapter';
import type {
  BookedOperationV3Client,
  BookedOperationV3AdmissionRequest,
  BookedOperationV3PreflightRequest,
} from '@phub/subscription-runtime-adapter';
import { createHash } from 'node:crypto';

import type { SubscriptionRuntimeActorDelegationIssuer } from '../subscriptions/subscription-runtime-actor-delegation-issuer.js';
import type {
  CommercialJoinOwnerActor,
  CommercialJoinSettlement,
  CommercialJoinSettlementOwner,
} from './game-commercial-join.js';

type ActorToken = { readonly token: string; readonly expiresAt: string };

const sha256 = (value: unknown): string =>
  'sha256:' + createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

/**
 * Source-only v3 settlement owner. It is composed only when the LK1 receiver is published and
 * the explicit v3 flag is enabled; it never creates a checkout locally.
 */
export function createBookedOperationV3SettlementOwner(options: {
  readonly client: Pick<BookedOperationV3Client, 'preflight' | 'admit' | 'read' | 'cancel'>;
  readonly issuer: Pick<SubscriptionRuntimeActorDelegationIssuer, 'issueBookedOperationV3'>;
  readonly issueActorToken: (
    actor: CommercialJoinOwnerActor,
    correlationId: string,
  ) => Promise<ActorToken>;
  readonly resolveActorContext: (actor: CommercialJoinOwnerActor) => Promise<{
    readonly providerClientId: string;
    readonly providerMappingId: string;
  }>;
  readonly resolveProviderClientSubscriptionId?: (input: {
    readonly actor: CommercialJoinOwnerActor;
    readonly subscriptionInstanceId: string;
  }) => Promise<string | undefined>;
}): CommercialJoinSettlementOwner {
  const actorTokenFor = async (
    actor: CommercialJoinOwnerActor,
    correlationId: string,
  ): Promise<ActorToken> => {
    const token = await options.issueActorToken(actor, correlationId);
    if (!token.token || Date.parse(token.expiresAt) <= Date.now())
      throw new Error('COMMERCIAL_JOIN_ACTOR_TOKEN_UNAVAILABLE');
    return token;
  };
  const providerSubscriptionFor = async (
    actor: CommercialJoinOwnerActor,
    subscriptionInstanceId: string,
  ): Promise<string | undefined> => {
    if (!options.resolveProviderClientSubscriptionId) return undefined;
    return options.resolveProviderClientSubscriptionId({ actor, subscriptionInstanceId });
  };
  const contextFor = async (actor: CommercialJoinOwnerActor) => {
    const context = await options.resolveActorContext(actor);
    if (!context.providerClientId || !context.providerMappingId)
      throw new Error('COMMERCIAL_JOIN_ACTOR_CONTEXT_UNAVAILABLE');
    return context;
  };
  return {
    async prepare(input) {
      const actorToken = await actorTokenFor(input.actor, input.correlationId);
      const context = await contextFor(input.actor);
      const providerClientSubscriptionId = await providerSubscriptionFor(
        input.actor,
        input.subscriptionInstanceId,
      );
      const request: BookedOperationV3PreflightRequest = {
        contractVersion: 3,
        action: 'JOIN_GAME',
        target: {
          kind: 'GAME',
          id: input.actor.gameId,
          expectedRevision: input.actor.expectedRevision,
        },
        paymentIntent: 'USE_SUBSCRIPTION',
      };
      const requestSha256 = sha256(request);
      const actorDelegation = await options.issuer.issueBookedOperationV3({
        scope: 'preflight',
        method: 'POST',
        path: BOOKED_OPERATION_V3_PREFLIGHT_PATH,
        operationId: input.operationId,
        tenantId: input.actor.tenantId,
        tenantKey: input.actor.tenantKey,
        userId: input.actor.userId,
        sessionId: input.actor.sessionId,
        providerClientId: context.providerClientId,
        providerMappingId: context.providerMappingId,
        correlationId: input.correlationId,
        requestSha256,
        actorToken,
        ...(providerClientSubscriptionId ? { providerClientSubscriptionId } : {}),
      });
      const result = await options.client.preflight(request, {
        actorDelegation,
        correlationId: input.correlationId,
        operationId: input.operationId,
        actorToken,
      });
      if (
        result.operationId !== input.operationId ||
        result.action !== 'JOIN_GAME' ||
        result.target.kind !== 'GAME' ||
        result.target.id !== input.actor.gameId ||
        result.target.expectedRevision !== input.actor.expectedRevision ||
        !result.quote ||
        result.quote.operationId !== input.operationId ||
        result.requestSha256 !== requestSha256 ||
        !result.settlement ||
        result.settlement.mode !== 'SURCHARGE' ||
        result.settlement.state !== 'OPEN' ||
        !result.settlement.checkoutUrl ||
        !result.settlement.expiresAt ||
        result.quote.amountMinor !== input.price.amountMinor ||
        result.quote.surchargeMinor !== result.settlement.toPayMinor
      ) {
        throw new Error('COMMERCIAL_JOIN_V3_QUOTE_INVALID');
      }
      const settlement: CommercialJoinSettlement = {
        quoteId: result.quote.quoteId,
        amountMinor: result.quote.amountMinor,
        toPayMinor: result.settlement.toPayMinor,
        checkoutUrl: result.settlement.checkoutUrl,
        expiresAt: result.settlement.expiresAt,
        requestSha256: result.requestSha256,
      };
      return settlement;
    },
    async execute(input) {
      const actorToken = await actorTokenFor(input.actor, input.correlationId);
      const context = await contextFor(input.actor);
      const providerClientSubscriptionId = await providerSubscriptionFor(
        input.actor,
        input.subscriptionInstanceId,
      );
      const request: BookedOperationV3AdmissionRequest = {
        contractVersion: 3,
        action: 'JOIN_GAME',
        target: {
          kind: 'GAME',
          id: input.actor.gameId,
          expectedRevision: input.actor.expectedRevision,
        },
        paymentIntent: 'USE_SUBSCRIPTION',
        quoteId: input.settlement.quoteId,
        settlementConsent: {
          quoteId: input.settlement.quoteId,
          amountMinor: input.settlement.toPayMinor,
          currency: 'RUB',
          expiresAt: input.settlement.expiresAt,
        },
      };
      const requestSha256 = sha256(request);
      const actorDelegation = await options.issuer.issueBookedOperationV3({
        scope: 'admit',
        method: 'POST',
        path: BOOKED_OPERATION_V3_ADMISSION_PATH,
        operationId: input.operationId,
        tenantId: input.actor.tenantId,
        tenantKey: input.actor.tenantKey,
        userId: input.actor.userId,
        sessionId: input.actor.sessionId,
        providerClientId: context.providerClientId,
        providerMappingId: context.providerMappingId,
        correlationId: input.correlationId,
        requestSha256,
        idempotencyKeySha256:
          'sha256:' + createHash('sha256').update(input.idempotencyKey, 'utf8').digest('hex'),
        actorToken,
        ...(providerClientSubscriptionId ? { providerClientSubscriptionId } : {}),
        reservationId: input.reservationId,
        quoteId: input.settlement.quoteId,
        expiresAt: input.settlement.expiresAt,
      });
      const result = await options.client.admit(request, {
        actorDelegation,
        correlationId: input.correlationId,
        operationId: input.operationId,
        actorToken,
      });
      if (
        result.operationId !== input.operationId ||
        result.quoteId !== input.settlement.quoteId ||
        result.requestSha256 !== requestSha256 ||
        result.payment.toPayMinor !== input.settlement.toPayMinor
      )
        throw new Error('COMMERCIAL_JOIN_V3_ADMISSION_MISMATCH');
      if (result.status === 'CANCELLED')
        return { status: 'REJECTED', code: 'GAME_PAYMENT_REQUIRED' };
      if (result.status === 'UNKNOWN') return { status: 'UNKNOWN' };
      if (result.payment.state === 'OPEN' && result.payment.checkoutUrl) {
        if (
          result.payment.checkoutUrl !== input.settlement.checkoutUrl ||
          result.payment.expiresAt !== input.settlement.expiresAt
        )
          throw new Error('COMMERCIAL_JOIN_V3_CHECKOUT_CHANGED');
        return { status: 'PAYMENT_REQUIRED', settlement: { ...input.settlement } };
      }
      return { status: 'PENDING' };
    },
    async read(input) {
      const actorToken = await actorTokenFor(input.actor, input.correlationId);
      const context = await contextFor(input.actor);
      const requestSha256 = sha256({
        operationId: input.operationId,
        quoteId: input.settlement.quoteId,
      });
      const actorDelegation = await options.issuer.issueBookedOperationV3({
        scope: 'read',
        method: 'GET',
        path: BOOKED_OPERATION_V3_READ_PREFIX + input.operationId,
        operationId: input.operationId,
        tenantId: input.actor.tenantId,
        tenantKey: input.actor.tenantKey,
        userId: input.actor.userId,
        sessionId: input.actor.sessionId,
        providerClientId: context.providerClientId,
        providerMappingId: context.providerMappingId,
        correlationId: input.correlationId,
        requestSha256,
        actorToken,
        quoteId: input.settlement.quoteId,
      });
      const result = await options.client.read(input.operationId, {
        actorDelegation,
        correlationId: input.correlationId,
        operationId: input.operationId,
        actorToken,
      });
      if (
        result.operationId !== input.operationId ||
        result.quoteId !== input.settlement.quoteId ||
        result.requestSha256 !== input.settlement.requestSha256 ||
        result.payment.toPayMinor !== input.settlement.toPayMinor
      )
        throw new Error('COMMERCIAL_JOIN_V3_READ_MISMATCH');
      if (result.status === 'CONFIRMED') {
        if (
          !result.receipt ||
          result.receipt.priceCharged.amountMinor !== input.settlement.toPayMinor ||
          result.receipt.priceCharged.currency !== 'RUB' ||
          result.payment.state !== 'PAID' ||
          result.payment.paidMinor < input.settlement.toPayMinor ||
          result.booking.state !== 'CONFIRMED' ||
          result.visit.state === 'UNKNOWN'
        )
          throw new Error('COMMERCIAL_JOIN_V3_RECEIPT_MISMATCH');
        return { status: 'CONFIRMED', receipt: result.receipt };
      }
      if (result.status === 'CANCELLED') {
        if (
          result.payment.state === 'PAID' ||
          result.booking.state === 'CONFIRMED' ||
          result.visit.state === 'CONSUMED' ||
          result.receipt !== null
        )
          return { status: 'UNKNOWN' };
        return { status: 'CANCELLED' };
      }
      if (result.status === 'UNKNOWN') return { status: 'UNKNOWN' };
      if (result.payment.state === 'OPEN' && result.payment.checkoutUrl) {
        if (
          result.payment.checkoutUrl !== input.settlement.checkoutUrl ||
          result.payment.expiresAt !== input.settlement.expiresAt
        )
          throw new Error('COMMERCIAL_JOIN_V3_CHECKOUT_CHANGED');
        return { status: 'PAYMENT_REQUIRED', settlement: { ...input.settlement } };
      }
      return { status: 'PENDING' };
    },
    async cancel(input) {
      const actorToken = await actorTokenFor(input.actor, input.correlationId);
      const context = await contextFor(input.actor);
      const request = {
        contractVersion: 3 as const,
        operationId: input.operationId,
        reason: 'USER_CANCEL' as const,
      };
      const requestSha256 = sha256(request);
      const actorDelegation = await options.issuer.issueBookedOperationV3({
        scope: 'cancel',
        method: 'POST',
        path: BOOKED_OPERATION_V3_CANCEL_PREFIX + input.operationId + '/cancel',
        operationId: input.operationId,
        tenantId: input.actor.tenantId,
        tenantKey: input.actor.tenantKey,
        userId: input.actor.userId,
        sessionId: input.actor.sessionId,
        providerClientId: context.providerClientId,
        providerMappingId: context.providerMappingId,
        correlationId: input.correlationId,
        requestSha256,
        actorToken,
        quoteId: input.settlement.quoteId,
      });
      const result = await options.client.cancel(request, {
        actorDelegation,
        correlationId: input.correlationId,
        operationId: input.operationId,
        actorToken,
      });
      if (result.operationId !== input.operationId)
        throw new Error('COMMERCIAL_JOIN_V3_CANCEL_MISMATCH');
      return {
        status: result.status,
        limitReleased: result.limitReleased,
        visitReturned: result.visitReturned,
      };
    },
  };
}
