export const GAME_PROVIDER_OPERATION_STATES = [
  'READY',
  'SUBMITTING',
  'UNKNOWN',
  'RECONCILING',
  'CONFIRMED',
  'REJECTED',
  'MANUAL_REVIEW',
] as const;

export type GameProviderOperationState = (typeof GAME_PROVIDER_OPERATION_STATES)[number];

export const GAME_PROVIDER_OPERATION_ACTIONS = ['JOIN_PAYMENT', 'PROMOTION_PAYMENT'] as const;
export type GameProviderOperationAction = (typeof GAME_PROVIDER_OPERATION_ACTIONS)[number];

export type GameProviderErrorClass =
  | 'TRANSIENT'
  | 'NOT_SENT'
  | 'AMBIGUOUS_EGRESS'
  | 'PROVIDER_REJECTED'
  | 'ACTOR_MISMATCH'
  | 'TENANT_MISMATCH'
  | 'GAME_MISMATCH'
  | 'PAYMENT_MISMATCH'
  | 'REFERENCE_MISMATCH'
  | 'AMBIGUOUS_READBACK'
  | 'READBACK_UNAVAILABLE'
  | 'RETRY_EXHAUSTED';

export interface GameProviderExpectedFacts {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly gameId: string;
  readonly reservationId: string;
  readonly paymentMode: 'SPLIT' | 'SUBSCRIPTION';
  readonly providerExerciseId?: string;
  readonly amountMinor?: number;
  readonly currency?: string;
}

export interface GameProviderObservedFacts {
  readonly providerContractVersion: 'synthetic-v1';
  readonly terminalStatus: 'PAID' | 'REJECTED';
  readonly tenantRef: string;
  readonly actorRef: string;
  readonly gameRef: string;
  readonly reservationRef: string;
  readonly paymentMode: 'SPLIT' | 'SUBSCRIPTION';
  readonly providerExerciseRef?: string;
  readonly amountMinor?: number;
  readonly currency?: string;
}

export interface GameProviderOperationIntent {
  readonly operationId: string;
  readonly provider: 'SYNTHETIC';
  readonly action: GameProviderOperationAction;
  readonly providerIdempotencyKey: string;
  readonly correlationId: string;
  readonly expected: GameProviderExpectedFacts;
}

export type GameProviderSubmitResult =
  | {
      readonly outcome: 'ACCEPTED';
      readonly providerOperationId: string;
      readonly evidenceHash: string;
    }
  | { readonly outcome: 'REJECTED'; readonly code: string; readonly evidenceHash: string }
  | { readonly outcome: 'NOT_SENT'; readonly retryable: boolean; readonly code: string }
  | { readonly outcome: 'UNKNOWN'; readonly code: string };

export type GameProviderReadBackResult =
  | {
      readonly outcome: 'MATCHED_ACCEPTED' | 'MATCHED_REJECTED';
      readonly providerOperationId: string;
      readonly evidenceHash: string;
      readonly facts: GameProviderObservedFacts;
    }
  | {
      readonly outcome: 'NOT_FOUND';
      readonly authoritative: boolean;
      readonly evidenceHash: string;
    }
  | {
      readonly outcome: 'MISMATCH';
      readonly mismatch: Exclude<
        GameProviderErrorClass,
        | 'TRANSIENT'
        | 'NOT_SENT'
        | 'AMBIGUOUS_EGRESS'
        | 'PROVIDER_REJECTED'
        | 'AMBIGUOUS_READBACK'
        | 'READBACK_UNAVAILABLE'
        | 'RETRY_EXHAUSTED'
      >;
      readonly evidenceHash: string;
    }
  | { readonly outcome: 'AMBIGUOUS'; readonly evidenceHash: string }
  | { readonly outcome: 'UNAVAILABLE'; readonly code: string };

export interface GameProviderRecoveryAdapter {
  submit(
    intent: GameProviderOperationIntent,
    context: { readonly signal: AbortSignal; readonly timeoutMs: number },
  ): Promise<GameProviderSubmitResult>;
  readBack(
    intent: GameProviderOperationIntent,
    context: { readonly signal: AbortSignal; readonly timeoutMs: number },
  ): Promise<GameProviderReadBackResult>;
}

const ALLOWED_TRANSITIONS: Readonly<
  Record<GameProviderOperationState, readonly GameProviderOperationState[]>
> = {
  READY: ['SUBMITTING'],
  SUBMITTING: ['READY', 'UNKNOWN', 'REJECTED', 'MANUAL_REVIEW'],
  UNKNOWN: ['RECONCILING', 'CONFIRMED', 'REJECTED', 'MANUAL_REVIEW'],
  RECONCILING: ['UNKNOWN', 'CONFIRMED', 'REJECTED', 'MANUAL_REVIEW'],
  CONFIRMED: [],
  REJECTED: [],
  MANUAL_REVIEW: [],
};

export function canTransitionGameProviderOperation(
  from: GameProviderOperationState,
  to: GameProviderOperationState,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertGameProviderOperationTransition(
  from: GameProviderOperationState,
  to: GameProviderOperationState,
): void {
  if (!canTransitionGameProviderOperation(from, to)) {
    throw new Error(`GAME_PROVIDER_OPERATION_TRANSITION_INVALID:${from}:${to}`);
  }
}

export function submitTransition(result: GameProviderSubmitResult): {
  readonly state: 'READY' | 'UNKNOWN' | 'REJECTED' | 'MANUAL_REVIEW';
  readonly errorClass?: GameProviderErrorClass;
} {
  switch (result.outcome) {
    case 'ACCEPTED':
      // A synchronous acknowledgement is not authoritative payment truth. Even the
      // synthetic contract must converge through the fact-checked read-back path.
      return { state: 'UNKNOWN' };
    case 'REJECTED':
      return { state: 'REJECTED', errorClass: 'PROVIDER_REJECTED' };
    case 'NOT_SENT':
      return result.retryable
        ? { state: 'READY', errorClass: 'NOT_SENT' }
        : { state: 'MANUAL_REVIEW', errorClass: 'NOT_SENT' };
    case 'UNKNOWN':
      return { state: 'UNKNOWN', errorClass: 'AMBIGUOUS_EGRESS' };
  }
}

export function readBackTransition(
  result: GameProviderReadBackResult,
  attempts: number,
  maxAttempts: number,
): {
  readonly state: 'UNKNOWN' | 'CONFIRMED' | 'REJECTED' | 'MANUAL_REVIEW';
  readonly errorClass?: GameProviderErrorClass;
} {
  if (result.outcome === 'MATCHED_ACCEPTED') return { state: 'CONFIRMED' };
  if (result.outcome === 'MATCHED_REJECTED') {
    return { state: 'REJECTED', errorClass: 'PROVIDER_REJECTED' };
  }
  const exhausted = attempts >= maxAttempts;
  if (result.outcome === 'MISMATCH') {
    return { state: exhausted ? 'MANUAL_REVIEW' : 'UNKNOWN', errorClass: result.mismatch };
  }
  if (result.outcome === 'AMBIGUOUS') {
    return {
      state: exhausted ? 'MANUAL_REVIEW' : 'UNKNOWN',
      errorClass: exhausted ? 'RETRY_EXHAUSTED' : 'AMBIGUOUS_READBACK',
    };
  }
  if (result.outcome === 'UNAVAILABLE') {
    return {
      state: exhausted ? 'MANUAL_REVIEW' : 'UNKNOWN',
      errorClass: exhausted ? 'RETRY_EXHAUSTED' : 'READBACK_UNAVAILABLE',
    };
  }
  return {
    state: exhausted ? 'MANUAL_REVIEW' : 'UNKNOWN',
    errorClass: exhausted ? 'RETRY_EXHAUSTED' : 'AMBIGUOUS_READBACK',
  };
}

export type SyntheticSubmitBehavior =
  'ACCEPT' | 'REJECT' | 'TIMEOUT_BEFORE_ACCEPT' | 'TIMEOUT_AFTER_ACCEPT';

export interface SyntheticGameProviderStore {
  readonly acceptedByIdempotencyKey: Map<string, GameProviderOperationIntent>;
  mutationCount: number;
}

export function createSyntheticGameProviderStore(): SyntheticGameProviderStore {
  return { acceptedByIdempotencyKey: new Map(), mutationCount: 0 };
}

/** Deterministic test-only provider. It never performs network or live provider I/O. */
export function createSyntheticGameProviderAdapter(input: {
  readonly submitBehavior: SyntheticSubmitBehavior;
  readonly readBackBehavior?: 'STORED' | 'NOT_FOUND' | 'AMBIGUOUS' | 'UNAVAILABLE' | 'MISMATCH';
  readonly store?: SyntheticGameProviderStore;
}): GameProviderRecoveryAdapter & { readonly mutationCount: () => number } {
  const store = input.store ?? createSyntheticGameProviderStore();
  return {
    mutationCount: () => store.mutationCount,
    async submit(intent) {
      await Promise.resolve();
      const stored = store.acceptedByIdempotencyKey.get(intent.providerIdempotencyKey);
      if (stored) {
        return {
          outcome: 'ACCEPTED',
          providerOperationId: `synthetic:${stored.operationId}`,
          evidenceHash: `accepted:${stored.operationId}`,
        };
      }
      if (input.submitBehavior === 'REJECT') {
        return {
          outcome: 'REJECTED',
          code: 'SYNTHETIC_REJECTED',
          evidenceHash: `rejected:${intent.operationId}`,
        };
      }
      if (input.submitBehavior === 'TIMEOUT_BEFORE_ACCEPT') {
        return { outcome: 'NOT_SENT', retryable: true, code: 'SYNTHETIC_NOT_SENT' };
      }
      store.mutationCount += 1;
      store.acceptedByIdempotencyKey.set(intent.providerIdempotencyKey, intent);
      if (input.submitBehavior === 'TIMEOUT_AFTER_ACCEPT') {
        return { outcome: 'UNKNOWN', code: 'SYNTHETIC_TIMEOUT_AFTER_ACCEPT' };
      }
      return {
        outcome: 'ACCEPTED',
        providerOperationId: `synthetic:${intent.operationId}`,
        evidenceHash: `accepted:${intent.operationId}`,
      };
    },
    async readBack(intent) {
      await Promise.resolve();
      const behavior = input.readBackBehavior ?? 'STORED';
      if (behavior === 'UNAVAILABLE')
        return { outcome: 'UNAVAILABLE', code: 'SYNTHETIC_UNAVAILABLE' };
      if (behavior === 'AMBIGUOUS')
        return { outcome: 'AMBIGUOUS', evidenceHash: `ambiguous:${intent.operationId}` };
      if (behavior === 'MISMATCH')
        return {
          outcome: 'MISMATCH',
          mismatch: 'ACTOR_MISMATCH',
          evidenceHash: `mismatch:${intent.operationId}`,
        };
      const stored = store.acceptedByIdempotencyKey.get(intent.providerIdempotencyKey);
      if (!stored || behavior === 'NOT_FOUND') {
        return {
          outcome: 'NOT_FOUND',
          authoritative: true,
          evidenceHash: `missing:${intent.operationId}`,
        };
      }
      return {
        outcome: 'MATCHED_ACCEPTED',
        providerOperationId: `synthetic:${stored.operationId}`,
        evidenceHash: `accepted:${stored.operationId}`,
        facts: {
          providerContractVersion: 'synthetic-v1',
          terminalStatus: 'PAID',
          tenantRef: `synthetic:tenant:${stored.expected.tenantId}`,
          actorRef: `synthetic:actor:${stored.expected.actorUserId}`,
          gameRef: `synthetic:game:${stored.expected.gameId}`,
          reservationRef: `synthetic:reservation:${stored.expected.reservationId}`,
          paymentMode: stored.expected.paymentMode,
          ...(stored.expected.providerExerciseId
            ? { providerExerciseRef: `synthetic:exercise:${stored.expected.providerExerciseId}` }
            : {}),
          ...(stored.expected.amountMinor === undefined
            ? {}
            : {
                amountMinor: stored.expected.amountMinor,
                currency: stored.expected.currency,
              }),
        },
      };
    },
  };
}
