import fixture from './fixtures/managed-self-leave-v1-contract.json';
import type {
  ManagedJoinReceipt,
  ManagedSelfLeaveRequest,
  ManagedSelfLeaveReceipt,
} from '@phub/domain';
import type { ManagedSelfLeaveReadOutcome } from './managed-self-leave.js';
/** Frozen synthetic owner fixture; runtime parsers are exercised by the contract test. */
export const managedSelfLeaveFixture = fixture as unknown as {
  identity: { tenantId: string; userId: string; operationId: string; idempotencyKeySha256: string };
  paths: { admission: string; read: string };
  request: ManagedSelfLeaveRequest;
  requestSha256: string;
  originalJoinReceipt: ManagedJoinReceipt;
  pending: ManagedSelfLeaveReadOutcome;
  unknown: ManagedSelfLeaveReadOutcome;
  confirmed: ManagedSelfLeaveReadOutcome & { receipt: ManagedSelfLeaveReceipt };
};
