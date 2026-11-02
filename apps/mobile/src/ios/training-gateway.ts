import type { TrainingsPageProps } from '../../../web/src/TrainingsPage.js';
import { createIOSQuarterGateway } from './quarter-gateway.js';
import type { IOSSession } from './session.js';
export function createIOSTrainingGateway(session: IOSSession): TrainingsPageProps['gateway'] {
  return {
    getHomeDashboard: createIOSQuarterGateway(session).getHomeDashboard,
    listEventCatalog: (query) => session.trainingCatalogue(query),
    continueEventCatalog: (cursor, limit) => session.continueTrainingCatalogue(cursor, limit),
    registerTraining: (id, input, key) => session.registerTraining(id, input, key),
    getTrainingRegistration: (id, key) => session.getTrainingRegistration(id, key),
  };
}
