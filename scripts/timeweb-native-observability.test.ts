import { describe, expect, it } from 'vitest';
import {
  deriveNativeMonitorReadback,
  verifyNativeMonitorReadback,
  redactNativeProbeResponse,
  NATIVE_MONITORS,
  REDACTED_PRESENT,
} from './timeweb-native-observability.js';

import { NOW, SOURCE, fixture } from './timeweb-native-observability-fixtures.js';

function derive(value: ReturnType<typeof fixture>) {
  return deriveNativeMonitorReadback(JSON.stringify(value.bundle), NOW, SOURCE);
}

describe('native Timeweb facts preserve provider HTTP_2XX semantics', () => {
  it('derives the exact native configuration, aligned online samples and complete zero-active inventory', () => {
    const f = fixture();
    f.config.probes.reverse();
    const result = derive(f);
    expect(result.schema).toBe('PHUB_TIMEWEB_MONITOR_READBACK_V2');
    expect(result.monitors.map((row) => row.service)).toEqual(['api', 'web']);
    for (const monitor of result.monitors) {
      expect(monitor.providerSuccessPolicy).toBe('HTTP_2XX');
      expect(monitor).not.toHaveProperty('expectedStatus');
      expect(monitor.nativeHistory).toHaveLength(3);
      expect(monitor.activeIncidentCount).toBe(0);
    }
    expect(verifyNativeMonitorReadback(result, JSON.stringify(f.bundle), NOW, SOURCE)).toEqual(
      result.monitors,
    );
  });
  it('redacts the existing Authorization value before capture persistence without changing input', () => {
    const f = fixture();
    for (const probe of f.config.probes)
      probe.parameters.request_headers.Authorization = 'Basic synthetic-private-fixture';
    const redacted = redactNativeProbeResponse(f.config);
    expect(JSON.stringify(redacted)).not.toContain('synthetic-private-fixture');
    expect(f.config.probes[0]!.parameters.request_headers.Authorization).toContain(
      'synthetic-private-fixture',
    );
    expect(JSON.stringify(redacted)).toContain(REDACTED_PRESENT);
    expect(() => derive(f)).toThrow(/credential_contamination/);
  });
  const negatives: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    [
      'wrong source',
      (f) => {
        f.bundle.producerSourceSha = 'b'.repeat(40);
      },
    ],
    [
      'unapproved reader',
      (f) => {
        f.bundle.readerAuditId = 'invented-reader';
      },
    ],
    [
      'future configuration',
      (f) => {
        f.config.probes[0]!.updated_at = '2026-11-14T12:00:31.000Z';
      },
    ],
    [
      'future incident',
      (f) => {
        f.incApi.incidents[0]!.last_seen_at = '2026-11-14T12:00:31.000Z';
      },
    ],
    [
      'wrong target',
      (f) => {
        f.bundle.target.serverId = 1;
      },
    ],
    [
      'stale capture',
      (f) => {
        f.bundle.captures[0]!.capturedAt = '2026-11-14T11:59:59.000Z';
      },
    ],
    [
      'future capture',
      (f) => {
        f.bundle.captures[0]!.capturedAt = '2026-11-14T12:00:31.000Z';
      },
    ],
    [
      'wrong origin',
      (f) => {
        f.bundle.captures[0]!.url = 'https://other.invalid/api/v1/probes?limit=10000&offset=0';
      },
    ],
    [
      'duplicate capture',
      (f) => {
        f.bundle.captures[1]!.toolCallId = f.bundle.captures[0]!.toolCallId;
      },
    ],
    [
      'duplicate response',
      (f) => {
        f.statsApi.response_id = f.config.response_id;
      },
    ],
    [
      'missing role',
      (f) => {
        f.bundle.captures.pop();
      },
    ],
    [
      'arbitrary projection',
      (f) => {
        f.bundle.captures[1]!.projection = 'operator-pass';
      },
    ],
    [
      'partial monitor inventory',
      (f) => {
        f.config.meta.total = 3;
      },
    ],
    [
      'duplicate monitor',
      (f) => {
        f.config.probes[1]!.id = f.config.probes[0]!.id;
      },
    ],
    [
      'disabled probe',
      (f) => {
        f.config.probes[0]!.enabled = false;
      },
    ],
    [
      'wrong URL',
      (f) => {
        f.config.probes[0]!.host += 'other';
      },
    ],
    [
      'wrong method',
      (f) => {
        f.config.probes[0]!.parameters.request_method = 'HEAD';
      },
    ],
    [
      'missing authorization',
      (f) => {
        f.config.probes[0]!.parameters.request_headers.Authorization = '';
      },
    ],
    [
      'extra header',
      (f) => {
        Object.assign(f.config.probes[0]!.parameters.request_headers, { Host: 'other.invalid' });
      },
    ],
    [
      'claim exact provider 200',
      (f) => {
        Object.assign(f.config.probes[0]!, { expectedStatus: 200 });
      },
    ],
    [
      'missing region',
      (f) => {
        f.statsApi.probe_statistics.statistics.pop();
      },
    ],
    [
      'duplicate region',
      (f) => {
        f.statsApi.probe_statistics.statistics[1]!.name = 'ru-1';
      },
    ],
    [
      'offline sample',
      (f) => {
        f.statsApi.probe_statistics.statistics[0]!.list[7]!.status = 'offline';
      },
    ],
    [
      'misaligned regions',
      (f) => {
        f.statsApi.probe_statistics.statistics[0]!.list[7]!.time = '2026-11-14T12:00:01.000Z';
      },
    ],
    [
      'nonadvancing history',
      (f) => {
        const list = f.statsApi.probe_statistics.statistics[0]!.list;
        list[7]!.time = list[6]!.time;
      },
    ],
    [
      'truncated tail',
      (f) => {
        f.statsApi.probe_statistics.statistics[0]!.list.shift();
      },
    ],
    [
      'incomplete incidents',
      (f) => {
        f.incApi.meta.total = 2;
      },
    ],
    [
      'active incident',
      (f) => {
        f.incApi.incidents[0]!.status = 'OPEN';
      },
    ],
    [
      'wrong incident target',
      (f) => {
        f.incApi.incidents[0]!.probe_id = NATIVE_MONITORS[1]!.id;
      },
    ],
    [
      'duplicate incident',
      (f) => {
        f.incApi.incidents.push(structuredClone(f.incApi.incidents[0]!));
        f.incApi.meta.total++;
      },
    ],
    [
      'credential contamination',
      (f) => {
        f.config.probes[0]!.description = 'auth_hash=synthetic-sensitive-link';
      },
    ],
  ];
  it.each(negatives)('rejects %s before canonical publication', (_name, mutate) => {
    const f = fixture();
    mutate(f);
    expect(() => derive(f)).toThrow(/native_observability_/);
  });
  it('rejects an already-redacted value at the in-memory capture boundary', () => {
    expect(() => redactNativeProbeResponse(fixture().config)).toThrow(
      /authorization_not_configured/,
    );
  });
  it('retains the complete history and tolerates older offline points outside the final rounds', () => {
    const f = fixture();
    for (const region of f.statsApi.probe_statistics.statistics) {
      region.list.unshift({ value: 0, time: '2026-11-14T11:52:00.000Z', status: 'offline' });
      region.meta.amount++;
    }
    expect(derive(f).monitors[0]!.successfulConsecutiveRounds).toBe(3);
    f.statsApi.probe_statistics.statistics[0]!.meta.amount++;
    expect(() => derive(f)).toThrow(/history_length/);
  });
  it('revalidates a sealed capture at its original readAt without refreshing timestamps', () => {
    const f = fixture();
    const bytes = JSON.stringify(f.bundle);
    const result = derive(f);
    expect(verifyNativeMonitorReadback(result, bytes, result.readAt, SOURCE)).toEqual(
      result.monitors,
    );
  });
  it('rejects a changed canonical readback or substituted raw bundle', () => {
    const f = fixture(),
      bytes = JSON.stringify(f.bundle),
      result = derive(f);
    expect(() =>
      verifyNativeMonitorReadback({ ...result, readAt: NOW }, bytes, NOW, SOURCE),
    ).toThrow(/readback_drift/);
    expect(() => verifyNativeMonitorReadback(result, bytes + ' ', NOW, SOURCE)).toThrow(
      /readback_identity/,
    );
  });
});
