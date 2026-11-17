export interface MountLeaks {
  readonly count: number;
  readonly sameRoot: boolean;
}

export interface PlanInput {
  readonly mount: MountLeaks;
  readonly pin: string;
  readonly artifactPresent: boolean;
  readonly artifactDigestMismatch: boolean;
  readonly backupPresent: boolean;
  readonly backupFresh: boolean;
  readonly backupExpired: boolean;
  readonly lockPresent: boolean;
}

export interface PlanResult {
  readonly verdict: 'GO' | 'NO-GO';
  readonly blockers: string[];
}

export interface PinInput {
  readonly controllerSha: string;
  readonly candidateSha: string;
  readonly headSha: string;
  readonly configSha: string;
  readonly clean: boolean;
}

export interface BaselineContainer {
  readonly id: string;
  readonly image: string;
  readonly releaseId: string | null;
}

export interface V5BuildInput {
  readonly template: Record<string, unknown>;
  readonly baseline: { readonly containers: Record<string, BaselineContainer> };
  readonly backupOperationSha256: string;
  readonly candidateSha: string;
  readonly candidateTree: string;
  readonly publicationRunId: string | number;
  readonly artifactId: string | number;
  readonly sourceCiRunId?: string | number;
  readonly artifactDigest: string;
  readonly manifestSha256: string;
  readonly expiresAt: string;
  readonly legacyBaselineHash: (baseline: unknown) => string;
  readonly ownerDirectedScopeSha256: (operation: unknown) => string;
}

export declare const ROOT: string;
export declare const SOURCE: string;
export declare const CONFIG: string;
export declare const TOOLS: string;
export declare const V5_REQUEST: string;
export declare const BACKUP_REQUEST: string;
export declare const LOCK: string;
export declare const CONFIRMATION_PREFIX: string;

export declare function sha256(value: Buffer | string): string;
export declare function hashFile(path: string): string;
export declare function readJson(path: string): Record<string, any>;
export declare function releaseId(sha: string, runId: string | number): string;
export declare function toolDir(sha: string): string;
export declare function confirmationFor(candidateSha: string, baselineHash: string): string;
export declare function pinVerdict(input: PinInput): string;
export declare function mountLeaks(mountInfo: string, backupsPath: string): MountLeaks;
export declare function planVerdict(input: PlanInput): PlanResult;
export interface V5Operation {
  readonly candidateSha: string;
  readonly candidateTree: string;
  readonly controllerSha: string;
  readonly publicationRunId: string;
  readonly sourceCiRunId: string;
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly manifestSha256: string;
  readonly backupOperationSha256: string;
  readonly expiresAt: string;
  readonly confirmation: string;
  readonly expectedApi: BaselineContainer;
  readonly expectedWeb: BaselineContainer;
  readonly expectedWorker: BaselineContainer;
  readonly ownerDecisions: Record<
    string,
    { readonly scopeSha256?: string; readonly status?: string }
  >;
  readonly canonicalBaseline: unknown;
}

export declare function buildV5Request(input: V5BuildInput): V5Operation;
export declare function mountCheck(backupsPath?: string): MountLeaks;
export declare function commandApply(
  input: { readonly sha: string; readonly confirmation: string },
  env?: Record<string, unknown>,
): Record<string, any>;
export declare function commandPrepareFull(input: {
  readonly sha: string;
  readonly run: string;
  readonly artifact: string;
  readonly artifactId: string;
  readonly sourceCiRunId: string;
}): Promise<Record<string, any>>;
