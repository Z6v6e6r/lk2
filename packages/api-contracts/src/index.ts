import type { components as InternalGeneratedComponents } from './generated-internal.js';
import type { components as UserGeneratedComponents } from './generated-user.js';

export type { components, operations, paths } from './generated-user.js';
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

export const CURRENT_CONTRACT_VERSION = '1.11.0-games-profile-access-policy' as const;
