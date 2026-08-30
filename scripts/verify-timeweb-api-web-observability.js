#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseStrictJson } from './strict-json.js';
import {
  TimewebFrozenSourceError,
  assertExactTimewebFrozenSource,
  requireExactTimewebFrozenSourceAuthority,
} from './verify-timeweb-frozen-source.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_CONTRACT = resolve(repositoryRoot, 'deploy/timeweb/api-web-observability.v1.json');
const ROLLBACK_FLOOR = resolve(
  repositoryRoot,
  'deploy/timeweb/yandex-public-beta-rollback-floor.json',
);
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST_REFERENCE = /^[a-z0-9.-]+\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/u;
const PROVIDER_MONITOR_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SERVICES = Object.freeze(['api', 'web']);

export class TimewebObservabilityContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TimewebObservabilityContractError';
    this.code = code;
  }
}

function reject(code) {
  throw new TimewebObservabilityContractError(code);
}

function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(code);
  return value;
}

function exactKeys(value, expected, code) {
  const actual = Object.keys(object(value, code)).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) reject(code);
}

function exactArray(value, expected, code) {
  if (!Array.isArray(value) || JSON.stringify(value) !== JSON.stringify(expected)) reject(code);
}

function integer(value, code, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) reject(code);
  return value;
}

function timestamp(value, code) {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)) reject(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value)
    reject(code);
  return milliseconds;
}

function strictJsonFile(path, code) {
  try {
    return parseStrictJson(readFileSync(path));
  } catch {
    reject(code);
  }
}

function elapsedSeconds(later, earlier) {
  return (later - earlier) / 1000;
}

function validateMonitorDefinition(monitor, expected) {
  exactKeys(
    monitor,
    ['name', 'service', 'type', 'method', 'url', 'expectedStatus'],
    'observability_monitor_keys',
  );
  for (const key of ['name', 'service', 'type', 'method', 'url']) {
    if (monitor[key] !== expected[key]) reject('observability_monitor_identity');
  }
  if (monitor.expectedStatus !== 200 || monitor.expectedStatus !== expected.expectedStatus)
    reject('observability_monitor_status');
}

export function validateTimewebObservabilityContract(input, target) {
  const contract = object(input, 'observability_contract');
  exactKeys(
    contract,
    [
      'schema',
      'target',
      'evidence',
      'monitoring',
      'observation',
      'abortThresholds',
      'alerting',
      'rollback',
    ],
    'observability_contract_keys',
  );
  if (contract.schema !== 'PHUB_TIMEWEB_API_WEB_OBSERVABILITY_CONTRACT_V1')
    reject('observability_contract_schema');

  exactKeys(
    contract.target,
    ['hostname', 'provider', 'serverId', 'projectId'],
    'observability_target',
  );
  const expectedTarget = target ?? {
    hostname: 'lk2.padlhub.su',
    provider: { name: 'Timeweb', serverId: 8886471, projectId: 262717 },
  };
  if (
    contract.target.hostname !== expectedTarget.hostname ||
    contract.target.provider !== expectedTarget.provider.name ||
    contract.target.serverId !== expectedTarget.provider.serverId ||
    contract.target.projectId !== expectedTarget.provider.projectId
  )
    reject('observability_target_identity');

  exactKeys(
    contract.evidence,
    ['path', 'requiredOwner', 'requiredMode', 'credentialValuesAllowed'],
    'observability_evidence_policy_keys',
  );
  if (
    contract.evidence.path !== '/opt/phub/timeweb-beta/observability/api-web-evidence.json' ||
    contract.evidence.requiredOwner !== 'root' ||
    contract.evidence.requiredMode !== '0600' ||
    contract.evidence.credentialValuesAllowed !== false
  )
    reject('observability_evidence_policy');

  exactKeys(
    contract.monitoring,
    [
      'minimumRegions',
      'intervalSeconds',
      'timeoutSeconds',
      'maximumLastCheckAgeSeconds',
      'authorizationHeaderRequired',
      'authorizationValueForbidden',
      'monitors',
    ],
    'observability_monitoring_keys',
  );
  if (
    contract.monitoring.minimumRegions !== 2 ||
    contract.monitoring.intervalSeconds !== 60 ||
    contract.monitoring.timeoutSeconds !== 10 ||
    contract.monitoring.maximumLastCheckAgeSeconds !== 130 ||
    contract.monitoring.authorizationHeaderRequired !== true ||
    contract.monitoring.authorizationValueForbidden !== true
  )
    reject('observability_monitoring_policy');
  const expectedMonitors = [
    {
      name: 'lk2-beta-api-ready',
      service: 'api',
      type: 'HTTPS',
      method: 'GET',
      url: 'https://lk2.padlhub.su/health/ready',
      expectedStatus: 200,
    },
    {
      name: 'lk2-beta-web-root',
      service: 'web',
      type: 'HTTPS',
      method: 'GET',
      url: 'https://lk2.padlhub.su/',
      expectedStatus: 200,
    },
  ];
  if (!Array.isArray(contract.monitoring.monitors) || contract.monitoring.monitors.length !== 2)
    reject('observability_monitors');
  contract.monitoring.monitors.forEach((monitor, index) =>
    validateMonitorDefinition(monitor, expectedMonitors[index]),
  );

  exactKeys(
    contract.observation,
    [
      'windowSeconds',
      'sampleIntervalSeconds',
      'minimumSamples',
      'minimumRequestsPerService',
      'maximumEvidenceAgeSeconds',
      'maximumObservedAtClockSkewSeconds',
      'requiredSuccessfulMonitorRounds',
      'sources',
    ],
    'observability_observation_keys',
  );
  const observationPolicy = {
    windowSeconds: 900,
    sampleIntervalSeconds: 15,
    minimumSamples: 60,
    minimumRequestsPerService: 60,
    maximumEvidenceAgeSeconds: 300,
    maximumObservedAtClockSkewSeconds: 30,
    requiredSuccessfulMonitorRounds: 3,
  };
  for (const [key, value] of Object.entries(observationPolicy)) {
    if (contract.observation[key] !== value) reject('observability_observation_policy');
  }
  exactKeys(
    contract.observation.sources,
    ['http', 'container', 'readiness'],
    'observability_observation_sources',
  );
  if (
    contract.observation.sources.http !== 'direct-api-web-probes' ||
    contract.observation.sources.container !== 'docker-inspect' ||
    contract.observation.sources.readiness !== 'direct-health-probes'
  )
    reject('observability_observation_sources');

  exactKeys(
    contract.abortThresholds,
    [
      'readinessConsecutiveFailures',
      'restartDelta',
      'serverErrorRateBasisPoints',
      'apiP95LatencyMs',
      'webP95LatencyMs',
      'activeIncidents',
    ],
    'observability_threshold_keys',
  );
  const thresholds = {
    readinessConsecutiveFailures: 2,
    restartDelta: 0,
    serverErrorRateBasisPoints: 100,
    apiP95LatencyMs: 1500,
    webP95LatencyMs: 1000,
    activeIncidents: 0,
  };
  for (const [key, value] of Object.entries(thresholds)) {
    if (contract.abortThresholds[key] !== value) reject('observability_threshold_policy');
  }

  exactKeys(
    contract.alerting,
    [
      'deliveryChannels',
      'deliveryDeadlineSeconds',
      'acknowledgementDeadlineSeconds',
      'recoveryDeliveryDeadlineSeconds',
      'maximumAlertTestAgeSeconds',
      'acknowledgementRole',
    ],
    'observability_alerting_keys',
  );
  exactArray(contract.alerting.deliveryChannels, ['email', 'telegram'], 'observability_channels');
  if (
    contract.alerting.deliveryDeadlineSeconds !== 300 ||
    contract.alerting.acknowledgementDeadlineSeconds !== 600 ||
    contract.alerting.recoveryDeliveryDeadlineSeconds !== 300 ||
    contract.alerting.maximumAlertTestAgeSeconds !== 86400 ||
    contract.alerting.acknowledgementRole !== 'release-owner'
  )
    reject('observability_alerting_policy');

  exactKeys(
    contract.rollback,
    ['controllerPath', 'mode', 'receiptPath', 'maximumReadBackAgeSeconds', 'triggerPolicy'],
    'observability_rollback_keys',
  );
  if (
    contract.rollback.controllerPath !== 'scripts/control-timeweb-yandex-public-beta.js' ||
    contract.rollback.mode !== 'rollback' ||
    contract.rollback.receiptPath !== '/opt/phub/timeweb-beta/backups/yandex-public/receipt.json' ||
    contract.rollback.maximumReadBackAgeSeconds !== 300 ||
    contract.rollback.triggerPolicy !== 'any-threshold'
  )
    reject('observability_rollback_policy');
  return contract;
}

function validateMonitorEvidence(monitor, definition, contract, observedAt) {
  exactKeys(
    monitor,
    [
      'name',
      'service',
      'providerMonitorId',
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
    'observability_evidence_monitor_keys',
  );
  for (const key of ['name', 'service', 'type', 'method', 'url', 'expectedStatus']) {
    if (monitor[key] !== definition[key]) reject('observability_evidence_monitor_identity');
  }
  if (!PROVIDER_MONITOR_ID.test(monitor.providerMonitorId ?? ''))
    reject('observability_evidence_monitor_id');
  if (monitor.enabled !== true) reject('observability_evidence_monitor_disabled');
  if (
    !Array.isArray(monitor.regions) ||
    monitor.regions.length < contract.monitoring.minimumRegions ||
    monitor.regions.some((region) => typeof region !== 'string' || region.length === 0) ||
    new Set(monitor.regions).size !== monitor.regions.length
  )
    reject('observability_evidence_regions');
  if (
    monitor.intervalSeconds !== contract.monitoring.intervalSeconds ||
    monitor.timeoutSeconds !== contract.monitoring.timeoutSeconds ||
    monitor.authorizationHeaderConfigured !== true
  )
    reject('observability_evidence_monitor_configuration');
  const lastCheckAt = timestamp(monitor.lastCheckAt, 'observability_evidence_last_check');
  const age = elapsedSeconds(observedAt, lastCheckAt);
  if (age < 0 || age > contract.monitoring.maximumLastCheckAgeSeconds)
    reject('observability_evidence_last_check_age');
  if (
    !Number.isSafeInteger(monitor.successfulConsecutiveRounds) ||
    monitor.successfulConsecutiveRounds < contract.observation.requiredSuccessfulMonitorRounds
  )
    reject('observability_evidence_monitor_rounds');
  const activeIncidentCount = integer(
    monitor.activeIncidentCount,
    'observability_evidence_active_incidents',
  );
  if (activeIncidentCount > contract.abortThresholds.activeIncidents)
    reject('observability_abort_active_incident');
}

function validateDeliveries(deliveries, expectedChannels, triggerAt, deadline, code) {
  if (!Array.isArray(deliveries) || deliveries.length !== expectedChannels.length) reject(code);
  const byChannel = new Map();
  for (const delivery of deliveries) {
    exactKeys(delivery, ['channel', 'deliveredAt'], code);
    if (!expectedChannels.includes(delivery.channel) || byChannel.has(delivery.channel))
      reject(code);
    const deliveredAt = timestamp(delivery.deliveredAt, code);
    const delay = elapsedSeconds(deliveredAt, triggerAt);
    if (delay < 0 || delay > deadline) reject(code);
    byChannel.set(delivery.channel, deliveredAt);
  }
  return byChannel;
}

function validateAlertTest(alertTest, contract, observedAt) {
  exactKeys(
    alertTest,
    [
      'testId',
      'monitorNames',
      'triggeredAt',
      'deliveries',
      'acknowledgedAt',
      'acknowledgedByRole',
      'recoveredAt',
      'recoveryDeliveries',
    ],
    'observability_alert_test_keys',
  );
  if (!PROVIDER_MONITOR_ID.test(alertTest.testId ?? '')) reject('observability_alert_test_id');
  exactArray(
    alertTest.monitorNames,
    contract.monitoring.monitors.map(({ name }) => name),
    'observability_alert_test_monitors',
  );
  const triggeredAt = timestamp(alertTest.triggeredAt, 'observability_alert_triggered_at');
  const age = elapsedSeconds(observedAt, triggeredAt);
  if (age < 0 || age > contract.alerting.maximumAlertTestAgeSeconds)
    reject('observability_alert_test_age');
  const deliveries = validateDeliveries(
    alertTest.deliveries,
    contract.alerting.deliveryChannels,
    triggeredAt,
    contract.alerting.deliveryDeadlineSeconds,
    'observability_alert_delivery',
  );
  const acknowledgedAt = timestamp(alertTest.acknowledgedAt, 'observability_alert_acknowledgement');
  const acknowledgementDelay = elapsedSeconds(acknowledgedAt, triggeredAt);
  if (
    acknowledgementDelay < 0 ||
    acknowledgementDelay > contract.alerting.acknowledgementDeadlineSeconds ||
    alertTest.acknowledgedByRole !== contract.alerting.acknowledgementRole ||
    [...deliveries.values()].some((deliveredAt) => deliveredAt > acknowledgedAt)
  )
    reject('observability_alert_acknowledgement');
  const recoveredAt = timestamp(alertTest.recoveredAt, 'observability_alert_recovered_at');
  if (recoveredAt < acknowledgedAt || recoveredAt > observedAt)
    reject('observability_alert_recovered_at');
  const recoveryDeliveries = validateDeliveries(
    alertTest.recoveryDeliveries,
    contract.alerting.deliveryChannels,
    recoveredAt,
    contract.alerting.recoveryDeliveryDeadlineSeconds,
    'observability_alert_recovery_delivery',
  );
  if ([...recoveryDeliveries.values()].some((deliveredAt) => deliveredAt > observedAt))
    reject('observability_alert_recovery_delivery');
}

function percentile95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function validateObservationSamples(samples, contract, expectedReleaseId, startedAt, endedAt) {
  if (!Array.isArray(samples) || samples.length < contract.observation.minimumSamples)
    reject('observability_samples');
  const serviceState = Object.fromEntries(
    SERVICES.map((service) => [
      service,
      { latencies: [], serverErrors: 0, consecutiveFailures: 0, maximumFailures: 0, restarts: [] },
    ]),
  );
  let previousAt;
  samples.forEach((sample, sampleIndex) => {
    exactKeys(sample, ['at', 'services'], 'observability_sample_keys');
    const sampleAt = timestamp(sample.at, 'observability_sample_at');
    if (
      (sampleIndex === 0 && sampleAt !== startedAt) ||
      (sampleIndex === samples.length - 1 && sampleAt !== endedAt) ||
      (previousAt !== undefined &&
        (sampleAt <= previousAt ||
          elapsedSeconds(sampleAt, previousAt) > contract.observation.sampleIntervalSeconds))
    )
      reject('observability_sample_cadence');
    previousAt = sampleAt;
    if (!Array.isArray(sample.services) || sample.services.length !== SERVICES.length)
      reject('observability_sample_services');
    sample.services.forEach((service, serviceIndex) => {
      exactKeys(
        service,
        ['service', 'releaseId', 'httpStatus', 'latencyMs', 'readinessOk', 'restartCount'],
        'observability_sample_service_keys',
      );
      const expectedService = SERVICES[serviceIndex];
      if (service.service !== expectedService || service.releaseId !== expectedReleaseId)
        reject('observability_service_identity');
      const httpStatus = integer(service.httpStatus, 'observability_http_status', { minimum: 100 });
      const latencyMs = integer(service.latencyMs, 'observability_latency');
      const restartCount = integer(service.restartCount, 'observability_restart_count');
      if (httpStatus > 599 || service.readinessOk !== (httpStatus === 200))
        reject('observability_sample_result');
      const state = serviceState[expectedService];
      state.latencies.push(latencyMs);
      state.restarts.push(restartCount);
      if (httpStatus >= 500) state.serverErrors += 1;
      state.consecutiveFailures = service.readinessOk ? 0 : state.consecutiveFailures + 1;
      state.maximumFailures = Math.max(state.maximumFailures, state.consecutiveFailures);
    });
  });

  for (const service of SERVICES) {
    const state = serviceState[service];
    const requestCount = state.latencies.length;
    if (requestCount < contract.observation.minimumRequestsPerService)
      reject('observability_request_budget');
    if (
      BigInt(state.serverErrors) * 10000n >=
      BigInt(requestCount) * BigInt(contract.abortThresholds.serverErrorRateBasisPoints)
    )
      reject('observability_abort_server_errors');
    const latencyThreshold =
      service === 'api'
        ? contract.abortThresholds.apiP95LatencyMs
        : contract.abortThresholds.webP95LatencyMs;
    if (percentile95(state.latencies) >= latencyThreshold) reject('observability_abort_latency');
    if (state.maximumFailures >= contract.abortThresholds.readinessConsecutiveFailures)
      reject('observability_abort_readiness');
    if (
      state.restarts.some((value, index) => index > 0 && value < state.restarts[index - 1]) ||
      state.restarts.at(-1) - state.restarts[0] > contract.abortThresholds.restartDelta
    )
      reject('observability_abort_restart');
  }
}

export function validateTimewebObservabilityEvidence(input, contractInput, expected) {
  const contract = validateTimewebObservabilityContract(contractInput);
  const evidence = object(input, 'observability_evidence');
  exactKeys(
    evidence,
    [
      'schema',
      'contractSchema',
      'source',
      'observedAt',
      'target',
      'monitoring',
      'observation',
      'rollback',
    ],
    'observability_evidence_keys',
  );
  if (evidence.schema !== 'PHUB_TIMEWEB_API_WEB_OBSERVABILITY_EVIDENCE_V1')
    reject('observability_evidence_schema');
  if (evidence.contractSchema !== contract.schema) reject('observability_evidence_contract_schema');
  if (
    !SHA.test(expected?.sourceSha ?? '') ||
    !SHA.test(expected?.sourceTree ?? '') ||
    typeof expected?.releaseId !== 'string' ||
    !new RegExp(`^${expected.sourceSha}-[0-9]{11,20}-1$`, 'u').test(expected.releaseId)
  )
    reject('observability_expected_identity');
  exactKeys(evidence.source, ['sha', 'tree', 'releaseId'], 'observability_evidence_source_keys');
  if (
    evidence.source.sha !== expected.sourceSha ||
    evidence.source.tree !== expected.sourceTree ||
    evidence.source.releaseId !== expected.releaseId
  )
    reject('observability_evidence_source_identity');
  const observedAt = timestamp(expected.observedAt, 'observability_expected_observed_at');
  const evaluatedAt = timestamp(expected.evaluatedAt, 'observability_expected_evaluated_at');
  const clockSkew = elapsedSeconds(evaluatedAt, observedAt);
  if (clockSkew < 0 || clockSkew > contract.observation.maximumObservedAtClockSkewSeconds)
    reject('observability_observed_at_clock');
  if (evidence.observedAt !== expected.observedAt)
    reject('observability_evidence_observed_at_identity');

  exactKeys(
    evidence.target,
    ['hostname', 'provider', 'serverId', 'projectId'],
    'observability_evidence_target',
  );
  if (Object.keys(contract.target).some((key) => evidence.target[key] !== contract.target[key]))
    reject('observability_evidence_target_identity');

  exactKeys(evidence.monitoring, ['monitors', 'alertTest'], 'observability_evidence_monitoring');
  if (!Array.isArray(evidence.monitoring.monitors) || evidence.monitoring.monitors.length !== 2)
    reject('observability_evidence_monitors');
  evidence.monitoring.monitors.forEach((monitor, index) =>
    validateMonitorEvidence(monitor, contract.monitoring.monitors[index], contract, observedAt),
  );
  validateAlertTest(evidence.monitoring.alertTest, contract, observedAt);

  exactKeys(
    evidence.observation,
    ['startedAt', 'endedAt', 'sources', 'samples'],
    'observability_evidence_observation',
  );
  const startedAt = timestamp(evidence.observation.startedAt, 'observability_observation_start');
  const endedAt = timestamp(evidence.observation.endedAt, 'observability_observation_end');
  const evidenceAge = elapsedSeconds(observedAt, endedAt);
  if (
    elapsedSeconds(endedAt, startedAt) < contract.observation.windowSeconds ||
    evidenceAge < 0 ||
    evidenceAge > contract.observation.maximumEvidenceAgeSeconds
  )
    reject('observability_observation_window');
  if (
    Object.keys(contract.observation.sources).some(
      (key) => evidence.observation.sources?.[key] !== contract.observation.sources[key],
    )
  )
    reject('observability_observation_sources');
  validateObservationSamples(
    evidence.observation.samples,
    contract,
    expected.releaseId,
    startedAt,
    endedAt,
  );

  exactKeys(
    evidence.rollback,
    [
      'controllerPath',
      'mode',
      'receiptPath',
      'receiptSha256',
      'mappingReadAt',
      'apiImage',
      'webImage',
    ],
    'observability_rollback_evidence',
  );
  if (
    evidence.rollback.controllerPath !== contract.rollback.controllerPath ||
    evidence.rollback.mode !== contract.rollback.mode ||
    evidence.rollback.receiptPath !== contract.rollback.receiptPath ||
    evidence.rollback.receiptSha256 !== expected.rollbackReceipt?.sha256 ||
    evidence.rollback.apiImage !== expected.rollbackReceipt?.priorApiReference ||
    evidence.rollback.webImage !== expected.rollbackReceipt?.priorWebReference
  )
    reject('observability_rollback_identity');
  const mappingReadAt = timestamp(
    evidence.rollback.mappingReadAt,
    'observability_rollback_read_at',
  );
  const rollbackAge = elapsedSeconds(observedAt, mappingReadAt);
  if (rollbackAge < 0 || rollbackAge > contract.rollback.maximumReadBackAgeSeconds)
    reject('observability_rollback_age');

  return {
    schema: 'PHUB_TIMEWEB_API_WEB_OBSERVABILITY_DIAGNOSTIC_V1',
    status: 'pass',
    target: contract.target.hostname,
    sourceSha: expected.sourceSha,
    sourceTree: expected.sourceTree,
    releaseId: expected.releaseId,
    observationWindowSeconds: contract.observation.windowSeconds,
    monitors: contract.monitoring.monitors.map(({ name }) => name),
    alertChannels: contract.alerting.deliveryChannels,
    rollbackReceipt: contract.rollback.receiptPath,
    valuesPrinted: false,
  };
}

function parseArguments(argv) {
  const result = { contract: DEFAULT_CONTRACT };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--contract-only') {
      if (result.contractOnly) reject('observability_arguments');
      result.contractOnly = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) reject('observability_arguments');
    const key = {
      '--contract': 'contract',
      '--evidence': 'evidence',
      '--expected-source-sha': 'sourceSha',
      '--expected-source-tree': 'sourceTree',
      '--expected-release-id': 'releaseId',
      '--observed-at': 'observedAt',
    }[flag];
    if (!key || result[key] !== undefined) reject('observability_arguments');
    result[key] = key === 'contract' || key === 'evidence' ? resolve(value) : value;
    index += 1;
  }
  const evidenceKeys = ['evidence', 'sourceSha', 'sourceTree', 'releaseId', 'observedAt'];
  if (result.contractOnly === true) {
    if (evidenceKeys.some((key) => result[key] !== undefined)) reject('observability_arguments');
  } else if (evidenceKeys.some((key) => result[key] === undefined)) {
    reject('observability_arguments');
  }
  return result;
}

function secureRootOwnedFile(path, expectedPath, code) {
  if (process.getuid?.() !== 0) reject('observability_evidence_root_required');
  if (resolve(path) !== expectedPath) reject(`${code}_path`);
  try {
    for (let directory = dirname(path); ; directory = dirname(directory)) {
      if (directory !== '/opt' && !directory.startsWith('/opt/')) reject(`${code}_custody`);
      const directoryValue = lstatSync(directory);
      if (
        !directoryValue.isDirectory() ||
        directoryValue.isSymbolicLink() ||
        directoryValue.uid !== 0 ||
        (directoryValue.mode & 0o022) !== 0 ||
        realpathSync(directory) !== directory
      )
        reject(`${code}_custody`);
      if (directory === '/opt') break;
    }
    const value = lstatSync(path);
    if (
      !value.isFile() ||
      value.isSymbolicLink() ||
      value.uid !== 0 ||
      (value.mode & 0o777) !== 0o600 ||
      value.nlink !== 1 ||
      realpathSync(path) !== path
    )
      reject(`${code}_custody`);
  } catch (error) {
    if (error instanceof TimewebObservabilityContractError) throw error;
    reject(`${code}_unavailable`);
  }
  return readFileSync(path);
}

function strictJsonBytes(bytes, code) {
  try {
    return parseStrictJson(bytes);
  } catch {
    reject(code);
  }
}

function readRollbackReceipt(contract, expected) {
  const receiptBytes = secureRootOwnedFile(
    contract.rollback.receiptPath,
    contract.rollback.receiptPath,
    'observability_rollback_receipt',
  );
  const receipt = strictJsonBytes(receiptBytes, 'observability_rollback_receipt_json');
  exactKeys(
    receipt,
    [
      'schema',
      'status',
      'hostname',
      'floorSourceSha',
      'floorSourceTree',
      'candidateSourceSha',
      'candidateSourceTree',
      'candidateReleaseId',
      'candidateRuntimeEnvRoot',
      'candidateReleaseEnv',
      'candidateReleaseEnvSha256',
      'priorApiReference',
      'priorWebReference',
      'candidateApiReference',
      'candidateWebReference',
      'activeCaddyfile',
      'activeCaddySha256',
      'activeCaddyAdaptedSha256',
      'backupCaddyfile',
      'backupCaddySha256',
      'publicCaddyfile',
      'publicCaddySha256',
      'publicCaddyAdaptedSha256',
      'applicationCompose',
      'ingressCompose',
      'rollbackEnv',
      'preparedAt',
      'complete',
    ],
    'observability_rollback_receipt_keys',
  );
  const floor = strictJsonFile(ROLLBACK_FLOOR, 'observability_rollback_floor_json');
  exactKeys(
    floor,
    [
      'schema',
      'hostname',
      'canonicalPublication',
      'authorizesPublication',
      'failedPublicationRunProvenance',
      'sourceSha',
      'sourceTree',
      'runtimeEnvRoot',
      'images',
    ],
    'observability_rollback_floor_keys',
  );
  exactKeys(
    floor.images,
    ['api', 'web', 'realtime', 'worker', 'migrator'],
    'observability_rollback_floor_images',
  );
  exactKeys(floor.images.api, ['indexDigest', 'runtimeDigest'], 'observability_rollback_floor_api');
  exactKeys(floor.images.web, ['indexDigest', 'runtimeDigest'], 'observability_rollback_floor_web');
  const priorApiReference = `ghcr.io/z6v6e6r/phub-api@${floor.images.api.indexDigest}`;
  const priorWebReference = `ghcr.io/z6v6e6r/phub-web@${floor.images.web.indexDigest}`;
  if (
    floor.schema !== 'PHUB_TIMEWEB_YANDEX_PUBLIC_ROLLBACK_FLOOR_V1' ||
    floor.hostname !== contract.target.hostname ||
    !SHA.test(floor.sourceSha ?? '') ||
    !SHA.test(floor.sourceTree ?? '') ||
    !DIGEST_REFERENCE.test(priorApiReference) ||
    !DIGEST_REFERENCE.test(priorWebReference) ||
    receipt.schema !== 'PHUB_TIMEWEB_YANDEX_PUBLIC_ROLLBACK_RECEIPT_V1' ||
    receipt.status !== 'PREPARED' ||
    receipt.complete !== true ||
    receipt.hostname !== contract.target.hostname ||
    receipt.floorSourceSha !== floor.sourceSha ||
    receipt.floorSourceTree !== floor.sourceTree ||
    receipt.candidateSourceSha !== expected.sourceSha ||
    receipt.candidateSourceTree !== expected.sourceTree ||
    receipt.candidateReleaseId !== expected.releaseId ||
    receipt.priorApiReference !== priorApiReference ||
    receipt.priorWebReference !== priorWebReference ||
    !DIGEST_REFERENCE.test(receipt.candidateApiReference ?? '') ||
    !DIGEST_REFERENCE.test(receipt.candidateWebReference ?? '')
  )
    reject('observability_rollback_receipt_identity');
  timestamp(receipt.preparedAt, 'observability_rollback_receipt_prepared_at');
  return {
    sha256: createHash('sha256').update(receiptBytes).digest('hex'),
    priorApiReference,
    priorWebReference,
  };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const contract = validateTimewebObservabilityContract(
    strictJsonFile(options.contract, 'observability_contract_json'),
  );
  if (options.contractOnly) {
    process.stdout.write(
      `${JSON.stringify({ schema: contract.schema, status: 'pass', valuesPrinted: false })}\n`,
    );
    return;
  }
  const authority = assertExactTimewebFrozenSource({
    expectedSourceSha: options.sourceSha,
    expectedSourceTree: options.sourceTree,
  });
  requireExactTimewebFrozenSourceAuthority(authority, {
    sourceSha: options.sourceSha,
    sourceTree: options.sourceTree,
  });
  const rollbackReceipt = readRollbackReceipt(contract, options);
  const diagnostic = validateTimewebObservabilityEvidence(
    strictJsonBytes(
      secureRootOwnedFile(options.evidence, contract.evidence.path, 'observability_evidence'),
      'observability_evidence_json',
    ),
    contract,
    { ...options, evaluatedAt: new Date().toISOString(), rollbackReceipt },
  );
  process.stdout.write(`${JSON.stringify(diagnostic)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const code =
      error instanceof TimewebObservabilityContractError
        ? error.code
        : error instanceof TimewebFrozenSourceError
          ? error.reason
          : 'unexpected_error';
    process.stderr.write(`${JSON.stringify({ status: 'fail', code })}\n`);
    process.exitCode = 1;
  }
}
