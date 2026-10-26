export interface ApiWorkerFrozenPin {
  readonly path: string;
  readonly status: string;
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldOid: string;
  readonly newOid: string;
}

export const API_WORKER_MIGRATION_CONTROLLER_FILES: ReadonlySet<string>;
export const LOCATION_PHOTO_CONTROLLER_EXTRA_FILES: ReadonlySet<string>;
export const API_WORKER_CI_DOWNLOAD_PATCH: readonly Readonly<ApiWorkerFrozenPin>[];
export const API_WORKER_CI_READER_PATCH: readonly Readonly<ApiWorkerFrozenPin>[];
export const API_WORKER_CONTROLLER_PROMOTION_PATCH: readonly Readonly<ApiWorkerFrozenPin>[];
export const API_WORKER_ANDROID_CHAT_TEST_PATCH: readonly Readonly<ApiWorkerFrozenPin>[];
export const API_WORKER_REHEARSAL_READINESS_PATCH: readonly Readonly<ApiWorkerFrozenPin>[];
export const API_WORKER_NATIVE_BOOKINGS_PATCH: readonly Readonly<ApiWorkerFrozenPin>[];

export function assertPlan(plan: unknown, operation: unknown, operationBytes: Buffer): void;
export function validateApiWorkerOperation(operation: unknown, now?: number): unknown;
