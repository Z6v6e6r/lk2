import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseStrictJson } from './strict-json.js';
import {
  validateTimewebObservabilityContract,
  validateTimewebObservabilityEvidence,
} from './verify-timeweb-api-web-observability.js';

const contractSource = parseStrictJson<unknown>(
  readFileSync('deploy/timeweb/api-web-observability.v1.json'),
);
const contract = validateTimewebObservabilityContract(contractSource);
const expected = {
  sourceSha: '1'.repeat(40),
  sourceTree: '2'.repeat(40),
  releaseId: `${'1'.repeat(40)}-12345678901-1`,
  observedAt: '2026-08-30T10:20:00.000Z',
  evaluatedAt: '2026-08-30T10:20:15.000Z',
  rollbackReceipt: {
    sha256: '5'.repeat(64),
    priorApiReference: `ghcr.io/z6v6e6r/phub-api@sha256:${'3'.repeat(64)}`,
    priorWebReference: `ghcr.io/z6v6e6r/phub-web@sha256:${'4'.repeat(64)}`,
  },
};

function monitor(name: string, service: 'api' | 'web', url: string) {
  return {
    name,
    service,
    providerMonitorId: `monitor_${service}_42`,
    enabled: true,
    type: 'HTTPS',
    method: 'GET',
    url,
    expectedStatus: 200,
    regions: ['ru-moscow', 'eu-amsterdam'],
    intervalSeconds: 60,
    timeoutSeconds: 10,
    authorizationHeaderConfigured: true,
    lastCheckAt: '2026-08-30T10:19:00.000Z',
    successfulConsecutiveRounds: 3,
    activeIncidentCount: 0,
  };
}

function evidence() {
  const samples = Array.from({ length: 61 }, (_, index) => ({
    at: new Date(Date.parse('2026-08-30T10:00:00.000Z') + index * 15_000).toISOString(),
    services: [
      {
        service: 'api',
        releaseId: expected.releaseId,
        httpStatus: 200,
        latencyMs: 400,
        readinessOk: true,
        restartCount: 0,
      },
      {
        service: 'web',
        releaseId: expected.releaseId,
        httpStatus: 200,
        latencyMs: 250,
        readinessOk: true,
        restartCount: 0,
      },
    ],
  }));
  return {
    schema: 'PHUB_TIMEWEB_API_WEB_OBSERVABILITY_EVIDENCE_V1',
    contractSchema: contract.schema,
    source: {
      sha: expected.sourceSha,
      tree: expected.sourceTree,
      releaseId: expected.releaseId,
    },
    observedAt: expected.observedAt,
    target: structuredClone(contract.target),
    monitoring: {
      monitors: [
        monitor('lk2-beta-api-ready', 'api', 'https://lk2.padlhub.su/health/ready'),
        monitor('lk2-beta-web-root', 'web', 'https://lk2.padlhub.su/'),
      ],
      alertTest: {
        testId: 'alert_test_20260830',
        monitorNames: ['lk2-beta-api-ready', 'lk2-beta-web-root'],
        triggeredAt: '2026-08-30T09:00:00.000Z',
        deliveries: [
          { channel: 'email', deliveredAt: '2026-08-30T09:01:00.000Z' },
          { channel: 'telegram', deliveredAt: '2026-08-30T09:02:00.000Z' },
        ],
        acknowledgedAt: '2026-08-30T09:05:00.000Z',
        acknowledgedByRole: 'release-owner',
        recoveredAt: '2026-08-30T09:06:00.000Z',
        recoveryDeliveries: [
          { channel: 'email', deliveredAt: '2026-08-30T09:07:00.000Z' },
          { channel: 'telegram', deliveredAt: '2026-08-30T09:08:00.000Z' },
        ],
      },
    },
    observation: {
      startedAt: '2026-08-30T10:00:00.000Z',
      endedAt: '2026-08-30T10:15:00.000Z',
      sources: {
        http: 'direct-api-web-probes',
        container: 'docker-inspect',
        readiness: 'direct-health-probes',
      },
      samples,
    },
    rollback: {
      controllerPath: 'scripts/control-timeweb-yandex-public-beta.js',
      mode: 'rollback',
      receiptPath: '/opt/phub/timeweb-beta/backups/yandex-public/receipt.json',
      receiptSha256: expected.rollbackReceipt.sha256,
      mappingReadAt: '2026-08-30T10:19:00.000Z',
      apiImage: expected.rollbackReceipt.priorApiReference,
      webImage: expected.rollbackReceipt.priorWebReference,
    },
  };
}

describe('Timeweb API/Web observability contract', () => {
  it('accepts the canonical source contract and complete bounded evidence', () => {
    expect(validateTimewebObservabilityEvidence(evidence(), contract, expected)).toMatchObject({
      status: 'pass',
      valuesPrinted: false,
      observationWindowSeconds: 900,
      alertChannels: ['email', 'telegram'],
    });
  });

  it('rejects threshold or observation-window drift in the source contract', () => {
    const thresholdDrift = structuredClone(contractSource) as {
      abortThresholds: { apiP95LatencyMs: number };
    };
    thresholdDrift.abortThresholds.apiP95LatencyMs = 5000;
    expect(() => validateTimewebObservabilityContract(thresholdDrift)).toThrow(
      'observability_threshold_policy',
    );

    const windowDrift = structuredClone(contractSource) as {
      observation: { windowSeconds: number };
    };
    windowDrift.observation.windowSeconds = 60;
    expect(() => validateTimewebObservabilityContract(windowDrift)).toThrow(
      'observability_observation_policy',
    );
  });

  it('rejects missing multi-region or Basic-header configuration evidence', () => {
    const missingRegion = evidence();
    missingRegion.monitoring.monitors[0]!.regions = ['ru-moscow'];
    expect(() => validateTimewebObservabilityEvidence(missingRegion, contract, expected)).toThrow(
      'observability_evidence_regions',
    );

    const missingHeader = evidence();
    missingHeader.monitoring.monitors[0]!.authorizationHeaderConfigured = false;
    expect(() => validateTimewebObservabilityEvidence(missingHeader, contract, expected)).toThrow(
      'observability_evidence_monitor_configuration',
    );
  });

  it('rejects stale provider or rollback read-back', () => {
    const staleMonitor = evidence();
    staleMonitor.monitoring.monitors[0]!.lastCheckAt = '2026-08-30T10:17:00.000Z';
    expect(() => validateTimewebObservabilityEvidence(staleMonitor, contract, expected)).toThrow(
      'observability_evidence_last_check_age',
    );

    const staleRollback = evidence();
    staleRollback.rollback.mappingReadAt = '2026-08-30T10:14:59.000Z';
    expect(() => validateTimewebObservabilityEvidence(staleRollback, contract, expected)).toThrow(
      'observability_rollback_age',
    );
  });

  it('rejects active incidents and every quantitative service abort boundary', () => {
    const activeIncident = evidence();
    activeIncident.monitoring.monitors[0]!.activeIncidentCount = 1;
    expect(() => validateTimewebObservabilityEvidence(activeIncident, contract, expected)).toThrow(
      'observability_abort_active_incident',
    );

    const serverErrors = evidence();
    serverErrors.observation.samples[0]!.services[0]!.httpStatus = 500;
    serverErrors.observation.samples[0]!.services[0]!.readinessOk = false;
    expect(() => validateTimewebObservabilityEvidence(serverErrors, contract, expected)).toThrow(
      'observability_abort_server_errors',
    );

    const latency = evidence();
    for (const sample of latency.observation.samples.slice(-4)) {
      sample.services[0]!.latencyMs = 1500;
    }
    expect(() => validateTimewebObservabilityEvidence(latency, contract, expected)).toThrow(
      'observability_abort_latency',
    );

    const readiness = evidence();
    for (const sample of readiness.observation.samples.slice(0, 2)) {
      sample.services[0]!.httpStatus = 429;
      sample.services[0]!.readinessOk = false;
    }
    expect(() => validateTimewebObservabilityEvidence(readiness, contract, expected)).toThrow(
      'observability_abort_readiness',
    );

    const restart = evidence();
    restart.observation.samples.at(-1)!.services[0]!.restartCount = 1;
    expect(() => validateTimewebObservabilityEvidence(restart, contract, expected)).toThrow(
      'observability_abort_restart',
    );
  });

  it('rejects incomplete alert delivery, late acknowledgement and late recovery delivery', () => {
    const incomplete = evidence();
    incomplete.monitoring.alertTest.deliveries.pop();
    expect(() => validateTimewebObservabilityEvidence(incomplete, contract, expected)).toThrow(
      'observability_alert_delivery',
    );

    const lateAcknowledgement = evidence();
    lateAcknowledgement.monitoring.alertTest.acknowledgedAt = '2026-08-30T09:10:01.000Z';
    lateAcknowledgement.monitoring.alertTest.recoveredAt = '2026-08-30T09:11:00.000Z';
    expect(() =>
      validateTimewebObservabilityEvidence(lateAcknowledgement, contract, expected),
    ).toThrow('observability_alert_acknowledgement');

    const lateRecovery = evidence();
    lateRecovery.monitoring.alertTest.recoveryDeliveries[0]!.deliveredAt =
      '2026-08-30T09:11:01.000Z';
    expect(() => validateTimewebObservabilityEvidence(lateRecovery, contract, expected)).toThrow(
      'observability_alert_recovery_delivery',
    );
  });

  it('rejects source identity drift, mutable rollback images and unexpected evidence keys', () => {
    const wrongSource = evidence();
    wrongSource.source.sha = '9'.repeat(40);
    expect(() => validateTimewebObservabilityEvidence(wrongSource, contract, expected)).toThrow(
      'observability_evidence_source_identity',
    );

    const mutableRollback = evidence();
    mutableRollback.rollback.apiImage = 'ghcr.io/z6v6e6r/phub-api:latest';
    expect(() => validateTimewebObservabilityEvidence(mutableRollback, contract, expected)).toThrow(
      'observability_rollback_identity',
    );

    const extraKey = evidence();
    const extraMonitor = extraKey.monitoring.monitors[0] as Record<string, unknown>;
    extraMonitor.authorization = 'forbidden-secret-value';
    expect(() => validateTimewebObservabilityEvidence(extraKey, contract, expected)).toThrow(
      'observability_evidence_monitor_keys',
    );
  });

  it('rejects replayed observation time, sample gaps and rollback receipt drift', () => {
    const replayedExpected = {
      ...expected,
      evaluatedAt: '2026-08-30T10:20:31.000Z',
    };
    expect(() =>
      validateTimewebObservabilityEvidence(evidence(), contract, replayedExpected),
    ).toThrow('observability_observed_at_clock');

    const gap = evidence();
    gap.observation.samples[1]!.at = '2026-08-30T10:00:16.000Z';
    expect(() => validateTimewebObservabilityEvidence(gap, contract, expected)).toThrow(
      'observability_sample_cadence',
    );

    const receiptDrift = evidence();
    receiptDrift.rollback.receiptSha256 = '6'.repeat(64);
    expect(() => validateTimewebObservabilityEvidence(receiptDrift, contract, expected)).toThrow(
      'observability_rollback_identity',
    );
  });
});
