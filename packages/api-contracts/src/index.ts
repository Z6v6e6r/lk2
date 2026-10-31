import type { components as InternalGeneratedComponents } from './generated-internal.js';
import type { components as UserGeneratedComponents } from './generated-user.js';

export type { components, operations, paths } from './generated-user.js';
export type {
  components as UserApiV2Components,
  operations as UserApiV2Operations,
  paths as UserApiV2Paths,
} from './generated-user-v2.js';
export type {
  components as PublicApiComponents,
  operations as PublicApiOperations,
  paths as PublicApiPaths,
} from './generated-public.js';
export type {
  components as InternalApiComponents,
  operations as InternalApiOperations,
  paths as InternalApiPaths,
} from './generated-internal.js';

export type UserGameCard = UserGeneratedComponents['schemas']['GameCardView'];
export type UserGameCommandResult = UserGeneratedComponents['schemas']['GameCommandResult'];
export type UserGameOperation = UserGeneratedComponents['schemas']['GameOperation'];
export type UserGameErrorCode = UserGeneratedComponents['schemas']['GameErrorCode'];
export type InternalGameCommand = InternalGeneratedComponents['schemas']['GameInternalCommand'];
export type InternalGameEvent = InternalGeneratedComponents['schemas']['GameDomainEvent'];

export const CURRENT_CONTRACT_VERSION = '1.12.0-stable-media-delivery' as const;

/** Public training command state is separate from fresh attendance observation. */
export interface TrainingRegistrationResult {
  readonly trainingId: string;
  readonly subscriptionId: string;
  readonly dateHint: string;
  readonly operation: {
    readonly id: string;
    readonly status:
      'PENDING' | 'UNKNOWN' | 'CONFIRMED' | 'EXPIRED_NOT_DISPATCHED' | 'REJECTED_NOT_DISPATCHED';
  };
  readonly registration: { readonly status: 'UNKNOWN' | 'CONFIRMED'; readonly asOf: string | null };
  readonly retryAfterSeconds: number | null;
}

export type {
  TournamentLocalResult,
  TournamentLocalInput,
  TournamentLocalStatus,
} from '@phub/domain';
