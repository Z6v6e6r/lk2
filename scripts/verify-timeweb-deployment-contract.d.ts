export interface TimewebHistoricalEvidence {
  path: string;
  immutableEvidence: boolean;
  validReleaseDirectory: boolean;
  validActivationInput: boolean;
  validRollbackInputForFutureRelease: boolean;
}

export interface TimewebTargetContract {
  schema: string;
  hostname: string;
  ipv4: string;
  dns: {
    aExpected: boolean;
    aaaaExpected: boolean;
    cnameExpected: boolean;
    ttl: number;
  };
  platform: { os: string; architecture: string; hostArchitecture: string };
  operatorRuntime: {
    node: {
      path: string;
      major: number;
      controllerPath: string;
      contractPath: string;
      launcherPath: string;
      launcherPackage: string;
      receiptPath: string;
    };
  };
  provider: { name: string; serverName: string; serverId: number; projectId: number };
  management: {
    requiredInterface: string;
    ssh: { hostKeyAlgorithm: string; pinnedFingerprint: string };
  };
  network: {
    name: string;
    external: boolean;
    subnet: string;
    ingressAddress: string;
    applicationAddresses: Record<string, string> & {
      web: string;
      api: string;
      realtime: string;
      worker: string;
      migrator: string;
    };
  };
  ingress: {
    ports: number[];
    onlyIngressMayBindHostPorts: boolean;
    caddy: {
      repository: string;
      indexDigest: string;
      linuxAmd64ManifestDigest: string;
      linuxAmd64ConfigDigest: string;
      version: string;
      adaptedJsonSha256: string;
    };
  };
  release: { root: string; historicalEvidence: TimewebHistoricalEvidence[] };
}

export interface TimewebRuntimeServiceContract {
  required: string[];
  allowed: string[];
  forbidden: string[];
  requiredTrueFlags: string[];
  requiredFalseFlags: string[];
  requiredDisabledModes: string[];
  requiredOffModes: string[];
}

export interface TimewebRuntimeEnvironmentContract {
  schema: string;
  rootOnlyDirectory: string;
  identityFields: string[];
  dependencySchemes: Record<string, string[]>;
  services: Record<string, TimewebRuntimeServiceContract>;
}

export interface TimewebOperatorNodeBootstrapContract {
  schema: string;
  apt: {
    sourceListSha256: string;
    packages: Array<{ name: string; version: string; architecture: string }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface TimewebDeploymentContractPaths {
  target: string;
  caddyfile: string;
  publicBetaCaddyfile: string;
  publicBetaIngress: string;
  ingress: string;
  application: string;
  runtime: string;
  nodeBootstrap: string;
  runbook: string;
  diagnostic?: string;
  envRoot?: string;
}

export class TimewebDeploymentContractError extends Error {
  readonly code: string;
}

export function validateTargetContract(target: unknown): TimewebTargetContract;
export function validateOperatorNodeBootstrapContract(
  contract: unknown,
  target: TimewebTargetContract,
): TimewebOperatorNodeBootstrapContract;
export function validateFutureReleaseDirectory(
  target: TimewebTargetContract,
  candidate: string,
): string;
export type TimewebHistoricalInputRole =
  | 'releaseDirectory'
  | 'composeWorkingDirectory'
  | 'caddyWorkingDirectory'
  | 'activationInput'
  | 'futureRollbackInput'
  | 'secretsSource'
  | 'mountSource';
export function validateHistoricalEvidenceInput(
  target: TimewebTargetContract,
  candidate: string,
  role: TimewebHistoricalInputRole,
): string;
export function validateCaddyfile(contents: string, target: TimewebTargetContract): void;
export function validateYandexPublicBetaCaddyfile(
  contents: string,
  target: TimewebTargetContract,
): void;
export function validateYandexPublicBetaIngressContract(
  contract: unknown,
  target: TimewebTargetContract,
): Record<string, unknown>;
export function validateIngressCompose(
  contents: string,
  target: TimewebTargetContract,
): Record<string, unknown>;
export function validateApplicationCompose(
  contents: string,
  target: TimewebTargetContract,
): Record<string, unknown>;
export function validateRuntimeContract(contract: unknown): TimewebRuntimeEnvironmentContract;
export function parseEnvironment(contents: string): Record<string, string>;
export function validateRuntimeEnvironments(
  environments: Record<string, Record<string, string>>,
  contract: TimewebRuntimeEnvironmentContract,
  target: TimewebTargetContract,
): void;
export function validateRunbook(contents: string, target: TimewebTargetContract): void;
export function validateRuntimeEnvironmentRoot(
  target: TimewebTargetContract,
  runtime: TimewebRuntimeEnvironmentContract,
  candidate: string,
): string;
export function validateDeploymentInputPaths(
  target: TimewebTargetContract,
  runtime: TimewebRuntimeEnvironmentContract,
  paths: TimewebDeploymentContractPaths,
): void;
export function verifyDeploymentContract(
  paths?: TimewebDeploymentContractPaths,
): Record<string, unknown>;
