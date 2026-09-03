#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { parseStrictJson } from './strict-json.js';
import { runTimewebSourceGit } from './verify-timeweb-frozen-source.js';
import {
  validateTimewebObservabilityContract,
  validateTimewebObservabilityEvidence,
} from './verify-timeweb-api-web-observability.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTRACT_PATH = resolve(REPOSITORY_ROOT, 'deploy/timeweb/api-web-observability.v1.json');
const CANONICAL_ROOT = '/opt';
const CANONICAL_OUTPUT = '/opt/phub/timeweb-beta/observability/api-web-evidence.json';
const PROVIDER_READBACK = '/opt/phub/timeweb-beta/observability/timeweb-monitor-readback.json';
const ALERT_READBACK = '/opt/phub/timeweb-beta/observability/alert-test-readback.json';
const ROLLBACK_RECEIPT = '/opt/phub/timeweb-beta/backups/yandex-public/receipt.json';
const DOCKER = '/usr/bin/docker';
const SHA = /^[0-9a-f]{40}$/u;
const RELEASE_ID = /^([0-9a-f]{40})-([1-9][0-9]{10,19})-1$/u;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const BASIC_HEADER = /^Basic [A-Za-z0-9+/]+={0,2}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const PROVIDER_SNAPSHOT_MAX_AGE_SECONDS = 30;
const LIVE_CADENCE_MILLISECONDS = 14_000;
const SERVICES = Object.freeze(['api', 'web']);
const EXPECTED_MONITOR_IDS = Object.freeze({
  api: ['26ed404e-98e5-45c5', '98e3-31b9dfd6f0f2'].join('-'),
  web: 'b25e28a0-02d8-49e4-a0a1-f49f62abc02c',
});

export class TimewebObservabilityProducerError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TimewebObservabilityProducerError';
    this.code = code;
  }
}

function fail(code) {
  throw new TimewebObservabilityProducerError(code);
}

function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}

function exactKeys(value, expected, code) {
  const keys = Object.keys(object(value, code)).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())) fail(code);
}

function integer(value, code, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(code);
  return value;
}

function timestamp(value, code) {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) fail(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) fail(code);
  return milliseconds;
}

function elapsedSeconds(later, earlier) {
  return (later - earlier) / 1000;
}

function strictJson(bytes, code) {
  try {
    return parseStrictJson(bytes);
  } catch {
    fail(code);
  }
}

function containsCredentialValue(value) {
  if (typeof value === 'string') return /\bBasic\s+[A-Za-z0-9+/]+={0,2}(?:\s|$)/iu.test(value);
  if (Array.isArray(value)) return value.some(containsCredentialValue);
  if (value && typeof value === 'object') return Object.values(value).some(containsCredentialValue);
  return false;
}

function validateMonitorReadback(monitor, definition, contract) {
  exactKeys(
    monitor,
    [
      'providerMonitorId',
      'name',
      'enabled',
      'type',
      'method',
      'url',
      'expectedStatus',
      'regions',
      'intervalSeconds',
      'timeoutSeconds',
      'authorizationHeaderConfigured',
      'lastCheckAt',
      'successfulConsecutiveRounds',
      'activeIncidentCount',
    ],
    'producer_provider_monitor_keys',
  );
  if (
    !PROVIDER_ID.test(monitor.providerMonitorId ?? '') ||
    monitor.providerMonitorId !== EXPECTED_MONITOR_IDS[definition.service] ||
    monitor.name !== definition.name ||
    monitor.enabled !== true ||
    monitor.type !== definition.type ||
    monitor.method !== definition.method ||
    monitor.url !== definition.url ||
    monitor.expectedStatus !== definition.expectedStatus ||
    monitor.intervalSeconds !== contract.monitoring.intervalSeconds ||
    monitor.timeoutSeconds !== contract.monitoring.timeoutSeconds ||
    monitor.authorizationHeaderConfigured !== true
  )
    fail('producer_provider_monitor_identity');
  if (
    !Array.isArray(monitor.regions) ||
    monitor.regions.length < contract.monitoring.minimumRegions ||
    monitor.regions.some((region) => typeof region !== 'string' || region.length === 0) ||
    new Set(monitor.regions).size !== monitor.regions.length
  )
    fail('producer_provider_monitor_regions');
  timestamp(monitor.lastCheckAt, 'producer_provider_monitor_last_check');
  integer(monitor.successfulConsecutiveRounds, 'producer_provider_monitor_rounds');
  integer(monitor.activeIncidentCount, 'producer_provider_monitor_incidents');
  return {
    ...monitor,
    service: definition.service,
  };
}

export function validateTimewebMonitorReadback(input, contractInput, observedAt) {
  const contract = validateTimewebObservabilityContract(contractInput);
  const readback = object(input, 'producer_provider_readback');
  exactKeys(
    readback,
    ['schema', 'source', 'readAt', 'projectId', 'monitors'],
    'producer_provider_readback_keys',
  );
  if (
    readback.schema !== 'PHUB_TIMEWEB_MONITOR_READBACK_V1' ||
    readback.source !== 'timeweb-approved-read-only-readback' ||
    readback.projectId !== contract.target.projectId ||
    !Array.isArray(readback.monitors) ||
    readback.monitors.length !== contract.monitoring.monitors.length ||
    containsCredentialValue(readback)
  )
    fail('producer_provider_readback_identity');
  const observedAtMilliseconds = timestamp(observedAt, 'producer_observed_at');
  const readAt = timestamp(readback.readAt, 'producer_provider_read_at');
  const age = elapsedSeconds(observedAtMilliseconds, readAt);
  if (age < 0 || age > PROVIDER_SNAPSHOT_MAX_AGE_SECONDS) fail('producer_provider_readback_age');
  return readback.monitors.map((monitor, index) =>
    validateMonitorReadback(monitor, contract.monitoring.monitors[index], contract),
  );
}

export function validateTimewebAlertReadback(input, contractInput) {
  const contract = validateTimewebObservabilityContract(contractInput);
  const readback = object(input, 'producer_alert_readback');
  exactKeys(
    readback,
    [
      'schema',
      'source',
      'testId',
      'monitorNames',
      'triggeredAt',
      'deliveries',
      'acknowledgedAt',
      'acknowledgementKind',
      'acknowledgedByRole',
      'recoveredAt',
      'recoveryKind',
      'recoveryDeliveries',
    ],
    'producer_alert_readback_keys',
  );
  if (
    readback.schema !== 'PHUB_TIMEWEB_ALERT_READBACK_V1' ||
    readback.source !== 'approved-delivery-and-provider-readback' ||
    !PROVIDER_ID.test(readback.testId ?? '') ||
    JSON.stringify(readback.monitorNames) !==
      JSON.stringify(contract.monitoring.monitors.map(({ name }) => name)) ||
    readback.acknowledgementKind !== 'release-owner-observed-active-incident' ||
    readback.acknowledgedByRole !== contract.alerting.acknowledgementRole ||
    readback.recoveryKind !== 'provider-closed-after-all-regions-healthy' ||
    containsCredentialValue(readback)
  )
    fail('producer_alert_readback_identity');
  for (const key of ['triggeredAt', 'acknowledgedAt', 'recoveredAt']) {
    timestamp(readback[key], 'producer_alert_readback_timestamp');
  }
  for (const key of ['deliveries', 'recoveryDeliveries']) {
    if (!Array.isArray(readback[key])) fail('producer_alert_readback_delivery');
    for (const delivery of readback[key]) {
      exactKeys(delivery, ['channel', 'deliveredAt'], 'producer_alert_readback_delivery');
      timestamp(delivery.deliveredAt, 'producer_alert_readback_delivery');
    }
  }
  return {
    testId: readback.testId,
    monitorNames: readback.monitorNames,
    triggeredAt: readback.triggeredAt,
    deliveries: readback.deliveries,
    acknowledgedAt: readback.acknowledgedAt,
    acknowledgedByRole: readback.acknowledgedByRole,
    recoveredAt: readback.recoveredAt,
    recoveryDeliveries: readback.recoveryDeliveries,
  };
}

function validateSamples(samples, contract, releaseId) {
  if (!Array.isArray(samples) || samples.length < contract.observation.minimumSamples)
    fail('producer_samples');
  for (const sample of samples) {
    exactKeys(sample, ['at', 'services'], 'producer_sample_keys');
    timestamp(sample.at, 'producer_sample_at');
    if (!Array.isArray(sample.services) || sample.services.length !== SERVICES.length)
      fail('producer_sample_services');
    sample.services.forEach((service, index) => {
      exactKeys(
        service,
        ['service', 'releaseId', 'httpStatus', 'latencyMs', 'readinessOk', 'restartCount'],
        'producer_sample_service_keys',
      );
      if (service.service !== SERVICES[index] || service.releaseId !== releaseId)
        fail('producer_sample_identity');
      integer(service.httpStatus, 'producer_sample_status', 100);
      integer(service.latencyMs, 'producer_sample_latency');
      integer(service.restartCount, 'producer_sample_restarts');
      if (service.readinessOk !== (service.httpStatus === 200)) fail('producer_sample_result');
    });
  }
  return samples;
}

export function buildTimewebObservabilityEvidence(input) {
  const contract = validateTimewebObservabilityContract(input.contract);
  if (!SHA.test(input.sourceSha ?? '') || !SHA.test(input.sourceTree ?? ''))
    fail('producer_source_identity');
  const releaseMatch = RELEASE_ID.exec(input.releaseId ?? '');
  if (!releaseMatch || releaseMatch[1] !== input.sourceSha) fail('producer_release_identity');
  const observedAt = timestamp(input.observedAt, 'producer_observed_at');
  const monitors = validateTimewebMonitorReadback(
    input.providerReadback,
    contract,
    input.observedAt,
  );
  const alertTest = validateTimewebAlertReadback(input.alertReadback, contract);
  const samples = validateSamples(input.samples, contract, input.releaseId);
  const receipt = object(input.rollbackReceipt, 'producer_rollback_receipt');
  if (
    typeof receipt.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(receipt.sha256) ||
    typeof receipt.priorApiReference !== 'string' ||
    typeof receipt.priorWebReference !== 'string'
  )
    fail('producer_rollback_receipt');
  const mappingReadAt = timestamp(input.mappingReadAt, 'producer_rollback_read_at');
  if (mappingReadAt > observedAt) fail('producer_rollback_read_at');
  const evidence = {
    schema: 'PHUB_TIMEWEB_API_WEB_OBSERVABILITY_EVIDENCE_V1',
    contractSchema: contract.schema,
    source: {
      sha: input.sourceSha,
      tree: input.sourceTree,
      releaseId: input.releaseId,
    },
    observedAt: input.observedAt,
    target: structuredClone(contract.target),
    monitoring: { monitors, alertTest },
    observation: {
      startedAt: samples[0].at,
      endedAt: samples.at(-1).at,
      sources: structuredClone(contract.observation.sources),
      samples,
    },
    rollback: {
      controllerPath: contract.rollback.controllerPath,
      mode: contract.rollback.mode,
      receiptPath: contract.rollback.receiptPath,
      receiptSha256: receipt.sha256,
      mappingReadAt: input.mappingReadAt,
      apiImage: receipt.priorApiReference,
      webImage: receipt.priorWebReference,
    },
  };
  if (containsCredentialValue(evidence)) fail('producer_credential_value');
  validateTimewebObservabilityEvidence(evidence, contract, {
    sourceSha: input.sourceSha,
    sourceTree: input.sourceTree,
    releaseId: input.releaseId,
    observedAt: input.observedAt,
    evaluatedAt: input.observedAt,
    rollbackReceipt: receipt,
  });
  return evidence;
}

function assertDirectoryChain(path, custodyRoot, expectedUid) {
  const canonicalRoot = resolve(custodyRoot);
  for (let directory = resolve(path); ; directory = dirname(directory)) {
    if (directory !== canonicalRoot && !directory.startsWith(`${canonicalRoot}/`))
      fail('producer_output_custody');
    const value = lstatSync(directory);
    if (
      !value.isDirectory() ||
      value.isSymbolicLink() ||
      value.uid !== expectedUid ||
      (value.mode & 0o022) !== 0 ||
      realpathSync(directory) !== directory
    )
      fail('producer_output_custody');
    if (directory === canonicalRoot) break;
  }
}

function assertSafeOutput(path, expectedUid) {
  if (!existsSync(path)) return undefined;
  const value = lstatSync(path);
  if (
    !value.isFile() ||
    value.isSymbolicLink() ||
    value.uid !== expectedUid ||
    value.nlink !== 1 ||
    (value.mode & 0o777) !== 0o600 ||
    realpathSync(path) !== path
  )
    fail('producer_output_custody');
  return value;
}

function syncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function atomicWriteTimewebObservabilityEvidence(
  evidence,
  {
    outputPath = CANONICAL_OUTPUT,
    expectedOutputPath = CANONICAL_OUTPUT,
    custodyRoot = CANONICAL_ROOT,
    expectedUid = 0,
    expectedGid = 0,
    beforeCommit,
  } = {},
) {
  if (resolve(outputPath) !== expectedOutputPath) fail('producer_output_path');
  const parent = dirname(outputPath);
  assertDirectoryChain(parent, custodyRoot, expectedUid);
  assertSafeOutput(outputPath, expectedUid);
  const contents = `${JSON.stringify(evidence, null, 2)}\n`;
  if (containsCredentialValue(evidence)) fail('producer_credential_value');
  const temporary = resolve(
    parent,
    `.api-web-evidence.json.incoming-${process.pid}-${randomBytes(12).toString('hex')}`,
  );
  let descriptor;
  let temporaryIdentity;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    temporaryIdentity = fstatSync(descriptor);
    writeFileSync(descriptor, contents, 'utf8');
    fchownSync(descriptor, expectedUid, expectedGid);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const staged = lstatSync(temporary);
    if (
      !staged.isFile() ||
      staged.isSymbolicLink() ||
      staged.dev !== temporaryIdentity.dev ||
      staged.ino !== temporaryIdentity.ino ||
      staged.nlink !== 1 ||
      staged.uid !== expectedUid ||
      (staged.mode & 0o777) !== 0o600
    )
      fail('producer_output_staging');
    beforeCommit?.();
    assertSafeOutput(outputPath, expectedUid);
    renameSync(temporary, outputPath);
    syncDirectory(parent);
    const installed = assertSafeOutput(outputPath, expectedUid);
    if (
      installed.dev !== temporaryIdentity.dev ||
      installed.ino !== temporaryIdentity.ino ||
      createHash('sha256').update(readFileSync(outputPath)).digest('hex') !==
        createHash('sha256').update(contents).digest('hex')
    )
      fail('producer_output_readback');
    return { status: 'written', path: outputPath, mode: '0600', valuesPrinted: false };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary) && temporaryIdentity) {
      const current = lstatSync(temporary);
      if (current.dev === temporaryIdentity.dev && current.ino === temporaryIdentity.ino)
        unlinkSync(temporary);
    }
    if (error instanceof TimewebObservabilityProducerError) throw error;
    fail('producer_output_write');
  }
}

function secureInputBytes(path, expectedPath) {
  if (process.getuid?.() !== 0) fail('producer_root_required');
  if (resolve(path) !== expectedPath) fail('producer_input_path');
  assertDirectoryChain(dirname(path), CANONICAL_ROOT, 0);
  const value = lstatSync(path);
  if (
    !value.isFile() ||
    value.isSymbolicLink() ||
    value.uid !== 0 ||
    value.nlink !== 1 ||
    (value.mode & 0o177) !== 0 ||
    realpathSync(path) !== path
  )
    fail('producer_input_custody');
  return readFileSync(path);
}

function readAuthorizationHeader(fd = 3) {
  if (process.getuid?.() !== 0) fail('producer_root_required');
  let value;
  try {
    const metadata = fstatSync(fd);
    if (
      !metadata.isFIFO() &&
      (!metadata.isFile() ||
        metadata.uid !== 0 ||
        metadata.nlink !== 1 ||
        (metadata.mode & 0o177) !== 0)
    )
      fail('producer_authorization_custody');
    value = readFileSync(fd, 'utf8');
  } catch (error) {
    if (error instanceof TimewebObservabilityProducerError) throw error;
    fail('producer_authorization_unavailable');
  }
  if (value.endsWith('\n')) value = value.slice(0, -1);
  if (value.includes('\n') || value.includes('\r') || !BASIC_HEADER.test(value))
    fail('producer_authorization_format');
  const encoded = value.slice('Basic '.length);
  const decoded = Buffer.from(encoded, 'base64');
  const canonical = decoded.toString('base64');
  const separator = decoded.indexOf(0x3a);
  if (
    canonical !== encoded ||
    separator <= 0 ||
    separator === decoded.length - 1 ||
    decoded.some((byte) => byte < 0x20 || byte === 0x7f)
  ) {
    decoded.fill(0);
    fail('producer_authorization_format');
  }
  decoded.fill(0);
  return value;
}

function runDocker(args) {
  try {
    return execFileSync(DOCKER, args, {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/root',
        DOCKER_HOST: 'unix:///var/run/docker.sock',
        DOCKER_CONFIG: '/root/.docker',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    fail('producer_docker_readback');
  }
}

function readContainer(service, releaseId) {
  const ids = runDocker([
    'ps',
    '--filter',
    'label=com.docker.compose.project=phub-timeweb-beta',
    '--filter',
    `label=com.docker.compose.service=${service}`,
    '--format',
    '{{.ID}}',
  ])
    .split('\n')
    .filter(Boolean);
  if (ids.length !== 1) fail('producer_container_identity');
  const values = runDocker([
    'inspect',
    '--format',
    '{{.Id}}\t{{.RestartCount}}\t{{index .Config.Labels "phub.release-id"}}',
    ids[0],
  ]).split('\t');
  if (values.length !== 3 || values[2] !== releaseId) fail('producer_container_identity');
  return { id: values[0], restartCount: integer(Number(values[1]), 'producer_restart_count') };
}

async function probe(url, authorizationHeader) {
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { Authorization: authorizationHeader },
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    return {
      httpStatus: response.status,
      latencyMs: Math.max(0, Math.ceil(performance.now() - started)),
      readinessOk: response.status === 200,
    };
  } catch {
    fail('producer_direct_probe');
  }
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

export async function collectTimewebObservationSamples({
  contract,
  releaseId,
  authorizationHeader,
  now = () => Date.now(),
  monotonicNow = () => performance.now(),
  wait = sleep,
  runProbe = probe,
  inspectContainer = readContainer,
}) {
  const sampleCount =
    Math.ceil(contract.observation.windowSeconds / (LIVE_CADENCE_MILLISECONDS / 1000)) + 1;
  const samples = [];
  const containerIds = {};
  const scheduleStarted = monotonicNow();
  for (let index = 0; index < sampleCount; index += 1) {
    if (index > 0) {
      const due = scheduleStarted + index * LIVE_CADENCE_MILLISECONDS;
      await wait(Math.max(0, due - monotonicNow()));
    }
    const at = new Date(now()).toISOString();
    const [apiProbe, webProbe] = await Promise.all(
      contract.monitoring.monitors.map((definition) =>
        runProbe(definition.url, authorizationHeader),
      ),
    );
    const containers = SERVICES.map((service) => inspectContainer(service, releaseId));
    containers.forEach((container, serviceIndex) => {
      const service = SERVICES[serviceIndex];
      if (containerIds[service] !== undefined && containerIds[service] !== container.id)
        fail('producer_container_recreated');
      containerIds[service] = container.id;
    });
    samples.push({
      at,
      services: [apiProbe, webProbe].map((result, serviceIndex) => ({
        service: SERVICES[serviceIndex],
        releaseId,
        httpStatus: result.httpStatus,
        latencyMs: result.latencyMs,
        readinessOk: result.readinessOk,
        restartCount: containers[serviceIndex].restartCount,
      })),
    });
  }
  return samples;
}

function readRollbackReceiptReadback(contract, sourceSha, sourceTree, releaseId, mappingReadAt) {
  const bytes = secureInputBytes(ROLLBACK_RECEIPT, contract.rollback.receiptPath);
  const receipt = object(
    strictJson(bytes, 'producer_rollback_receipt_json'),
    'producer_rollback_receipt',
  );
  if (
    receipt.candidateSourceSha !== sourceSha ||
    receipt.candidateSourceTree !== sourceTree ||
    receipt.candidateReleaseId !== releaseId ||
    typeof receipt.priorApiReference !== 'string' ||
    typeof receipt.priorWebReference !== 'string'
  )
    fail('producer_rollback_receipt_identity');
  return {
    mappingReadAt,
    receipt: {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      priorApiReference: receipt.priorApiReference,
      priorWebReference: receipt.priorWebReference,
    },
  };
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--release-id' || !RELEASE_ID.test(argv[1]))
    fail('producer_arguments');
  return { releaseId: argv[1] };
}

async function main() {
  if (process.getuid?.() !== 0) fail('producer_root_required');
  const { releaseId } = parseArguments(process.argv.slice(2));
  const sourceSha = runTimewebSourceGit(['rev-parse', '--verify', 'HEAD']);
  const sourceTree = runTimewebSourceGit(['rev-parse', '--verify', 'HEAD^{tree}']);
  if (releaseId.split('-')[0] !== sourceSha) fail('producer_release_identity');
  const contract = validateTimewebObservabilityContract(
    strictJson(readFileSync(CONTRACT_PATH), 'producer_contract_json'),
  );
  const authorizationHeader = readAuthorizationHeader();
  const samples = await collectTimewebObservationSamples({
    contract,
    releaseId,
    authorizationHeader,
  });
  const providerReadback = strictJson(
    secureInputBytes(PROVIDER_READBACK, PROVIDER_READBACK),
    'producer_provider_readback_json',
  );
  const alertReadback = strictJson(
    secureInputBytes(ALERT_READBACK, ALERT_READBACK),
    'producer_alert_readback_json',
  );
  const mappingReadAt = new Date().toISOString();
  const rollback = readRollbackReceiptReadback(
    contract,
    sourceSha,
    sourceTree,
    releaseId,
    mappingReadAt,
  );
  const observedAt = new Date().toISOString();
  const evidence = buildTimewebObservabilityEvidence({
    contract,
    providerReadback,
    alertReadback,
    sourceSha,
    sourceTree,
    releaseId,
    observedAt,
    samples,
    mappingReadAt: rollback.mappingReadAt,
    rollbackReceipt: rollback.receipt,
  });
  atomicWriteTimewebObservabilityEvidence(evidence);
  process.stdout.write(
    `${JSON.stringify({ status: 'pass', path: CANONICAL_OUTPUT, valuesPrinted: false })}\n`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code =
      error instanceof TimewebObservabilityProducerError ? error.code : 'unexpected_error';
    process.stderr.write(`${JSON.stringify({ status: 'fail', code })}\n`);
    process.exitCode = 1;
  });
}
