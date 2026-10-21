// Pure preparation boundary. This module has no filesystem writer, network or CLI.
import { createHash } from 'node:crypto';
import { parseStrictJson } from './strict-json.js';
import { validateUpgradeMonitoring } from './timeweb-api-web-upgrade.js';

const TARGET = Object.freeze({ hostname: 'lk2.padlhub.su', serverId: 8886471, projectId: 262717 });
const ROLES = Object.freeze([
  'monitor-round-1',
  'monitor-round-2',
  'monitor-round-3',
  'incident-active',
  'incident-closed',
  'email-alert',
  'email-recovery',
  'telegram-alert',
  'telegram-recovery',
  'owner-active-reply',
]);
const EMPTY_ADAPTERS = Object.freeze({});
const ID = /^[A-Za-z0-9_.:-]{1,160}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MONITOR_KEYS = [
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
  'previousCheckAt',
  'roundHealthy',
  'activeIncidentCount',
];

export class TimewebCaptureError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TimewebCaptureError';
    this.code = code;
  }
}
function fail(code) {
  throw new TimewebCaptureError(code);
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function exact(value, keys, code = 'capture_fields') {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !same(Object.keys(value).sort(), [...keys].sort())
  )
    fail(code);
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    fail('capture_timestamp');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) fail('capture_timestamp');
  return ms;
}
function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function kind(role) {
  if (role.startsWith('email-')) return 'gmail-channel';
  if (role.startsWith('telegram-')) return 'telegram-channel';
  if (role === 'owner-active-reply') return 'release-owner-reply';
  return 'timeweb-panel';
}
function validateSource(capture) {
  const origins = {
    'timeweb-panel': 'https://timeweb.cloud',
    'gmail-channel': 'gmail-connector',
    'telegram-channel': 'telegram-account-ui',
    'release-owner-reply': 'codex-owner-reply',
  };
  const tools = {
    'timeweb-panel': 'cua',
    'gmail-channel': 'gmail',
    'telegram-channel': 'cua',
    'release-owner-reply': 'owner-chat',
  };
  exact(capture.source, ['origin', 'immutableId', 'url']);
  if (
    capture.source.origin !== origins[capture.kind] ||
    capture.tool !== tools[capture.kind] ||
    !ID.test(capture.source.immutableId ?? '')
  )
    fail('capture_source');
  if (capture.kind === 'timeweb-panel' && capture.source.url === null) fail('capture_source_url');
  if (capture.source.url !== null) {
    let url;
    try {
      url = new URL(capture.source.url);
    } catch {
      fail('capture_source_url');
    }
    const expected = {
      'timeweb-panel': 'https://timeweb.cloud',
      'gmail-channel': 'https://mail.google.com',
      'telegram-channel': 'https://web.telegram.org',
    }[capture.kind];
    if (
      !expected ||
      url.origin !== expected ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      fail('capture_source_url');
  }
}

// Hashes and tool-call pointers provide custody/audit links; they do not authenticate origin.
// Files are in-memory raw byte exports, not paths opened by this library.
export function parseTimewebCaptureBundle(manifestBytes, files) {
  if (
    !(typeof manifestBytes === 'string' || manifestBytes instanceof Uint8Array) ||
    Buffer.byteLength(manifestBytes) > 64 * 1024
  )
    fail('capture_manifest_size');
  let manifest;
  try {
    manifest = parseStrictJson(manifestBytes);
  } catch {
    fail('capture_json');
  }
  exact(manifest, ['schema', 'target', 'reader', 'captures']);
  if (
    manifest.schema !== 'PHUB_TIMEWEB_PRIVATE_CAPTURE_BUNDLE_V1' ||
    !same(manifest.target, TARGET) ||
    !ID.test(manifest.reader ?? '') ||
    !Array.isArray(manifest.captures) ||
    manifest.captures.length !== ROLES.length ||
    !(files instanceof Map)
  )
    fail('capture_identity');
  exact(manifest.target, Object.keys(TARGET));
  const captures = new Map();
  let total = 0;
  for (const capture of manifest.captures) {
    exact(capture, [
      'role',
      'kind',
      'tool',
      'callId',
      'reader',
      'source',
      'capturedAt',
      'rawFile',
      'rawSize',
      'rawSha256',
    ]);
    if (
      !ROLES.includes(capture.role) ||
      captures.has(capture.role) ||
      capture.kind !== kind(capture.role) ||
      capture.reader !== manifest.reader ||
      !ID.test(capture.callId ?? '') ||
      capture.rawFile !== `raw/${capture.role}.bin` ||
      !Number.isSafeInteger(capture.rawSize) ||
      capture.rawSize < 1 ||
      capture.rawSize > MAX_CAPTURE_BYTES ||
      !HASH.test(capture.rawSha256 ?? '')
    )
      fail('capture_envelope');
    validateSource(capture);
    timestamp(capture.capturedAt);
    const bytes = files.get(capture.rawFile);
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength !== capture.rawSize ||
      hash(bytes) !== capture.rawSha256
    )
      fail('capture_raw_hash');
    total += bytes.byteLength;
    if (total > MAX_TOTAL_BYTES) fail('capture_total_size');
    captures.set(capture.role, { ...structuredClone(capture), raw: Buffer.from(bytes) });
  }
  if (
    files.size !== captures.size ||
    [...files.keys()].some((name) => !ROLES.some((role) => name === `raw/${role}.bin`))
  )
    fail('capture_file_closure');
  return captures;
}

function parseOwned(adapter, capture) {
  let parsed;
  try {
    parsed = adapter(Buffer.from(capture.raw), structuredClone({ ...capture, raw: undefined }));
  } catch {
    fail('capture_parse_failed');
  }
  exact(parsed, ['origin', 'immutableId', 'capturedAt', 'data'], 'capture_parsed_fields');
  if (
    parsed.origin !== capture.source.origin ||
    parsed.immutableId !== capture.source.immutableId ||
    parsed.capturedAt !== capture.capturedAt
  )
    fail('capture_raw_identity');
  return parsed.data;
}

// Testable pure derivation only. No application entrypoint accepts adapter injection.
// No operational adapters are enrolled: omission always fails closed.
export function deriveTimewebObservabilityReadbacks(
  manifestBytes,
  files,
  contract,
  observedAt,
  adapters = EMPTY_ADAPTERS,
) {
  const captures = parseTimewebCaptureBundle(manifestBytes, files);
  const names = ['timeweb-panel', 'gmail-channel', 'telegram-channel', 'release-owner-reply'];
  if (names.some((name) => typeof adapters[name] !== 'function'))
    fail('capture_adapter_unavailable');
  exact(adapters, names, 'capture_adapter_registry');
  const observedMs = timestamp(observedAt);
  const facts = new Map();
  for (const [role, capture] of captures) {
    if (timestamp(capture.capturedAt) > observedMs) fail('capture_future');
    facts.set(role, parseOwned(adapters[capture.kind], capture));
  }
  const rounds = [1, 2, 3].map((i) => facts.get(`monitor-round-${i}`));
  const expectedNames = contract.monitoring.monitors.map((m) => m.name);
  for (let i = 0; i < rounds.length; i++) {
    const round = rounds[i];
    exact(round, ['projectId', 'monitors'], 'capture_round_fields');
    if (
      round.projectId !== TARGET.projectId ||
      !Array.isArray(round.monitors) ||
      round.monitors.length !== 2
    )
      fail('capture_round_identity');
    const capturedAt = timestamp(captures.get(`monitor-round-${i + 1}`).capturedAt);
    if (i && capturedAt <= timestamp(captures.get(`monitor-round-${i}`).capturedAt))
      fail('capture_round_order');
    round.monitors.forEach((monitor, index) => {
      exact(monitor, MONITOR_KEYS, 'capture_monitor_fields');
      const last = timestamp(monitor.lastCheckAt);
      if (
        last > capturedAt ||
        capturedAt - last > 130_000 ||
        monitor.roundHealthy !== true ||
        monitor.activeIncidentCount !== 0
      )
        fail('capture_round_unhealthy');
      if (i) {
        const previous = rounds[i - 1].monitors[index];
        if (
          monitor.previousCheckAt !== previous.lastCheckAt ||
          last <= timestamp(previous.lastCheckAt)
        )
          fail('capture_round_not_consecutive');
        const config = (m) =>
          Object.fromEntries(
            MONITOR_KEYS.filter(
              (key) =>
                !['lastCheckAt', 'previousCheckAt', 'roundHealthy', 'activeIncidentCount'].includes(
                  key,
                ),
            ).map((key) => [key, m[key]]),
          );
        if (!same(config(monitor), config(previous))) fail('capture_monitor_drift');
      }
    });
  }
  const readAt = captures.get('monitor-round-3').capturedAt;
  if (observedMs - timestamp(readAt) > 30_000) fail('capture_final_round_stale');
  const active = facts.get('incident-active');
  const closed = facts.get('incident-closed');
  exact(
    active,
    ['projectId', 'testId', 'monitorNames', 'status', 'triggeredAt'],
    'capture_incident_fields',
  );
  exact(
    closed,
    [
      'projectId',
      'testId',
      'monitorNames',
      'status',
      'triggeredAt',
      'recoveredAt',
      'allRegionsHealthy',
    ],
    'capture_incident_fields',
  );
  if (
    active.projectId !== TARGET.projectId ||
    closed.projectId !== TARGET.projectId ||
    !ID.test(active.testId ?? '') ||
    closed.testId !== active.testId ||
    !same(active.monitorNames, expectedNames) ||
    !same(closed.monitorNames, expectedNames) ||
    active.status !== 'active' ||
    closed.status !== 'closed' ||
    closed.allRegionsHealthy !== true ||
    active.triggeredAt !== closed.triggeredAt
  )
    fail('capture_incident_identity');
  if (
    timestamp(active.triggeredAt) > timestamp(captures.get('incident-active').capturedAt) ||
    timestamp(closed.recoveredAt) > timestamp(captures.get('incident-closed').capturedAt)
  )
    fail('capture_incident_time');
  const owner = facts.get('owner-active-reply');
  exact(owner, ['testId', 'role', 'acknowledgedAt', 'replyId'], 'capture_owner_fields');
  if (
    owner.testId !== active.testId ||
    owner.role !== 'release-owner' ||
    owner.replyId !== captures.get('owner-active-reply').source.immutableId ||
    timestamp(owner.acknowledgedAt) !== timestamp(captures.get('owner-active-reply').capturedAt) ||
    timestamp(captures.get('incident-active').capturedAt) > timestamp(owner.acknowledgedAt) ||
    timestamp(owner.acknowledgedAt) >= timestamp(closed.recoveredAt)
  )
    fail('capture_owner_observation');
  const uniqueMessages = new Set();
  const channelDelivery = (channel, event) => {
    const role = `${channel === 'email' ? 'email' : 'telegram'}-${event}`;
    const value = facts.get(role);
    const capture = captures.get(role);
    exact(
      value,
      [
        'testId',
        'monitorNames',
        'channel',
        'event',
        'deliveredAt',
        'messageId',
        'completeSearch',
        'senderVerified',
        'receiverVerified',
      ],
      'capture_delivery_fields',
    );
    if (
      value.testId !== active.testId ||
      !same(value.monitorNames, expectedNames) ||
      value.channel !== channel ||
      value.event !== event ||
      value.messageId !== capture.source.immutableId ||
      value.completeSearch !== true ||
      value.senderVerified !== true ||
      value.receiverVerified !== true ||
      uniqueMessages.has(`${channel}:${value.messageId}`) ||
      timestamp(value.deliveredAt) > timestamp(capture.capturedAt)
    )
      fail('capture_delivery_identity');
    uniqueMessages.add(`${channel}:${value.messageId}`);
    return { channel, deliveredAt: value.deliveredAt };
  };
  const monitorReadback = {
    schema: 'PHUB_TIMEWEB_MONITOR_READBACK_V1',
    source: 'timeweb-approved-read-only-readback',
    readAt,
    projectId: TARGET.projectId,
    monitors: rounds[2].monitors.map(
      ({ previousCheckAt: _previous, roundHealthy: _healthy, ...monitor }) => ({
        ...monitor,
        successfulConsecutiveRounds: 3,
      }),
    ),
  };
  const alertReadback = {
    schema: 'PHUB_TIMEWEB_ALERT_READBACK_V1',
    source: 'approved-delivery-and-provider-readback',
    testId: active.testId,
    monitorNames: expectedNames,
    triggeredAt: active.triggeredAt,
    deliveries: [channelDelivery('email', 'alert'), channelDelivery('telegram', 'alert')],
    acknowledgedAt: owner.acknowledgedAt,
    acknowledgementKind: 'release-owner-observed-active-incident',
    acknowledgedByRole: owner.role,
    recoveredAt: closed.recoveredAt,
    recoveryKind: 'provider-closed-after-all-regions-healthy',
    recoveryDeliveries: [
      channelDelivery('email', 'recovery'),
      channelDelivery('telegram', 'recovery'),
    ],
  };
  validateUpgradeMonitoring(monitorReadback, alertReadback, contract, observedAt);
  return { monitorReadback, alertReadback, captureCount: captures.size, operationalWriter: false };
}
