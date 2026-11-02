import type { AuthGateway } from '../../../web/src/auth-gateway.js';
import type { IOSSession } from './session.js';

/** One existing IOSSession/SDK. Never creates a browser session or changes the owner. */
export function createIOSTournamentGateway(
  session: IOSSession,
): Pick<
  AuthGateway,
  | 'tournamentPrincipal'
  | 'listPublicTournamentSummaries'
  | 'getPublicTournamentSummary'
  | 'getTournamentParticipants'
  | 'commandTournament'
  | 'retryTournament'
  | 'getTournamentRegistration'
> {
  return {
    tournamentPrincipal: () => session.tournamentPrincipal(),
    listPublicTournamentSummaries: (input) =>
      session.tournamentCall((api) => api.listPublicTournamentSummaries(input)),
    getPublicTournamentSummary: (id, range) =>
      session.tournamentCall((api) => api.getPublicTournamentSummary(id, range)),
    getTournamentParticipants: (id) =>
      session.tournamentCall((api) => api.getTournamentParticipants(id)),
    commandTournament: (id, input, key) =>
      session.tournamentCall((api) => api.commandTournament(id, input, key)),
    retryTournament: (id, operation, key) =>
      session.tournamentCall((api) => api.retryTournament(id, operation, key)),
    getTournamentRegistration: (id, selector) =>
      session.tournamentCall((api) => api.getTournamentRegistration(id, selector)),
  };
}
