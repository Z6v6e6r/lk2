import type { TimewebObservabilityContract } from './verify-timeweb-api-web-observability.js';

export type TimewebObservedService = 'api' | 'web';

export interface TimewebMonitorReadbackValue {
  providerMonitorId: string;
  name: string;
  enabled: boolean;
  type: string;
  method: string;
  url: string;
  expectedStatus: number;
  regions: string[];
  intervalSeconds: number;
  timeoutSeconds: number;
  authorizationHeaderConfigured: boolean;
  lastCheckAt: string;
  successfulConsecutiveRounds: number;
  activeIncidentCount: number;
}

export interface TimewebMonitorReadback {
  schema: string;
  source: string;
  readAt: string;
  projectId: number;
  monitors: TimewebMonitorReadbackValue[];
}

export interface TimewebAlertDelivery {
  channel: string;
  deliveredAt: string;
}

export interface TimewebAlertReadback {
  schema: string;
  source: string;
  testId: string;
  monitorNames: string[];
  triggeredAt: string;
  deliveries: TimewebAlertDelivery[];
  acknowledgedAt: string;
  acknowledgementKind: string;
  acknowledgedByRole: string;
  recoveredAt: string;
  recoveryKind: string;
  recoveryDeliveries: TimewebAlertDelivery[];
}

export interface TimewebObservationServiceSample {
  service: TimewebObservedService;
  releaseId: string;
  httpStatus: number;
  latencyMs: number;
  readinessOk: boolean;
  restartCount: number;
}

export interface TimewebObservationSample {
  at: string;
  services: TimewebObservationServiceSample[];
}

export interface TimewebRollbackReadback {
  sha256: string;
  priorApiReference: string;
  priorWebReference: string;
}

export interface TimewebObservabilityEvidence {
  schema: string;
  contractSchema: string;
  source: { sha: string; tree: string; releaseId: string };
  observedAt: string;
  target: { hostname: string; provider: string; serverId: number; projectId: number };
  monitoring: {
    monitors: Array<TimewebMonitorReadbackValue & { service: TimewebObservedService }>;
    alertTest: {
      testId: string;
      monitorNames: string[];
      triggeredAt: string;
      deliveries: TimewebAlertDelivery[];
      acknowledgedAt: string;
      acknowledgedByRole: string;
      recoveredAt: string;
      recoveryDeliveries: TimewebAlertDelivery[];
    };
  };
  observation: {
    startedAt: string;
    endedAt: string;
    sources: { http: string; container: string; readiness: string };
    samples: TimewebObservationSample[];
  };
  rollback: {
    controllerPath: unknown;
    mode: unknown;
    receiptPath: unknown;
    receiptSha256: string;
    mappingReadAt: string;
    apiImage: string;
    webImage: string;
  };
}

export interface TimewebEvidenceBuildInput {
  contract: TimewebObservabilityContract;
  providerReadback: TimewebMonitorReadback;
  alertReadback: TimewebAlertReadback;
  sourceSha: string;
  sourceTree: string;
  releaseId: string;
  observedAt: string;
  samples: TimewebObservationSample[];
  mappingReadAt: string;
  rollbackReceipt: TimewebRollbackReadback;
}

export class TimewebObservabilityProducerError extends Error {
  readonly code: string;
}

export function validateTimewebMonitorReadback(
  input: unknown,
  contract: TimewebObservabilityContract,
  observedAt: string,
): Array<TimewebMonitorReadbackValue & { service: TimewebObservedService }>;

export function validateTimewebAlertReadback(
  input: unknown,
  contract: TimewebObservabilityContract,
): TimewebObservabilityEvidence['monitoring']['alertTest'];

export function buildTimewebObservabilityEvidence(
  input: TimewebEvidenceBuildInput,
): TimewebObservabilityEvidence;

export function atomicWriteTimewebObservabilityEvidence(
  evidence: TimewebObservabilityEvidence,
  options?: {
    outputPath?: string;
    expectedOutputPath?: string;
    custodyRoot?: string;
    expectedUid?: number;
    expectedGid?: number;
    beforeCommit?: () => void;
  },
): { status: string; path: string; mode: string; valuesPrinted: boolean };

export function collectTimewebObservationSamples(options: {
  contract: TimewebObservabilityContract;
  releaseId: string;
  authorizationHeader: string;
  now?: () => number;
  monotonicNow?: () => number;
  wait?: (milliseconds: number) => Promise<unknown>;
  runProbe?: (
    url: string,
    authorizationHeader: string,
  ) => Promise<{ httpStatus: number; latencyMs: number; readinessOk: boolean }>;
  inspectContainer?: (
    service: TimewebObservedService,
    releaseId: string,
  ) => { id: string; restartCount: number };
}): Promise<TimewebObservationSample[]>;
