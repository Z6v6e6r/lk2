import type {
  ClosedAdditiveOperation,
  ClosedAdditiveProfile,
} from './timeweb-api-worker-migration.js';
import type {
  ClosedApplicationAclProfile,
  ClosedApplicationAclRow,
} from './closed-application-migration-acl.js';
export type ClosedApplicationKind = ClosedApplicationAclProfile;
export interface ClosedRuntimeIdentity {
  readonly id: string;
  readonly image: string;
  readonly imageId: string;
  readonly releaseId: string | null;
  readonly revision: string | null;
  readonly restarts: number;
  readonly startedAt: string;
}
export interface ClosedApplicationOperation extends ClosedAdditiveOperation {
  readonly schema: string;
  readonly profile: 'beta';
  readonly migrationProfile: ClosedApplicationKind;
  readonly target: {
    readonly hostname: 'lk2.padlhub.su';
    readonly serverId: 8886471;
    readonly projectId: 262717;
  };
  readonly expectedDatabaseTarget: {
    readonly databaseName: 'phub_beta';
    readonly systemIdentifier: '7679125609183186977';
  };
  readonly catalogVariant: 'DORMANT' | 'SCENARIO_EDITOR_V1';
  readonly publishedMigrator: {
    readonly sourceSha: string;
    readonly sourceTree: string;
    readonly publicationRunId: string;
    readonly publicationRunAttempt: 1;
    readonly manifestSha256: string;
    readonly image: string;
    readonly imageId: string;
  };
  readonly packageDescriptorSha256: string;
  readonly catalogBuilderSha256: string;
  readonly expectedPrivilegePreimage: readonly ClosedApplicationAclRow[];
  readonly aclPreimageSha256: string;
  readonly bootstrapSha256: string;
  readonly cleanupSha256: string;
  readonly expectedApi: ClosedRuntimeIdentity;
  readonly expectedWorker: ClosedRuntimeIdentity;
  readonly expectedPostgres: ClosedRuntimeIdentity;
  readonly expectedSecretSetFiles: Readonly<Record<string, string>>;
  readonly previousMigrationSuccess: null | {
    readonly path: string;
    readonly sha256: string;
    readonly operationSha256: string;
  };
  readonly confirmation: string;
}
export const CLOSED_APPLICATION_HOST_TARGET: ClosedApplicationOperation['target'];
export const CLOSED_APPLICATION_DATABASE_TARGET: ClosedApplicationOperation['expectedDatabaseTarget'];
export const CLOSED_APPLICATION_OPERATION_SCHEMAS: Readonly<Record<ClosedApplicationKind, string>>;
export const CLOSED_APPLICATION_STAGE: Readonly<
  Record<
    ClosedApplicationKind,
    { prefix: string; slug: string; backupMode: string; argument: string }
  >
>;
export function closedApplicationSchemas(
  profile: ClosedApplicationKind,
): ClosedAdditiveProfile['schemas'];
export function validateClosedRuntimeIdentity(
  value: unknown,
  service: string,
): ClosedRuntimeIdentity;
export function closedApplicationInputDigests(
  operation: ClosedApplicationOperation,
): Readonly<Record<string, string>>;
export function validateClosedApplicationOperation(
  value: unknown,
  at?: number,
): ClosedApplicationOperation;
export function validateClosedApplicationLedger(
  profile: ClosedApplicationKind,
  rows: unknown,
  phase: string,
): string;
export function closedApplicationCommand(
  operation: ClosedApplicationOperation,
  containerKind: string,
): string[];
export function validateClosedApplicationCatalog(
  operation: ClosedApplicationOperation,
  rows: unknown,
  count: number,
): void;
export function closedApplicationCatalogSql(): string;
export function validateClosedApplicationManifest(
  operation: ClosedApplicationOperation,
  manifest: unknown,
  bytes: Buffer,
): unknown;
export function closedApplicationRoleProbeSource(profile: ClosedApplicationKind): string;
export function validateClosedApplicationRoleReadback(
  operation: ClosedApplicationOperation,
  value: unknown,
  phase: string,
  target?: ClosedApplicationOperation['expectedDatabaseTarget'],
): unknown;
export function closedApplicationStateSql(profile: ClosedApplicationKind, phase: string): string;
export function validateClosedApplicationState(
  operation: ClosedApplicationOperation,
  value: unknown,
  phase: string,
): { readonly target: ClosedApplicationOperation['expectedDatabaseTarget'] };
export function validateClosedApplicationPlan(value: unknown, bytes: Buffer): unknown;
export function validateClosedApplicationReceipt(
  profile: ClosedApplicationKind,
  value: unknown,
  planSha: string,
  operationSha: string,
): unknown;
export function createClosedApplicationKernelProfile(
  operation: ClosedApplicationOperation,
): ClosedAdditiveProfile;
export function assertClosedApplicationRuntimeOff(
  operation: ClosedApplicationOperation,
  environments: { api: Buffer | readonly string[]; worker: Buffer | readonly string[] },
  git?: (args: string[]) => string,
): true;

export const CLOSED_APPLICATION_POSTGRES_CONTAINER: string;
