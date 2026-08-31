import type { TimewebTargetContract } from './verify-timeweb-deployment-contract.js';

export interface TimewebObservabilityExpectedIdentity {
  sourceSha: string;
  sourceTree: string;
  releaseId: string;
  observedAt: string;
  evaluatedAt: string;
  rollbackReceipt: {
    sha256: string;
    priorApiReference: string;
    priorWebReference: string;
  };
}

export interface TimewebObservabilityContract {
  schema: string;
  target: { hostname: string; provider: string; serverId: number; projectId: number };
  evidence: {
    path: string;
    requiredOwner: string;
    requiredMode: string;
    credentialValuesAllowed: boolean;
  };
  monitoring: Record<string, unknown> & { monitors: Array<Record<string, unknown>> };
  observation: {
    windowSeconds: number;
    sampleIntervalSeconds: number;
    minimumSamples: number;
    minimumRequestsPerService: number;
    maximumEvidenceAgeSeconds: number;
    maximumObservedAtClockSkewSeconds: number;
    requiredSuccessfulMonitorRounds: number;
    sources: { http: string; container: string; readiness: string };
  };
  abortThresholds: Record<string, number>;
  alerting: Record<string, unknown> & { deliveryChannels: string[] };
  rollback: Record<string, unknown>;
}

export class TimewebObservabilityContractError extends Error {
  readonly code: string;
}

export function validateTimewebObservabilityContract(
  input: unknown,
  target?: TimewebTargetContract,
): TimewebObservabilityContract;

export function validateTimewebObservabilityEvidence(
  input: unknown,
  contract: TimewebObservabilityContract,
  expected: TimewebObservabilityExpectedIdentity,
): Record<string, unknown>;

export function verifyTimewebObservabilityEvidenceForActivation(input: {
  sourceSha: string;
  sourceTree: string;
  releaseId: string;
  receiptPath: string;
}): Record<string, unknown>;
