import { randomUUID } from 'node:crypto';

import type {
  ProviderAccountAttestation,
  ProviderAccountAttestationRequest,
} from '../../../../packages/subscription-runtime-adapter/src/provider-account-attestation.js';

/** ADR 0028: replaces the server Viva read (403 from lk2 egress) with an LK1 owner attestation. */
export class Lk1OwnedSubscriptionError extends Error {
  constructor(
    public readonly code:
      | 'JOIN_SELECTION_TARGET_UNAVAILABLE'
      | 'JOIN_SELECTION_FOREIGN_ACTOR'
      | 'JOIN_SELECTION_SUBSCRIPTION_NOT_OWNED'
      | 'JOIN_SELECTION_TARGET_MISMATCH',
  ) {
    super(code);
  }
}

export function createLk1OwnedSubscriptionReader(options: {
  readonly issuer: {
    issueProviderAccountAttestation(input: {
      readonly userId: string;
      readonly tenantId: string;
      readonly tenantKey: string;
      readonly sessionId: string;
      readonly correlationId: string;
      readonly request: ProviderAccountAttestationRequest;
      readonly actorToken: string;
      readonly actorTokenExpiresAt: string;
    }): Promise<string>;
  };
  readonly client: {
    attest(
      request: ProviderAccountAttestationRequest,
      envelope: {
        readonly actorDelegation: string;
        readonly actorToken: { readonly token: string; readonly expiresAt: string };
        readonly correlationId: string;
      },
    ): Promise<ProviderAccountAttestation>;
  };
}) {
  return async (input: {
    readonly accessToken: string;
    readonly accessTokenExpiresAt: string;
    readonly actor: {
      readonly tenantId: string;
      readonly userId: string;
      readonly sessionId: string;
      readonly tenantKey: string;
    };
    readonly providerExerciseId: string | null;
    readonly providerClientId: string;
    readonly providerSubscriptionId: string;
    readonly startsAt: string;
    readonly durationMinutes: 60 | 90;
    readonly signal: AbortSignal;
    readonly correlationId: string;
  }): Promise<{ readonly fingerprint: string }> => {
    if (!input.providerExerciseId)
      throw new Lk1OwnedSubscriptionError('JOIN_SELECTION_TARGET_UNAVAILABLE');
    const request: ProviderAccountAttestationRequest = {
      contractVersion: 1,
      operationId: randomUUID(),
      target: { exerciseId: input.providerExerciseId },
    };
    const actorDelegation = await options.issuer.issueProviderAccountAttestation({
      ...input.actor,
      correlationId: input.correlationId,
      request,
      actorToken: input.accessToken,
      actorTokenExpiresAt: input.accessTokenExpiresAt,
    });
    const result = await options.client.attest(request, {
      actorDelegation,
      actorToken: { token: input.accessToken, expiresAt: input.accessTokenExpiresAt },
      correlationId: input.correlationId,
    });
    if (result.providerClientId.toLowerCase() !== input.providerClientId.toLowerCase())
      throw new Lk1OwnedSubscriptionError('JOIN_SELECTION_FOREIGN_ACTOR');
    const proof = result.targetProof;
    if (
      !proof ||
      Date.parse(proof.startsAt) !== Date.parse(input.startsAt) ||
      proof.durationMinutes !== input.durationMinutes
    )
      throw new Lk1OwnedSubscriptionError('JOIN_SELECTION_TARGET_MISMATCH');
    const owned = new Set(proof.ownedClientSubscriptionIds.map((id) => id.toLowerCase()));
    if (!owned.has(input.providerSubscriptionId.toLowerCase()))
      throw new Lk1OwnedSubscriptionError('JOIN_SELECTION_SUBSCRIPTION_NOT_OWNED');
    return { fingerprint: `lk1-attest:${result.operationId}:${result.attestedAt}` };
  };
}
