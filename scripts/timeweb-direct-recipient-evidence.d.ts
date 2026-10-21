export class DirectRecipientEvidenceError extends Error {
  readonly code: string;
}
export interface DirectRecipientBinding {
  sourceSha: string;
  sourceTree: string;
  releaseId: string;
  operationSha256: string;
  contractSha256: string;
  collectorSourceSha256: string;
}
export interface DirectRecipientCapture {
  role: string;
  kind: string;
  toolVersion: string;
  callId: string;
  reader: string;
  capturedAt: string;
  rawFile: string;
  rawSize: number;
  rawSha256: string;
  assertion: Record<string, unknown>;
}
export interface DirectRecipientPolicy {
  schema: 'PHUB_TIMEWEB_DIRECT_RECIPIENT_POLICY_V1';
  state: 'UNENROLLED' | 'REVIEWED_PRIVATE_INPUT';
  trust: 'APPROVED_READER_HUMAN_REVIEW_V1';
  target: { hostname: 'lk2.padlhub.su'; serverId: 8886471; projectId: 262717 };
  binding: DirectRecipientBinding;
  nonce: string;
  reader: string;
  owner: { identity: string; role: 'release-owner'; account: string; peer: string };
  recipients: {
    email: { account: string; sender: string };
    telegram: { account: string; sender: string; peer: string };
  };
  configuration: {
    monitors: Array<{
      id: string;
      name: string;
      url: string;
      enabled: true;
      method: 'GET';
      expectedStatus: 200;
      regions: [string, string];
      intervalSeconds: 60;
      timeoutSeconds: 10;
      authorizationHeaderConfigured: true;
    }>;
    deliveryChannels: ['email', 'telegram'];
  };
  templates: null | Record<'email' | 'telegram', Record<'alert' | 'recovery', string>>;
  captureReviewSha256: string | null;
}
export function parseDirectRecipientPolicy(bytes: string | Uint8Array): DirectRecipientPolicy;
/** A custody hash; independent human review must supply the caller's policy pin. */
export function directRecipientCaptureReviewSha256(captures: DirectRecipientCapture[]): string;
export interface DirectRecipientPreparationEvidence {
  schema: 'PHUB_TIMEWEB_DIRECT_RECIPIENT_PREPARATION_V1';
  purpose: 'PREPARATION_ONLY_NOT_FOR_ACTIVATION';
  trust: 'APPROVED_READER_HUMAN_REVIEW_V1';
  target: DirectRecipientPolicy['target'];
  binding: DirectRecipientBinding;
  nonce: string;
  observedAt: string;
  policySha256: string;
  captureReviewSha256: string;
  bundleSha256: string;
  panelConfiguration: {
    source: 'OPERATOR_ATTESTED_PANEL_CONFIGURATION';
    configurationSha256: string;
    rawSha256: string;
  };
  directObservation: {
    source: 'reviewed-direct-probe-observation';
    trust: 'APPROVED_READER_HUMAN_REVIEW_V1';
    assertedCollectorSourceSha256: string;
    startedAt: string;
    completedAt: string;
    rounds: 61;
    requestsPerService: 122;
    rawSha256: string;
  };
  recipientLifecycle: Array<{
    monitorId: string;
    triggerLowerBoundAt: string;
    recoveryLowerBoundAt: string;
    alerts: Array<{
      channel: 'email' | 'telegram';
      observedBy: string;
      sourceIdentitySha256: string;
      rawSha256: string;
    }>;
    owner: {
      observedBy: string;
      acknowledgedAt: string;
      sourceIdentitySha256: string;
      rawSha256: string;
    };
    recoveries: Array<{
      channel: 'email' | 'telegram';
      observedBy: string;
      sourceIdentitySha256: string;
      rawSha256: string;
    }>;
  }>;
  operationalWriter: false;
}
/** Pure preparation. Never supplies server enrollment, publication or activation authority. */
export function buildDirectRecipientEvidence(input: {
  policyBytes: string | Uint8Array;
  bundleBytes: string | Uint8Array;
  files: Map<string, Uint8Array>;
  expected: {
    policySha256: string;
    binding: DirectRecipientBinding;
    nonce: string;
    reader: string;
  };
  observedAt: string;
}): DirectRecipientPreparationEvidence;
