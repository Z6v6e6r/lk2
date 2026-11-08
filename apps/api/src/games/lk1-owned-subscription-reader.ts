import { createHash, randomUUID } from 'node:crypto';

import {
  PROVIDER_ACCOUNT_TENANT_KEY,
  type ProviderAccountAttestation,
  type ProviderAccountAttestationRequest,
} from '../../../../packages/subscription-runtime-adapter/src/provider-account-attestation.js';

/** ADR 0028: replaces the server Viva read (403 from lk2 egress) with an LK1 owner attestation. */
export class Lk1OwnedSubscriptionError extends Error {
  constructor(
    public readonly code:
      | 'JOIN_SELECTION_TARGET_UNAVAILABLE'
      | 'JOIN_SELECTION_FOREIGN_ACTOR'
      | 'JOIN_SELECTION_SUBSCRIPTION_NOT_OWNED'
      | 'JOIN_SELECTION_TARGET_MISMATCH'
      | 'JOIN_SELECTION_VARIANT_UNAVAILABLE',
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
      tenantId: input.actor.tenantId,
      userId: input.actor.userId,
      sessionId: input.actor.sessionId,
      // The delegation names the Viva provider tenant, not the PadlHub route tenant key.
      tenantKey: PROVIDER_ACCOUNT_TENANT_KEY,
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
    const selected = input.providerSubscriptionId.toLowerCase();
    const owned = new Set(proof.ownedClientSubscriptionIds.map((id) => id.toLowerCase()));
    if (!owned.has(selected))
      throw new Lk1OwnedSubscriptionError('JOIN_SELECTION_SUBSCRIPTION_NOT_OWNED');
    if (!proof.eligibleClientSubscriptionIds.some((id) => id.toLowerCase() === selected))
      throw new Lk1OwnedSubscriptionError('JOIN_SELECTION_VARIANT_UNAVAILABLE');
    // Deterministic over the attested facts: join conditions resolve the selection twice and
    // require an identical sourceVersion; a per-call operation id would never match.
    return {
      fingerprint: createHash('sha256')
        .update(
          JSON.stringify([
            'lk1-attest:v1',
            result.providerClientId.toLowerCase(),
            proof.exerciseId,
            Date.parse(proof.startsAt),
            proof.durationMinutes,
            selected,
          ]),
        )
        .digest('hex'),
    };
  };
}
