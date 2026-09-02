import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  atomicWriteTimewebObservabilityEvidence,
  buildTimewebObservabilityEvidence,
  collectTimewebObservationSamples,
  validateTimewebAlertReadback,
  validateTimewebMonitorReadback,
} from './produce-timeweb-api-web-observability-evidence.js';
import type {
  TimewebEvidenceBuildInput,
  TimewebObservationSample,
} from './produce-timeweb-api-web-observability-evidence.js';
import { parseStrictJson } from './strict-json.js';
import {
  validateTimewebObservabilityContract,
  validateTimewebObservabilityEvidence,
} from './verify-timeweb-api-web-observability.js';

const contract = validateTimewebObservabilityContract(
  parseStrictJson(readFileSync('deploy/timeweb/api-web-observability.v1.json')),
);
const sourceSha = '1'.repeat(40);
const sourceTree = '2'.repeat(40);
const releaseId = `${sourceSha}-12345678901-1`;
const observedAt = '2026-09-02T07:39:20.000Z';
const rollbackReceipt = {
  sha256: '5'.repeat(64),
  priorApiReference: `ghcr.io/z6v6e6r/phub-api@sha256:${'3'.repeat(64)}`,
  priorWebReference: `ghcr.io/z6v6e6r/phub-web@sha256:${'4'.repeat(64)}`,
};
const credentialShapedTestValue = `Basic ${Buffer.from('synthetic-forbidden-marker').toString(
  'base64',
)}`;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function monitor(providerMonitorId: string, name: string, url: string) {
  return {
    providerMonitorId,
    name,
    enabled: true,
    type: 'HTTPS',
    method: 'GET',
    url,
    expectedStatus: 200,
    regions: ['ru-1', 'nl-1'],
    intervalSeconds: 60,
    timeoutSeconds: 10,
    authorizationHeaderConfigured: true,
    lastCheckAt: '2026-09-02T07:39:00.000Z',
    successfulConsecutiveRounds: 3,
    activeIncidentCount: 0,
  };
}

function providerReadback() {
  const api = monitor(
    '26ed404e-98e5-45c5-98e3-31b9dfd6f0f2',
    'lk2-beta-api-ready',
    'https://lk2.padlhub.su/health/ready',
  );
  const web = monitor(
    'b25e28a0-02d8-49e4-a0a1-f49f62abc02c',
    'lk2-beta-web-root',
    'https://lk2.padlhub.su/',
  );
  return {
    schema: 'PHUB_TIMEWEB_MONITOR_READBACK_V1',
    source: 'timeweb-approved-read-only-readback',
    readAt: '2026-09-02T07:39:19.000Z',
    projectId: 262717,
    monitors: [api, web],
  };
}

function alertReadback() {
  return {
    schema: 'PHUB_TIMEWEB_ALERT_READBACK_V1',
    source: 'approved-delivery-and-provider-readback',
    testId: 'timeweb_incident_20260902',
    monitorNames: ['lk2-beta-api-ready', 'lk2-beta-web-root'],
    triggeredAt: '2026-09-02T07:25:00.000Z',
    deliveries: [
      { channel: 'email', deliveredAt: '2026-09-02T07:26:00.000Z' },
      { channel: 'telegram', deliveredAt: '2026-09-02T07:26:00.000Z' },
    ],
    acknowledgedAt: '2026-09-02T07:33:13.000Z',
    acknowledgementKind: 'release-owner-observed-active-incident',
    acknowledgedByRole: 'release-owner',
    recoveredAt: '2026-09-02T07:34:00.000Z',
    recoveryKind: 'provider-closed-after-all-regions-healthy',
    recoveryDeliveries: [
      { channel: 'email', deliveredAt: '2026-09-02T07:35:00.000Z' },
      { channel: 'telegram', deliveredAt: '2026-09-02T07:35:00.000Z' },
    ],
  };
}

function samples(): TimewebObservationSample[] {
  const startedAt = Date.parse('2026-09-02T07:24:00.000Z');
  return Array.from({ length: 66 }, (_, index) => ({
    at: new Date(startedAt + index * 14_000).toISOString(),
    services: [
      {
        service: 'api',
        releaseId,
        httpStatus: 200,
        latencyMs: 400,
        readinessOk: true,
        restartCount: 0,
      },
      {
        service: 'web',
        releaseId,
        httpStatus: 200,
        latencyMs: 250,
        readinessOk: true,
        restartCount: 0,
      },
    ],
  }));
}

function buildInput(): TimewebEvidenceBuildInput {
  return {
    contract,
    providerReadback: providerReadback(),
    alertReadback: alertReadback(),
    sourceSha,
    sourceTree,
    releaseId,
    observedAt,
    samples: samples(),
    mappingReadAt: '2026-09-02T07:39:19.000Z',
    rollbackReceipt,
  };
}

function createOutputFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phub-timeweb-observability-producer-')));
  temporaryRoots.push(root);
  const parent = join(root, 'phub', 'timeweb-beta', 'observability');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(join(root, 'phub'), 0o700);
  chmodSync(join(root, 'phub', 'timeweb-beta'), 0o700);
  chmodSync(parent, 0o700);
  return {
    root: resolve(root),
    parent,
    output: join(parent, 'api-web-evidence.json'),
    uid: process.getuid?.() ?? -1,
    gid: process.getgid?.() ?? -1,
  };
}

describe('Timeweb API/Web observability evidence producer', () => {
  it('normalizes the proven two-monitor contour and passes the existing verifier unchanged', () => {
    const evidence = buildTimewebObservabilityEvidence(buildInput());
    expect(evidence.monitoring.monitors.map(({ providerMonitorId }) => providerMonitorId)).toEqual([
      '26ed404e-98e5-45c5-98e3-31b9dfd6f0f2',
      'b25e28a0-02d8-49e4-a0a1-f49f62abc02c',
    ]);
    expect(evidence.monitoring.alertTest).toMatchObject({
      acknowledgedAt: '2026-09-02T07:33:13.000Z',
      acknowledgedByRole: 'release-owner',
      recoveredAt: '2026-09-02T07:34:00.000Z',
    });
    expect(
      validateTimewebObservabilityEvidence(evidence, contract, {
        sourceSha,
        sourceTree,
        releaseId,
        observedAt,
        evaluatedAt: '2026-09-02T07:39:21.000Z',
        rollbackReceipt,
      }),
    ).toMatchObject({ status: 'pass', valuesPrinted: false });
  });

  it.each([
    [
      'API monitor missing',
      (value: ReturnType<typeof providerReadback>) => {
        value.monitors.shift();
      },
    ],
    [
      'Web monitor missing',
      (value: ReturnType<typeof providerReadback>) => {
        value.monitors.pop();
      },
    ],
    [
      'wrong monitor ID',
      (value: ReturnType<typeof providerReadback>) => {
        value.monitors[0]!.providerMonitorId = 'wrong_api_monitor';
      },
    ],
    [
      'wrong monitor name',
      (value: ReturnType<typeof providerReadback>) => {
        value.monitors[1]!.name = 'wrong-web-name';
      },
    ],
    [
      'wrong project',
      (value: ReturnType<typeof providerReadback>) => {
        value.projectId = 1;
      },
    ],
    [
      'fewer than two locations',
      (value: ReturnType<typeof providerReadback>) => {
        value.monitors[0]!.regions = ['ru-1'];
      },
    ],
    [
      'unhealthy or disabled monitor',
      (value: ReturnType<typeof providerReadback>) => {
        value.monitors[0]!.enabled = false;
      },
    ],
    [
      'authorization header not configured',
      (value: ReturnType<typeof providerReadback>) => {
        value.monitors[0]!.authorizationHeaderConfigured = false;
      },
    ],
    [
      'stale provider observation',
      (value: ReturnType<typeof providerReadback>) => {
        value.readAt = '2026-09-02T07:38:49.000Z';
      },
    ],
  ])('fails closed when provider readback has %s', (_name, mutate) => {
    const value = providerReadback();
    mutate(value);
    expect(() => validateTimewebMonitorReadback(value, contract, observedAt)).toThrow();
  });

  it('rejects unknown fields and Basic credential material before normalization', () => {
    const provider = providerReadback() as ReturnType<typeof providerReadback> & {
      authorization?: string;
    };
    provider.authorization = credentialShapedTestValue;
    expect(() => validateTimewebMonitorReadback(provider, contract, observedAt)).toThrow(
      'producer_provider_readback_keys',
    );

    const alert = alertReadback() as ReturnType<typeof alertReadback> & { headerValue?: string };
    alert.headerValue = credentialShapedTestValue;
    expect(() => validateTimewebAlertReadback(alert, contract)).toThrow(
      'producer_alert_readback_keys',
    );
  });

  it.each([
    [
      'missing alert delivery',
      (value: ReturnType<typeof alertReadback>) => {
        value.deliveries.pop();
      },
      'observability_alert_delivery',
    ],
    [
      'missing recovery',
      (value: ReturnType<typeof alertReadback>) => {
        Reflect.deleteProperty(value, 'recoveredAt');
      },
      'producer_alert_readback_keys',
    ],
    [
      'invalid ACK latency',
      (value: ReturnType<typeof alertReadback>) => {
        value.acknowledgedAt = '2026-09-02T07:35:01.000Z';
        value.recoveredAt = '2026-09-02T07:36:00.000Z';
      },
      'observability_alert_acknowledgement',
    ],
    [
      'late recovery delivery',
      (value: ReturnType<typeof alertReadback>) => {
        value.recoveryDeliveries[0]!.deliveredAt = '2026-09-02T07:39:01.000Z';
      },
      'observability_alert_recovery_delivery',
    ],
  ])('fails closed for %s', (_name, mutate, code) => {
    const input = buildInput();
    mutate(input.alertReadback);
    expect(() => buildTimewebObservabilityEvidence(input)).toThrow(code);
  });

  it('does not permit a malformed or open evidence shape to pass the existing verifier', () => {
    const evidence = buildTimewebObservabilityEvidence(buildInput()) as unknown as Record<
      string,
      unknown
    >;
    evidence.authorization = credentialShapedTestValue;
    expect(() =>
      validateTimewebObservabilityEvidence(evidence, contract, {
        sourceSha,
        sourceTree,
        releaseId,
        observedAt,
        evaluatedAt: observedAt,
        rollbackReceipt,
      }),
    ).toThrow('observability_evidence_keys');
    expect(() => parseStrictJson('{"schema":')).toThrow();
  });

  it('collects a real-cadence 900-second window and detects container recreation', async () => {
    let wall = Date.parse('2026-09-02T07:24:00.000Z');
    let monotonic = 0;
    const collected = await collectTimewebObservationSamples({
      contract,
      releaseId,
      authorizationHeader: 'synthetic-redacted-header',
      now: () => wall,
      monotonicNow: () => monotonic,
      wait: (milliseconds) => {
        monotonic += milliseconds;
        wall += milliseconds;
        return Promise.resolve();
      },
      runProbe: () => Promise.resolve({ httpStatus: 200, latencyMs: 1, readinessOk: true }),
      inspectContainer: (service) => ({ id: `${service}-stable`, restartCount: 0 }),
    });
    expect(collected).toHaveLength(66);
    expect(Date.parse(collected.at(-1)!.at) - Date.parse(collected[0]!.at)).toBeGreaterThanOrEqual(
      900_000,
    );

    let apiReads = 0;
    await expect(
      collectTimewebObservationSamples({
        contract: {
          ...contract,
          observation: { ...contract.observation, windowSeconds: 14 },
        },
        releaseId,
        authorizationHeader: 'synthetic-redacted-header',
        now: () => wall,
        monotonicNow: () => monotonic,
        wait: (milliseconds) => {
          monotonic += milliseconds;
          wall += milliseconds;
          return Promise.resolve();
        },
        runProbe: () => Promise.resolve({ httpStatus: 200, latencyMs: 1, readinessOk: true }),
        inspectContainer: (service) => {
          if (service === 'api') apiReads += 1;
          return {
            id: service === 'api' && apiReads > 1 ? 'api-recreated' : `${service}-stable`,
            restartCount: 0,
          };
        },
      }),
    ).rejects.toThrow('producer_container_recreated');
  });

  it('atomically writes one 0600 single-link file', () => {
    const fixture = createOutputFixture();
    const evidence = buildTimewebObservabilityEvidence(buildInput());
    expect(
      atomicWriteTimewebObservabilityEvidence(evidence, {
        outputPath: fixture.output,
        expectedOutputPath: fixture.output,
        custodyRoot: fixture.root,
        expectedUid: fixture.uid,
        expectedGid: fixture.gid,
      }),
    ).toMatchObject({ status: 'written', mode: '0600', valuesPrinted: false });
    const stat = lstatSync(fixture.output);
    expect(stat.isFile()).toBe(true);
    expect(stat.nlink).toBe(1);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(parseStrictJson(readFileSync(fixture.output))).toEqual(evidence);
  });

  it('rejects symlink, hardlink and unsafe parent custody', () => {
    const evidence = buildTimewebObservabilityEvidence(buildInput());

    const symlink = createOutputFixture();
    const victim = join(symlink.parent, 'victim.json');
    writeFileSync(victim, '{}\n', { mode: 0o600 });
    symlinkSync(victim, symlink.output);
    expect(() =>
      atomicWriteTimewebObservabilityEvidence(evidence, {
        outputPath: symlink.output,
        expectedOutputPath: symlink.output,
        custodyRoot: symlink.root,
        expectedUid: symlink.uid,
        expectedGid: symlink.gid,
      }),
    ).toThrow('producer_output_custody');

    const hardlink = createOutputFixture();
    writeFileSync(hardlink.output, '{}\n', { mode: 0o600 });
    linkSync(hardlink.output, join(hardlink.parent, 'alias.json'));
    expect(() =>
      atomicWriteTimewebObservabilityEvidence(evidence, {
        outputPath: hardlink.output,
        expectedOutputPath: hardlink.output,
        custodyRoot: hardlink.root,
        expectedUid: hardlink.uid,
        expectedGid: hardlink.gid,
      }),
    ).toThrow('producer_output_custody');

    const unsafe = createOutputFixture();
    chmodSync(unsafe.parent, 0o770);
    expect(() =>
      atomicWriteTimewebObservabilityEvidence(evidence, {
        outputPath: unsafe.output,
        expectedOutputPath: unsafe.output,
        custodyRoot: unsafe.root,
        expectedUid: unsafe.uid,
        expectedGid: unsafe.gid,
      }),
    ).toThrow('producer_output_custody');
  });

  it('preserves the prior evidence and removes staging on a pre-commit failure', () => {
    const fixture = createOutputFixture();
    const prior = '{"prior":true}\n';
    writeFileSync(fixture.output, prior, { mode: 0o600 });
    expect(() =>
      atomicWriteTimewebObservabilityEvidence(buildTimewebObservabilityEvidence(buildInput()), {
        outputPath: fixture.output,
        expectedOutputPath: fixture.output,
        custodyRoot: fixture.root,
        expectedUid: fixture.uid,
        expectedGid: fixture.gid,
        beforeCommit: () => {
          throw new Error('injected');
        },
      }),
    ).toThrow('producer_output_write');
    expect(readFileSync(fixture.output, 'utf8')).toBe(prior);
    expect(readdirSync(dirname(fixture.output))).toEqual(['api-web-evidence.json']);
  });
});
