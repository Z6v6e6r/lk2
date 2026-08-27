export class TimewebSecretProvisionError extends Error {
  readonly reason: string;
}

export type TimewebRuntimeEnvironment = Record<string, string>;

export function parseTimewebSecretEnvironment(bytes: Buffer | string): TimewebRuntimeEnvironment;

export function validateTimewebRuntimeEnvironments(
  environments: Record<'api' | 'worker' | 'realtime' | 'migrator', TimewebRuntimeEnvironment>,
  identity: { host: string; tenantKey: string },
): Record<'api' | 'worker' | 'realtime' | 'migrator', TimewebRuntimeEnvironment>;

export function provisionTimewebBetaRuntimeSecrets(options: {
  sourceDir: string;
  host: string;
  tenantKey: string;
  releaseId: string;
  expectedSourceSha: string;
  expectedSourceTree: string;
  expectedCurrentReleaseId?: string | null;
  targetDir?: string;
  backupRoot?: string;
  expectedUid?: number;
  expectedGid?: number;
  dryRun?: boolean;
  failAfter?: 'staging' | 'backup' | 'recovery' | 'install';
}): {
  schema: 'PHUB_TIMEWEB_SECRET_PROVISION_PLAN_V1';
  dryRun: boolean;
  releaseId: string;
  expectedCurrentReleaseId: string | null;
  sourceKeys: Record<string, string[]>;
  targets: Array<{ path: string; mode: '0600' }>;
  directories: Array<{ path: string; mode: '0700' }>;
  actions: string[];
  previousBackedUp?: boolean;
  backupDir?: string;
};
