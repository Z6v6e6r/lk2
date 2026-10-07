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
  return {
    async resolveSelection(actor, signal) {
      if (signal.aborted) return null;
      const context = await options.contextRepository.resolve(actor, signal);
      if (!context || context.revision !== actor.expectedRevision || signal.aborted) return null;
      const accessToken = await options.getAccessToken({
        ...actor,
        tenantKey: actor.tenantKey,
        correlationId: actor.correlationId,
      });
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
