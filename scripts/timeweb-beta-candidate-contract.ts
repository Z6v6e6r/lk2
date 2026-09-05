import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { validateCanonicalManifest } from './timeweb-release-manifest-contract.js';
import {
  parseEnvironment,
  validateRuntimeContract,
  validateRuntimeEnvironments,
  validateTargetContract,
} from './verify-timeweb-deployment-contract.js';

export const TIMEWEB_COMPONENTS = ['web', 'api', 'worker', 'realtime', 'migrator'] as const;
export type TimewebComponent = (typeof TIMEWEB_COMPONENTS)[number];
export const TIMEWEB_EMPTY_DATABASE_MIGRATION_ACK = 'CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_V1';

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PROJECT_PATTERN = /^phub-tw-rehearsal-[a-z0-9-]{6,48}$/u;

export class TimewebCandidateContractError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = 'TimewebCandidateContractError';
  }
}

function reject(code: string): never {
  throw new TimewebCandidateContractError(code);
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(code);
  return value as Record<string, unknown>;
}

function exactFile(path: string, expectedBasename: string, code: string): Buffer {
  if (basename(path) !== expectedBasename) reject(`${code}_name`);
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)
      reject(`${code}_type`);
    return readFileSync(path);
  } catch (error) {
    if (error instanceof TimewebCandidateContractError) throw error;
    reject(`${code}_unavailable`);
  }
}

export interface CandidateIdentity {
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly workflowSha: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly manifestSha256: string;
  readonly images: Readonly<Record<TimewebComponent, string>>;
}

export interface ExpectedCandidateIdentity {
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly publicationRunId: string;
  readonly manifestSha256: string;
}

export function assertDistinctCandidatePair(
  candidate: CandidateIdentity,
  previous: CandidateIdentity,
): void {
  if (candidate.sourceSha === previous.sourceSha || candidate.sourceTree === previous.sourceTree)
    reject('previous_candidate_source_not_distinct');
  for (const component of TIMEWEB_COMPONENTS) {
    if (candidate.images[component] === previous.images[component])
      reject(`previous_candidate_${component}_image_not_distinct`);
  }
}

export function assertCandidateIdentity(
  manifestValue: unknown,
  expected: Pick<ExpectedCandidateIdentity, 'sourceSha' | 'sourceTree' | 'publicationRunId'>,
): Omit<CandidateIdentity, 'manifestSha256'> {
  if (
    !SHA_PATTERN.test(expected.sourceSha) ||
    !SHA_PATTERN.test(expected.sourceTree) ||
    !/^[1-9][0-9]*$/u.test(expected.publicationRunId)
  )
    reject('expected_source_identity');
  const manifest = record(manifestValue, 'manifest_shape');
  if (manifest.schemaVersion !== 'PHUB_TIMEWEB_RELEASE_MANIFEST_V2') reject('manifest_schema');
  if (manifest.gitCommit !== expected.sourceSha) reject('manifest_source_sha');
  if (manifest.gitTree !== expected.sourceTree) reject('manifest_source_tree');
  const publication = record(manifest.publication, 'manifest_publication');
  if (publication.workflowSha !== expected.sourceSha) reject('manifest_workflow_sha');
  if (typeof publication.runId !== 'string' || !/^[1-9][0-9]*$/u.test(publication.runId))
    reject('manifest_run_id');
  if (publication.runId !== expected.publicationRunId) reject('manifest_publication_run_id');
  if (publication.runAttempt !== '1') reject('manifest_run_attempt');
  if (!Array.isArray(manifest.images) || manifest.images.length !== TIMEWEB_COMPONENTS.length)
    reject('manifest_component_set');

  const images = Object.create(null) as Record<TimewebComponent, string>;
  for (const entry of manifest.images) {
    const image = record(entry, 'manifest_image');
    const component = image.component;
    if (
      typeof component !== 'string' ||
      !TIMEWEB_COMPONENTS.includes(component as TimewebComponent) ||
      Object.hasOwn(images, component)
    )
      reject('manifest_component_set');
    if (typeof image.digest !== 'string' || !DIGEST_PATTERN.test(image.digest))
      reject('manifest_image_digest');
    if (image.repository !== `ghcr.io/z6v6e6r/phub-${component}`)
      reject('manifest_image_repository');
    if (image.revision !== expected.sourceSha || image.sourceMaterialSha !== expected.sourceSha)
      reject('manifest_image_source');
    images[component as TimewebComponent] = `${image.repository}@${image.digest}`;
  }
  for (const component of TIMEWEB_COMPONENTS) {
    if (!Object.hasOwn(images, component)) reject('manifest_component_set');
  }

  return {
    sourceSha: expected.sourceSha,
    sourceTree: expected.sourceTree,
    workflowSha: publication.workflowSha,
    runId: publication.runId,
    runAttempt: '1',
    images,
  };
}

export function readCandidateArtifact(
  manifestPath: string,
  expected: ExpectedCandidateIdentity,
): CandidateIdentity {
  if (!DIGEST_PATTERN.test(`sha256:${expected.manifestSha256}`))
    reject('expected_manifest_checksum');
  const absoluteManifest = resolve(manifestPath);
  const checksumPath = join(dirname(absoluteManifest), 'release-manifest.sha256');
  const manifestBytes = exactFile(absoluteManifest, 'release-manifest.json', 'manifest');
  const checksumBytes = exactFile(checksumPath, 'release-manifest.sha256', 'checksum');
  const checksumText = checksumBytes.toString('utf8');
  const match = checksumText.match(/^([0-9a-f]{64}) {2}release-manifest\.json\n$/u);
  if (!match) reject('manifest_checksum_format');
  const actualChecksum = createHash('sha256').update(manifestBytes).digest('hex');
  if (actualChecksum !== match[1]) reject('manifest_checksum_mismatch');
  if (actualChecksum !== expected.manifestSha256) reject('manifest_expected_checksum_mismatch');

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    reject('manifest_json');
  }
  try {
    validateCanonicalManifest(manifest, {
      expectedPublication: {
        workflowSha: expected.sourceSha,
        runId: expected.publicationRunId,
        runAttempt: '1',
      },
      expectedBaseLockPath: resolve('deploy/timeweb/base-images.lock.json'),
    });
  } catch (error) {
    const reason =
      error && typeof error === 'object' && 'reason' in error ? String(error.reason) : 'unknown';
    reject(`manifest_canonical_${reason}`);
  }
  return {
    ...assertCandidateIdentity(manifest, expected),
    manifestSha256: actualChecksum,
  };
}

export interface TimewebRuntimeContracts {
  readonly target: ReturnType<typeof validateTargetContract>;
  readonly runtime: ReturnType<typeof validateRuntimeContract>;
}

export function loadTimewebRuntimeContracts(): TimewebRuntimeContracts {
  const target = validateTargetContract(
    JSON.parse(readFileSync(resolve('deploy/timeweb/target.json'), 'utf8')) as unknown,
  );
  const runtime = validateRuntimeContract(
    JSON.parse(
      readFileSync(resolve('deploy/timeweb/runtime-environment.contract.json'), 'utf8'),
    ) as unknown,
  );
  return { target, runtime };
}

export function buildSyntheticRuntimeEnvironments(
  contracts: TimewebRuntimeContracts = loadTimewebRuntimeContracts(),
): Record<string, Record<string, string>> {
  const environments: Record<string, Record<string, string>> = {};
  for (const [serviceName, serviceValue] of Object.entries(contracts.runtime.services)) {
    const service = serviceValue as {
      readonly required: readonly string[];
      readonly requiredTrueFlags: readonly string[];
      readonly requiredFalseFlags: readonly string[];
      readonly requiredDisabledModes: readonly string[];
      readonly requiredOffModes: readonly string[];
    };
    const values: Record<string, string> = {};
    for (const key of service.required) values[key] = 'synthetic-rehearsal-value';
    for (const key of service.requiredTrueFlags) values[key] = 'true';
    for (const key of service.requiredFalseFlags) values[key] = 'false';
    for (const key of service.requiredDisabledModes) values[key] = 'disabled';
    for (const key of service.requiredOffModes) values[key] = 'OFF';
    environments[serviceName] = values;
  }

  const databaseUrl = 'postgresql://phub:synthetic-rehearsal-postgres@postgres:5432/phub';
  const redisUrl = 'redis://redis:6379/0';
  const rabbitUrl = 'amqp://phub:synthetic-rehearsal-rabbitmq@rabbitmq:5672';
  for (const [serviceName, instanceId] of [
    ['api', 'timeweb-rehearsal-api'],
    ['worker', 'timeweb-rehearsal-worker'],
    ['realtime', 'timeweb-rehearsal-realtime'],
  ] as const) {
    Object.assign(environments[serviceName]!, {
      APP_ENV: 'staging',
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      RABBITMQ_URL: rabbitUrl,
      JWT_ISSUER: 'phub-rehearsal-identity',
      JWT_AUDIENCE: 'phub-rehearsal-api',
      OTEL_SERVICE_INSTANCE_ID: instanceId,
    });
  }
  Object.assign(environments.api!, {
    LK2_BETA_HOST: contracts.target.hostname,
    TENANT_KEY: 'padlhub',
    JWT_REALTIME_AUDIENCE: 'phub-realtime',
    JWT_ACCESS_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    JWT_REFRESH_SECRET: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    JWT_REALTIME_SECRET: 'cccccccccccccccccccccccccccccccc',
    AUTH_COOKIE_SECURE: 'true',
    CORS_ORIGINS: `https://${contracts.target.hostname}`,
    TRUSTED_PROXY_CIDRS: `${contracts.target.network.ingressAddress}/32`,
    VIVA_MODE: 'production',
    VIVA_OAUTH_ALLOWED_PROVIDERS: 'yandex',
    PUBLIC_OFFER_VERSION: 'rehearsal-public-offer-v1',
    PERSONAL_DATA_POLICY_VERSION: 'rehearsal-personal-data-v1',
    VIVA_OAUTH_REDIRECT_URI: `https://${contracts.target.hostname}/user/api/v1/padlhub/auth/viva/callback`,
    VIVA_OAUTH_SUCCESS_REDIRECT_URL: `https://${contracts.target.hostname}/`,
    VIVA_DELEGATION_ENCRYPTION_KEY: 'ddddddddddddddddddddddddddddddddddddddddddd',
  });
  Object.assign(environments.worker!, {
    TENANT_KEY: 'padlhub',
    OUTBOX_PUBLISH_MODE: 'leased',
    WORKER_RUNTIME_SECRET_ISOLATION_REQUIRED: 'true',
  });
  Object.assign(environments.realtime!, {
    REALTIME_EXPECTED_REPLICAS: '1',
    JWT_REALTIME_AUDIENCE: 'phub-realtime',
    JWT_REALTIME_SECRET: environments.api!.JWT_REALTIME_SECRET!,
  });
  Object.assign(environments.migrator!, {
    DATABASE_URL: databaseUrl,
    MIGRATOR_ADVISORY_LOCK_TIMEOUT_MS: '30000',
  });
  validateRuntimeEnvironments(environments, contracts.runtime, contracts.target);
  return environments;
}

export function serializeEnvironment(values: Readonly<Record<string, string>>): string {
  const lines = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/u.test(key) || value.length === 0 || /[\r\n\0]/u.test(value))
        reject('env_serialization');
      return `${key}=${value}`;
    });
  const serialized = `${lines.join('\n')}\n`;
  parseEnvironment(serialized);
  return serialized;
}

export function assertRehearsalProjectName(value: string): string {
  if (!PROJECT_PATTERN.test(value)) reject('compose_project_name');
  return value;
}

export interface RuntimeComponentSnapshot {
  readonly component: 'web' | 'api' | 'realtime' | 'worker';
  readonly configuredImage: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly healthy: boolean;
}

export function assertRuntimeSnapshot(
  snapshots: readonly RuntimeComponentSnapshot[],
  expected: {
    readonly releaseId: string;
    readonly sourceSha: string;
    readonly sourceTree: string;
    readonly images: Readonly<Partial<Record<'web' | 'api' | 'realtime' | 'worker', string>>>;
  },
): void {
  const expectedComponents = ['web', 'api', 'realtime', 'worker'] as const;
  if (
    snapshots.length !== expectedComponents.length ||
    new Set(snapshots.map(({ component }) => component)).size !== expectedComponents.length
  )
    reject('runtime_component_set');
  for (const component of expectedComponents) {
    const snapshot = snapshots.find((entry) => entry.component === component);
    if (!snapshot) reject('runtime_component_set');
    const expectedImage = expected.images[component];
    if (expectedImage && snapshot.configuredImage !== expectedImage)
      reject(`runtime_${component}_image`);
    if (
      snapshot.labels['phub.release-id'] !== expected.releaseId ||
      snapshot.labels['phub.source-sha'] !== expected.sourceSha ||
      snapshot.labels['phub.source-tree'] !== expected.sourceTree ||
      snapshot.labels['phub.rehearsal-only'] !== 'true'
    )
      reject(`runtime_${component}_identity`);
    if (!snapshot.healthy) reject(`runtime_${component}_health`);
  }
}

export type WriteAttemptKind = 'CREATE' | 'JOIN' | 'PAYMENT' | 'PROVIDER' | 'OTHER';

export function classifyWriteAttempt(method: string, rawUrl: string): WriteAttemptKind | null {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD') return null;
  const url = new URL(rawUrl, 'http://rehearsal.invalid');
  if (
    normalizedMethod === 'POST' &&
    /^\/user\/api\/v1\/[^/]+\/auth\/session\/refresh$/u.test(url.pathname)
  )
    return null;
  if (/\/games(?:\/)?$/u.test(url.pathname) && normalizedMethod === 'POST') return 'CREATE';
  if (/\/games\/[^/]+\/(?:join|waitlist)(?:\/join)?$/u.test(url.pathname)) return 'JOIN';
  if (/payment|gift-certificate-(?:orders|payments)|purchase/iu.test(url.pathname))
    return 'PAYMENT';
  if (/\/auth\/viva\/(?:authorize|reauthorize|access|callback)$/u.test(url.pathname))
    return 'PROVIDER';
  return 'OTHER';
}

export function assertForwardOnlyRollback(input: {
  readonly candidateReleaseId: string;
  readonly previousReleaseId: string;
  readonly databaseCommands: readonly string[];
}): void {
  if (
    input.candidateReleaseId.length === 0 ||
    input.previousReleaseId.length === 0 ||
    input.candidateReleaseId === input.previousReleaseId
  )
    reject('rollback_identity');
  if (input.databaseCommands.length !== 0) reject('rollback_database_command');
}
