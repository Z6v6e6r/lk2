import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseStrictJson } from './strict-json.js';
import { validateTimewebObservabilityContract } from './verify-timeweb-api-web-observability.js';
import {
  deriveTimewebObservabilityReadbacks,
  parseTimewebCaptureBundle,
  type TimewebCaptureAdapter,
} from './timeweb-observability-capture-bundle.js';

const contract = validateTimewebObservabilityContract(
  parseStrictJson(readFileSync('deploy/timeweb/api-web-observability.v1.json')),
);
const observedAt = '2026-10-11T07:20:05.000Z';
const monitorIds = ['26ed404e-98e5-45c5-98e3-31b9dfd6f0f2', 'b25e28a0-02d8-49e4-a0a1-f49f62abc02c'];
const testId = 'synthetic-alert-test-1';
const names = contract.monitoring.monitors.map((m) => m.name);
interface Envelope {
  role: string;
  kind: string;
  tool: string;
  callId: string;
  reader: string;
  source: { origin: string; immutableId: string; url: string | null };
  capturedAt: string;
  rawFile: string;
  rawSize: number;
  rawSha256: string;
}
interface SyntheticRaw {
  format: string;
  origin: string;
  immutableId: string;
  capturedAt: string;
  data: Record<string, unknown>;
}
function hash(raw: Uint8Array) {
  return createHash('sha256').update(raw).digest('hex');
}

// Fixture adapter is confined to tests; production registry remains empty.
const synthetic: TimewebCaptureAdapter = (raw) => {
  const parsed = parseStrictJson<SyntheticRaw>(raw);
  if (parsed.format !== 'SYNTHETIC_TEST_CAPTURE') throw new Error('unknown fixture schema');
  return {
    origin: parsed.origin,
    immutableId: parsed.immutableId,
    capturedAt: parsed.capturedAt,
    data: parsed.data,
  };
};
const adapters = Object.fromEntries(
  ['timeweb-panel', 'gmail-channel', 'telegram-channel', 'release-owner-reply'].map((kind) => [
    kind,
    synthetic,
  ]),
);
function fixture() {
  const captures: Envelope[] = [];
  const files = new Map<string, Uint8Array>();
  const add = (role: string, kind: string, capturedAt: string, data: Record<string, unknown>) => {
    const origins: Record<string, string> = {
      'timeweb-panel': 'https://timeweb.cloud',
      'gmail-channel': 'gmail-connector',
      'telegram-channel': 'telegram-account-ui',
      'release-owner-reply': 'codex-owner-reply',
    };
    const tools: Record<string, string> = {
      'timeweb-panel': 'cua',
      'gmail-channel': 'gmail',
      'telegram-channel': 'cua',
      'release-owner-reply': 'owner-chat',
    };
    const immutableId = `${role}-source-id`;
    const raw = Buffer.from(
      JSON.stringify({
        format: 'SYNTHETIC_TEST_CAPTURE',
        origin: origins[kind],
        immutableId,
        capturedAt,
        data,
      }),
    );
    const rawFile = `raw/${role}.bin`;
    captures.push({
      role,
      kind,
      tool: tools[kind]!,
      callId: `synthetic-call-${role}`,
      reader: 'approved-reader',
      source: {
        origin: origins[kind]!,
        immutableId,
        url: kind === 'timeweb-panel' ? 'https://timeweb.cloud/my/synthetic-monitoring' : null,
      },
      capturedAt,
      rawFile,
      rawSize: raw.length,
      rawSha256: hash(raw),
    });
    files.set(rawFile, raw);
  };
  for (let i = 1; i <= 3; i++) {
    const minute = 16 + i;
    add(`monitor-round-${i}`, 'timeweb-panel', `2026-10-11T07:${minute + 1}:00.000Z`, {
      projectId: 262717,
      monitors: contract.monitoring.monitors.map((m, index) => ({
        providerMonitorId: monitorIds[index],
        name: m.name,
        enabled: true,
        type: m.type,
        method: m.method,
        url: m.url,
        expectedStatus: m.expectedStatus,
        regions: ['synthetic-msk', 'synthetic-spb'],
        intervalSeconds: 60,
        timeoutSeconds: 10,
        authorizationHeaderConfigured: true,
        lastCheckAt: `2026-10-11T07:${minute}:59.000Z`,
        previousCheckAt: `2026-10-11T07:${minute - 1}:59.000Z`,
        roundHealthy: true,
        activeIncidentCount: 0,
      })),
    });
  }
  add('incident-active', 'timeweb-panel', '2026-10-11T07:10:25.000Z', {
    projectId: 262717,
    testId,
    monitorNames: names,
    status: 'active',
    triggeredAt: '2026-10-11T07:10:00.000Z',
  });
  add('incident-closed', 'timeweb-panel', '2026-10-11T07:11:05.000Z', {
    projectId: 262717,
    testId,
    monitorNames: names,
    status: 'closed',
    triggeredAt: '2026-10-11T07:10:00.000Z',
    recoveredAt: '2026-10-11T07:11:00.000Z',
    allRegionsHealthy: true,
  });
  for (const channel of ['email', 'telegram']) {
    for (const event of ['alert', 'recovery']) {
      const minute = event === 'alert' ? '10' : '11';
      const role = `${channel}-${event}`;
      add(
        role,
        channel === 'email' ? 'gmail-channel' : 'telegram-channel',
        `2026-10-11T07:${minute}:20.000Z`,
        {
          testId,
          monitorNames: names,
          channel,
          event,
          deliveredAt: `2026-10-11T07:${minute}:15.000Z`,
          messageId: `${role}-source-id`,
          completeSearch: true,
          senderVerified: true,
          receiverVerified: true,
        },
      );
    }
  }
  add('owner-active-reply', 'release-owner-reply', '2026-10-11T07:10:30.000Z', {
    testId,
    role: 'release-owner',
    acknowledgedAt: '2026-10-11T07:10:30.000Z',
    replyId: 'owner-active-reply-source-id',
  });
  const manifest = {
    schema: 'PHUB_TIMEWEB_PRIVATE_CAPTURE_BUNDLE_V1',
    target: { hostname: 'lk2.padlhub.su', serverId: 8886471, projectId: 262717 },
    reader: 'approved-reader',
    captures,
  };
  const editRaw = (role: string, mutate: (raw: SyntheticRaw) => void) => {
    const envelope = captures.find((c) => c.role === role)!;
    const raw = parseStrictJson<SyntheticRaw>(files.get(envelope.rawFile)!);
    mutate(raw);
    const bytes = Buffer.from(JSON.stringify(raw));
    files.set(envelope.rawFile, bytes);
    envelope.rawSize = bytes.length;
    envelope.rawSha256 = hash(bytes);
  };
  const derive = (at = observedAt) =>
    deriveTimewebObservabilityReadbacks(JSON.stringify(manifest), files, contract, at, adapters);
  return { manifest, files, editRaw, derive };
}

describe('Timeweb private capture preparation', () => {
  it('keeps the operational default closed even for a complete synthetic bundle', () => {
    const f = fixture();
    expect(() =>
      deriveTimewebObservabilityReadbacks(
        JSON.stringify(f.manifest),
        f.files,
        contract,
        observedAt,
      ),
    ).toThrow('capture_adapter_unavailable');
  });
  it('derives exact existing V1 readbacks from test-only raw adapters', () => {
    const result = fixture().derive();
    expect(result.captureCount).toBe(10);
    expect(result.operationalWriter).toBe(false);
    expect(result.monitorReadback.monitors.map((m) => m.successfulConsecutiveRounds)).toEqual([
      3, 3,
    ]);
    expect(result.alertReadback.deliveries).toHaveLength(2);
  });
  it.each([
    'monitors',
    'deliveries',
    'readAt',
    'successfulConsecutiveRounds',
    'adapterPath',
    'authorizationHeaderConfigured',
    'PASS',
  ])('rejects input override %s', (field) => {
    const f = fixture();
    Object.assign(f.manifest, { [field]: true });
    expect(f.derive).toThrow('capture_fields');
  });
  it('rejects duplicate JSON keys, unknown schema and extra/missing files', () => {
    const f = fixture();
    const json = JSON.stringify(f.manifest);
    expect(() =>
      parseTimewebCaptureBundle(
        json.replace('"schema":', '"schema":"duplicate","schema":'),
        f.files,
      ),
    ).toThrow('capture_json');
    f.manifest.schema = 'unknown';
    expect(f.derive).toThrow('capture_identity');
    const extra = fixture();
    extra.files.set('private-export', Buffer.from('synthetic'));
    expect(extra.derive).toThrow('capture_file_closure');
    const missing = fixture();
    missing.files.delete('raw/email-alert.bin');
    expect(missing.derive).toThrow('capture_raw_hash');
  });
  it('rejects raw byte corruption, path traversal, wrong origin and credential-bearing URL', () => {
    const f = fixture();
    f.files.set('raw/email-alert.bin', Buffer.from('corrupt'));
    expect(f.derive).toThrow('capture_raw_hash');
    for (const mutate of [
      (c: Envelope) => {
        c.rawFile = '../raw';
      },
      (c: Envelope) => {
        c.source.origin = 'https://other.invalid';
      },
      (c: Envelope) => {
        c.source.url = 'https://root:synthetic@timeweb.cloud/my';
      },
    ]) {
      const bad = fixture();
      mutate(bad.manifest.captures[0]!);
      expect(bad.derive).toThrow();
    }
  });
  it.each(['origin', 'immutableId', 'capturedAt'])(
    'rejects raw/envelope disagreement %s',
    (key) => {
      const f = fixture();
      f.editRaw('email-alert', (raw) => {
        raw[key as 'origin'] = 'different';
      });
      expect(f.derive).toThrow('capture_raw_identity');
    },
  );
  it('redacts adapter failures and rejects unsupported raw format', () => {
    const f = fixture();
    f.editRaw('email-alert', (r) => {
      r.format = 'unknown SECRET_CANARY';
    });
    expect(f.derive).toThrow('capture_parse_failed');
    try {
      f.derive();
    } catch (error) {
      expect(String(error)).not.toContain('SECRET_CANARY');
    }
  });
  it.each([
    'providerMonitorId',
    'name',
    'regions',
    'authorizationHeaderConfigured',
    'intervalSeconds',
    'expectedStatus',
  ])('rejects monitor configuration drift %s', (key) => {
    const f = fixture();
    f.editRaw('monitor-round-2', (r) => {
      const monitors = r.data.monitors as Array<Record<string, unknown>>;
      monitors[0]![key] = key === 'regions' ? ['other'] : false;
    });
    expect(f.derive).toThrow();
  });
  it('rejects repeated/missing provider checks and unhealthy/active rounds', () => {
    for (const key of ['lastCheckAt', 'previousCheckAt', 'roundHealthy', 'activeIncidentCount']) {
      const f = fixture();
      f.editRaw('monitor-round-2', (r) => {
        const m = (r.data.monitors as Array<Record<string, unknown>>)[0]!;
        m[key] =
          key === 'roundHealthy'
            ? false
            : key === 'activeIncidentCount'
              ? 1
              : key === 'previousCheckAt'
                ? '2026-10-11T07:16:59.000Z'
                : '2026-10-11T07:17:59.000Z';
      });
      expect(f.derive).toThrow();
    }
  });
  it.each([
    'testId',
    'messageId',
    'completeSearch',
    'senderVerified',
    'receiverVerified',
    'channel',
  ])('rejects uncorrelated or incomplete delivery %s', (key) => {
    const f = fixture();
    f.editRaw('email-alert', (r) => {
      r.data[key] = key.endsWith('Verified') || key === 'completeSearch' ? false : 'different';
    });
    expect(f.derive).toThrow('capture_delivery_identity');
  });
  it.each(['testId', 'role', 'replyId', 'acknowledgedAt'])(
    'requires the actual active-incident owner reply %s',
    (key) => {
      const f = fixture();
      f.editRaw('owner-active-reply', (r) => {
        r.data[key] = 'different';
      });
      expect(f.derive).toThrow();
    },
  );
  it('rejects future and stale final capture, stale alerts and delivery beyond deadline', () => {
    expect(() => fixture().derive('2026-10-11T07:19:59.000Z')).toThrow('capture_future');
    expect(() => fixture().derive('2026-10-11T07:20:31.000Z')).toThrow('capture_final_round_stale');
    const late = fixture();
    late.editRaw('email-alert', (r) => {
      r.data.deliveredAt = '2026-10-11T07:16:00.000Z';
      r.capturedAt = '2026-10-11T07:16:00.000Z';
    });
    late.manifest.captures.find((c) => c.role === 'email-alert')!.capturedAt =
      '2026-10-11T07:16:00.000Z';
    expect(late.derive).toThrow();
  });
});
