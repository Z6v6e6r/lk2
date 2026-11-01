import type { AuthGateway } from '../../../web/src/auth-gateway.js';
import type { QuarterCreateGateway } from '../../../web/src/quarter-create-attempt.js';
import type { IOSSession } from './session.js';
export function createIOSQuarterGateway(
  session: IOSSession,
): QuarterCreateGateway & Pick<AuthGateway, 'getHomeDashboard'> {
  return {
    quarterCreatePrincipal: () => session.quarterCreatePrincipal(),
    getQuarterCreateLocations: () => session.quarterCall((api) => api.getQuarterCreateLocations()),
    getQuarterCreateCapability: () =>
      session.quarterCall((api) => api.getQuarterCreateCapability()),
    createQuarterGame: (input, key) =>
      session.quarterCall((api) => api.createQuarterGame(input, key)),
    getQuarterCreateOperation: (key) =>
      session.quarterCall((api) => api.getQuarterCreateOperation(key)),
    reconcileQuarterCreateOperation: (id, input, key) =>
      session.quarterCall((api) => api.reconcileQuarterCreateOperation(id, input, key)),
    getHomeDashboard: () =>
      session.quarterCall(async (api) => {
        const value = await api.getHomeDashboard();
        const state = session.getSnapshot();
        if (state.status !== 'signed-in' || value.profile.userId !== state.session.context.userId)
          throw new Error('NATIVE_ACCOUNT_MISMATCH');
        return value;
      }),
  };
}
