import type { GameJoinConditionsContextInput, GameJoinConditionsContext } from '@phub/database';
import type { GameJoinConditionsOwner } from './game-join-conditions.js';

/** Production resolver: integration aliases locate keys; the user-scoped owner read proves ownership. */
export function createGameJoinConditionsOwner(options: {
  readonly contextRepository: {
    resolve(
      input: GameJoinConditionsContextInput,
      signal?: AbortSignal,
    ): Promise<GameJoinConditionsContext | null>;
  };
  readonly getAccessToken: (input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly sessionId: string;
    readonly tenantKey: string;
    readonly correlationId: string;
  }) => Promise<string>;
  readonly readOwnedSubscription: (input: {
    readonly accessToken: string;
    readonly providerClientId: string;
    readonly providerSubscriptionId: string;
    readonly startsAt: string;
    readonly signal: AbortSignal;
    readonly correlationId: string;
  }) => Promise<{ readonly fingerprint: string }>;
  readonly readPreview: GameJoinConditionsOwner['readPreview'];
  readonly providerMode: 'MOCK' | 'LIVE';
}): GameJoinConditionsOwner {
  const requestTokens = new WeakMap<AbortSignal, { actorKey: string; token: Promise<string> }>();
  return {
    async resolveSelection(actor, signal) {
      if (signal.aborted) return null;
      const context = await options.contextRepository.resolve(actor, signal);
      if (!context || context.revision !== actor.expectedRevision || signal.aborted) return null;
      const actorKey = JSON.stringify([
        actor.tenantId,
        actor.tenantKey,
        actor.userId,
        actor.sessionId,
      ]);
      let requestToken = requestTokens.get(signal);
      if (requestToken && requestToken.actorKey !== actorKey) {
        throw new Error('JOIN_SELECTION_ACTOR_CHANGED');
      }
      if (!requestToken) {
        requestToken = {
          actorKey,
          token: options.getAccessToken({
            tenantId: actor.tenantId,
            userId: actor.userId,
            sessionId: actor.sessionId,
            tenantKey: actor.tenantKey,
            correlationId: actor.correlationId,
          }),
        };
        requestTokens.set(signal, requestToken);
      }
      const accessToken = await requestToken.token;
      if (signal.aborted) return null;
      const proof = await options.readOwnedSubscription({
        accessToken,
        providerClientId: context.providerClientId,
        providerSubscriptionId: context.providerSubscriptionId,
        startsAt: context.startsAt,
        signal,
        correlationId: actor.correlationId,
      });
      if (signal.aborted) return null;
      return {
        ...actor,
        ...context,
        sourceVersion: context.sourceVersion + ':' + proof.fingerprint,
        legacySubscriptionId: context.providerSubscriptionId,
        authorization: `Bearer ${accessToken}`,
        providerMode: options.providerMode,
      };
    },
    readPreview: options.readPreview,
  };
}
