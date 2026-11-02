import type { TournamentChatGateway } from '../../../web/src/TournamentChatPage.js';
import type { IOSSession } from './session.js';
export function createIOSTournamentChatGateway(session: IOSSession): TournamentChatGateway {
  return {
    tournamentChatPrincipal: () => session.tournamentChatPrincipal(),
    getTournamentChatHistory: (id, limit, cursor) =>
      session.tournamentChatHistory(id, limit, cursor),
    sendTournamentChatMessage: (id, input) => session.sendTournamentChatMessage(id, input),
    getTournamentChatRequest: (id, requestId) => session.tournamentChatStatus(id, requestId),
    getTournamentChatReadPosition: (id) => session.tournamentChatReadPosition(id),
    advanceTournamentChatRead: (id, input) => session.advanceTournamentChatRead(id, input),
    getTournamentChatReadRequest: (id, requestId) =>
      session.tournamentChatReadStatus(id, requestId),
  };
}
