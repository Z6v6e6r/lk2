import type { EventEmitter } from 'node:events';
import type { PassThrough } from 'node:stream';
export const API_WORKER_BRIDGE: Readonly<
  Record<
    | 'candidateSha'
    | 'candidateTree'
    | 'sourceCiRunId'
    | 'publicationRunId'
    | 'artifactId'
    | 'artifactDigest'
    | 'manifestSha256'
    | 'apiSource'
    | 'apiRelease'
    | 'apiDigest'
    | 'workerSource'
    | 'workerDigest'
    | 'candidateApiDigest'
    | 'candidateWorkerDigest'
    | 'ledgerSha256'
    | 'postgresId'
    | 'postgresImage',
    string
  >
>;
export interface ApiWorkerControllerDiffEntry {
  path: string;
  status: string;
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
}
export const API_WORKER_CI_DOWNLOAD_PATCH: readonly Readonly<ApiWorkerControllerDiffEntry>[];
export const API_WORKER_CI_READER_PATCH: readonly Readonly<ApiWorkerControllerDiffEntry>[];
export function parseApiWorkerControllerDiff(raw: string): ApiWorkerControllerDiffEntry[];
export function validateApiWorkerOperation(op: unknown, now?: number): unknown;
export function validateApiWorkerControllerDelta(entries: unknown): void;
export function validateApiWorkerLedger(applied: unknown, packaged: unknown): void;
export function validateApiWorkerBackupLedger(receipt: unknown, packaged: unknown): void;
export function validateApiWorkerReceipt(receipt: unknown, planSha256: string): unknown;
export function validateApiWorkerDatabase(
  value: unknown,
  packaged: unknown,
  initial?: unknown,
): unknown;
export function apiWorkerComposeArgs(
  baseline: string,
  overlay: string,
  action: string,
  service: string,
): string[];
export function apiWorkerSmokeArgs(service: string, image: string): string[];
export function overlay(plan: unknown, side: string, service: string): string;
export function validateApiWorkerMount(mounts: unknown, source?: string): void;
export function encodeApiWorkerCapsule(operationBytes: Buffer, planBytes: Buffer): string;
export function readApiWorkerCapsule(bytes: Buffer): {
  operationBytes: Buffer;
  planBytes: Buffer;
  op: unknown;
  plan: unknown;
};
export interface ApiWorkerTransitionOps {
  preflight(): Promise<void>;
  pullAndSmoke(): Promise<void>;
  journal(phase: string): Promise<void>;
  containWorker(): Promise<void>;
  installSecrets(): Promise<void>;
  activate(service: string): Promise<void>;
  observe(): Promise<void>;
  attestCandidate(): Promise<void>;
  installBaseline(): Promise<void>;
  releaseFence(): Promise<void>;
  restoreSecrets(): Promise<void>;
  restore(service: string): Promise<void>;
  removeCandidateBaseline(): Promise<void>;
  attestPrevious(): Promise<void>;
}
export function runApiWorkerTransition(ops: ApiWorkerTransitionOps): Promise<void>;
export function recoverApiWorkerPhase(phase: string, ops: ApiWorkerTransitionOps): Promise<string>;
export const API_WORKER_GATE_LOCK_SQL: string;
export const API_WORKER_DATABASE_SQL: string;
export function openApiWorkerDatabaseFence(
  container: string,
  spawnChild?: (...args: unknown[]) => EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill(): unknown;
  },
): {
  query(sql: string): Promise<unknown>;
  assertAlive(): void;
  commit(): Promise<void>;
  close(): void;
};
export function acquireApiWorkerExecutor(
  path: string,
  expectedUid?: number,
  expectedGid?: number,
  run?: (
    program: string,
    args: string[],
    options: { env: Record<string, string>; stdio: Array<string | number>; timeout: number },
  ) => unknown,
): { assertOwned(): void; close(): void };
export function validateInstalledApiWorkerEvidence(args: {
  releaseId: string;
  values: Record<string, string>;
  bytes: Buffer;
  receipt: unknown;
  planBytes: Buffer;
  operationBytes: Buffer;
  evidence: Record<string, Buffer>;
}): void;
export function runManualApiWorkerUpgrade(
  mode: string,
  requestPath: string,
): Promise<{ status: string; receipt: string }>;
