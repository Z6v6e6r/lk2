// Native Timeweb facts. Provider online means HTTP 2xx; exact application 200 is separate.
import { createHash } from 'node:crypto';
import { parseStrictJson } from './strict-json.js';

export const NATIVE_MONITOR_SCHEMA = 'PHUB_TIMEWEB_MONITOR_READBACK_V2';
export const NATIVE_MONITOR_BUNDLE = 'PHUB_TIMEWEB_NATIVE_MONITOR_CAPTURE_V1';
export const NATIVE_MONITOR_BATCH_BUNDLE = 'PHUB_TIMEWEB_NATIVE_MONITOR_CAPTURE_BATCH_V2';
export const NATIVE_CUA_BATCH_RESULT = 'PHUB_TIMEWEB_NATIVE_CUA_BATCH_RESULT_V1';
export const APPROVED_NATIVE_READER = 'codex-lk2-desktop-readonly-20261114';
export const REDACTED_PRESENT = '__PHUB_CONFIGURED_VALUE_REDACTED__';
export const NATIVE_MONITORS = Object.freeze([
  {
    service: 'api',
    id: '26ed404e-98e5-45c5-98e3-31b9dfd6f0f2',
    name: 'lk2-beta-api-ready',
    host: 'https://lk2.padlhub.su/health/ready',
  },
  {
    service: 'web',
    id: 'b25e28a0-02d8-49e4-a0a1-f49f62abc02c',
    name: 'lk2-beta-web-root',
    host: 'https://lk2.padlhub.su/',
  },
]);
const REGIONS = ['nl-1', 'ru-1'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const CALL = /^call_[a-f0-9]{32}$/u;
const TARGET = { hostname: 'lk2.padlhub.su', serverId: 8886471, projectId: 262717 };
const CONFIG_KEYS = [
  'id',
  'probe',
  'host',
  'interval',
  'timeout',
  'regions',
  'parameters',
  'enabled',
  'name',
  'description',
  'project_id',
  'status',
  'runtime_status',
  'runtime_status_started_at',
  'created_at',
  'updated_at',
];
const INCIDENT_KEYS = [
  'id',
  'probe_id',
  'status',
  'root_reason_category',
  'reason_code',
  'affected_regions',
  'opened_regions',
  'opened_at',
  'last_seen_at',
  'resolved_at',
];
function fail(code) {
  throw new Error('native_observability_' + code);
}
function need(value, code) {
  if (!value) fail(code);
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function exact(value, keys, code = 'fields') {
  need(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      same(Object.keys(value).sort(), [...keys].sort()),
    code,
  );
}
function stamp(value) {
  need(
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value),
    'timestamp',
  );
  const time = Date.parse(value);
  need(Number.isFinite(time) && new Date(time).toISOString() === value, 'timestamp');
  return time;
}
function uuid(value) {
  need(typeof value === 'string' && UUID.test(value), 'uuid');
}
function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function regionSet(value) {
  need(Array.isArray(value) && same([...value].sort(), REGIONS), 'regions');
}
function nativeEnvelope(raw, rowsKey) {
  exact(raw, [rowsKey, 'meta', 'response_id']);
  uuid(raw.response_id);
  exact(raw.meta, ['total']);
  need(
    Number.isSafeInteger(raw.meta.total) &&
      raw.meta.total >= 0 &&
      Array.isArray(raw[rowsKey]) &&
      raw.meta.total === raw[rowsKey].length,
    'truncated_native_inventory',
  );
}
function noCredential(value) {
  need(
    !/\b(?:Basic|Bearer)\s+\S+|auth_hash(?:=|%3[dD])|-----BEGIN [^-]*PRIVATE KEY-----/iu.test(
      JSON.stringify(value),
    ),
    'credential_contamination',
  );
}

// Run before persisting any native configuration bytes. Values are never returned or logged.
// A fixed redaction marker records presence; it is not a replacement credential.
export function redactNativeProbeResponse(input) {
  nativeEnvelope(input, 'probes');
  const output = structuredClone(input);
  for (const probe of output.probes) {
    exact(probe, CONFIG_KEYS, 'native_probe_fields');
    exact(
      probe.parameters,
      [
        'follow_redirects',
        'request_method',
        'request_headers',
        'request_basic_auth',
        'is_check_cert',
      ],
      'native_parameter_fields',
    );
    exact(probe.parameters.request_headers, ['Authorization'], 'native_header_inventory');
    need(
      typeof probe.parameters.request_headers.Authorization === 'string' &&
        probe.parameters.request_headers.Authorization.length > 0 &&
        probe.parameters.request_headers.Authorization !== REDACTED_PRESENT,
      'authorization_not_configured',
    );
    need(probe.parameters.request_basic_auth === null, 'unsupported_basic_auth');
    probe.parameters.request_headers.Authorization = REDACTED_PRESENT;
  }
  noCredential(output);
  return output;
}

// Fixed public CUA invocation: five bounded GETs run in the browser realm. The opaque
// authenticated client and CDP session must already exist under these exact bindings.
// No provider credential or unredacted configuration leaves the browser realm.
export function nativeBatchCuaArguments() {
  const declaration = `async function() {
const CONFIG_KEYS = ${JSON.stringify(CONFIG_KEYS)};
const REDACTED_PRESENT = ${JSON.stringify(REDACTED_PRESENT)};
const UUID = ${UUID.toString()};
${[fail, need, same, exact, uuid, nativeEnvelope, noCredential, redactNativeProbeResponse].map((fn) => fn.toString()).join('\n')}
const definitions = ${JSON.stringify(NATIVE_MONITORS)};
const origin = 'https://timeweb.cloud/api/v1/probes';
const requestedAt = new Date().toISOString();
const reads = [
  ['configuration', origin + '?limit=10000&offset=0'],
  ...definitions.map((row) => ['statistics-' + row.service, origin + '/' + row.id + '/statistics?time_from=' + encodeURIComponent(requestedAt) + '&period=6']),
  ...definitions.map((row) => ['incidents-' + row.service, origin + '/' + row.id + '/incidents?limit=10000&offset=0']),
];
try {
  const captures = await Promise.all(reads.map(async ([role, url]) => {
    const response = await this.client.get(url, {timeout: 8000});
    if (response.status !== 200) throw Error('NATIVE_HTTP_STATUS');
    const capturedAt = new Date().toISOString();
    const nativeResponse = role === 'configuration' ? redactNativeProbeResponse(response.data) : response.data;
    noCredential(nativeResponse);
    return {role, projection: role === 'configuration' ? 'native-authorization-redacted-v1' : 'native-complete-v1', capturedAt, url, nativeResponse};
  }));
  const result = JSON.stringify({schema: ${JSON.stringify(NATIVE_CUA_BATCH_RESULT)}, captures});
  if (new TextEncoder().encode(result).byteLength > 2 * 1024 * 1024) throw Error('NATIVE_CAPTURE_SIZE');
  return result;
} catch { throw Error('NATIVE_BATCH_READ_FAILED'); }
}`;
  return {
    code: `var phubNativeBatchResult = await phubNativeMonitorCdp.send('Runtime.callFunctionOn', {objectId: phubNativeTimewebClient.result.objectId, functionDeclaration: ${JSON.stringify(declaration)}, awaitPromise: true, returnByValue: true}, {timeoutMs: 10000}); if (phubNativeBatchResult.exceptionDetails || typeof phubNativeBatchResult.result?.value !== 'string') throw Error('NATIVE_BATCH_CAPTURE_FAILED'); nodeRepl.write(phubNativeBatchResult.result.value);`,
    title: 'Читаю пять проверок мониторинга',
    timeout_ms: 12000,
  };
}

function captureUrl(capture, role, definition) {
  let url;
  try {
    url = new URL(capture.url);
  } catch {
    fail('capture_url');
  }
  need(
    url.origin === 'https://timeweb.cloud' && !url.username && !url.password && !url.hash,
    'capture_origin',
  );
  const expected =
    role === 'configuration'
      ? '/api/v1/probes'
      : `/api/v1/probes/${definition.id}/${role.startsWith('statistics') ? 'statistics' : 'incidents'}`;
  need(url.pathname === expected, 'capture_target');
  const entries = [...url.searchParams.entries()];
  if (role.startsWith('statistics')) {
    need(
      entries.length === 2 &&
        url.searchParams.has('time_from') &&
        ['6', '24'].includes(url.searchParams.get('period')),
      'statistics_query',
    );
    const requested = stamp(url.searchParams.get('time_from'));
    need(Math.abs(requested - stamp(capture.capturedAt)) <= 30000, 'statistics_request_age');
  } else
    need(
      entries.length === 2 &&
        url.searchParams.get('limit') === '10000' &&
        url.searchParams.get('offset') === '0',
      'inventory_query',
    );
}
function validateCapture(capture, role, observedAt, definition) {
  exact(capture, ['role', 'projection', 'toolCallId', 'capturedAt', 'url', 'nativeResponse']);
  need(capture.role === role && CALL.test(capture.toolCallId ?? ''), 'capture_identity');
  const age = observedAt - stamp(capture.capturedAt);
  need(age >= 0 && age <= 30000, 'capture_age');
  const projection =
    role === 'configuration'
      ? 'native-authorization-redacted-v1'
      : role.startsWith('statistics')
        ? 'native-complete-v1'
        : 'native-complete-v1';
  need(capture.projection === projection, 'capture_projection');
  captureUrl(capture, role, definition);
  noCredential(capture.nativeResponse);
  uuid(capture.nativeResponse.response_id);
  return capture;
}
function validateConfiguration(probe, definition, capturedAt) {
  exact(probe, CONFIG_KEYS, 'native_probe_fields');
  exact(
    probe.parameters,
    [
      'follow_redirects',
      'request_method',
      'request_headers',
      'request_basic_auth',
      'is_check_cert',
    ],
    'native_parameter_fields',
  );
  exact(probe.parameters.request_headers, ['Authorization'], 'native_header_inventory');
  regionSet(probe.regions);
  need(
    probe.id === definition.id &&
      probe.name === definition.name &&
      probe.host === definition.host &&
      probe.project_id === TARGET.projectId &&
      probe.probe === 'http' &&
      probe.enabled === true &&
      probe.status === 'CREATED' &&
      probe.runtime_status === 'UP',
    'native_probe_identity',
  );
  need(
    probe.interval === 60 &&
      probe.timeout === 10 &&
      probe.parameters.request_method === 'GET' &&
      probe.parameters.follow_redirects === true &&
      probe.parameters.request_headers.Authorization === REDACTED_PRESENT &&
      probe.parameters.request_basic_auth === null &&
      probe.parameters.is_check_cert === true,
    'native_probe_configuration',
  );
  for (const key of ['runtime_status_started_at', 'created_at', 'updated_at'])
    need(stamp(probe[key]) <= capturedAt, 'configuration_future');
  need(probe.description === '', 'native_probe_description');
}
function deriveHistory(raw, observedAt) {
  exact(raw, ['probe_statistics', 'response_id']);
  uuid(raw.response_id);
  exact(raw.probe_statistics, ['statistics']);
  const statistics = raw.probe_statistics.statistics;
  need(Array.isArray(statistics) && statistics.length === 2, 'history_regions');
  regionSet(statistics.map((row) => row.name));
  const tails = statistics
    .map((region) => {
      exact(region, ['name', 'list', 'meta'], 'history_fields');
      exact(region.meta, ['amount']);
      need(Number.isSafeInteger(region.meta.amount) && region.meta.amount >= 8, 'history_amount');
      need(
        Array.isArray(region.list) && region.list.length === region.meta.amount,
        'history_length',
      );
      let previous = -1;
      for (const point of region.list) {
        exact(point, ['value', 'time', 'status'], 'history_point_fields');
        const time = stamp(point.time);
        need(time > previous && time <= observedAt, 'history_order');
        previous = time;
        need(
          typeof point.status === 'string' && point.status.length > 0 && point.value !== undefined,
          'history_point',
        );
      }
      return { name: region.name, list: region.list.slice(-3) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const history = [];
  for (let index = 0; index < 3; index++) {
    const time = tails[0].list[index].time;
    need(
      tails.every((region) => region.list[index].time === time),
      'history_alignment',
    );
    if (index) need(stamp(time) - stamp(history[index - 1].time) === 60000, 'history_cadence');
    const regions = tails.map((region) => {
      const point = region.list[index];
      need(
        point.status === 'online' &&
          typeof point.value === 'number' &&
          Number.isFinite(point.value) &&
          point.value >= 0,
        'history_not_online',
      );
      return { region: region.name, status: point.status, nativeValue: point.value };
    });
    history.push({ time, regions });
  }
  const age = observedAt - stamp(history[2].time);
  need(age >= 0 && age <= 130000, 'history_stale');
  return history;
}
function zeroActiveIncidents(raw, definition, capturedAt) {
  nativeEnvelope(raw, 'incidents');
  const seen = new Set();
  for (const incident of raw.incidents) {
    exact(incident, INCIDENT_KEYS, 'incident_fields');
    uuid(incident.id);
    need(!seen.has(incident.id), 'duplicate_incident');
    seen.add(incident.id);
    need(
      incident.probe_id === definition.id &&
        incident.status === 'RESOLVED' &&
        incident.resolved_at !== null,
      'active_incident',
    );
    need(
      stamp(incident.opened_at) <= stamp(incident.resolved_at) &&
        stamp(incident.resolved_at) <= stamp(incident.last_seen_at) &&
        stamp(incident.last_seen_at) <= capturedAt,
      'incident_time',
    );
    for (const key of ['affected_regions', 'opened_regions']) {
      need(
        Array.isArray(incident[key]) &&
          incident[key].length > 0 &&
          new Set(incident[key]).size === incident[key].length &&
          incident[key].every((region) => REGIONS.includes(region)),
        'incident_regions',
      );
    }
    need(
      typeof incident.reason_code === 'string' && typeof incident.root_reason_category === 'string',
      'incident_reason',
    );
  }
  return 0;
}

export function deriveNativeMonitorReadback(bytes, observedAtInput, expectedSourceSha) {
  need(
    (typeof bytes === 'string' || bytes instanceof Uint8Array) &&
      Buffer.byteLength(bytes) <= 2 * 1024 * 1024,
    'bundle_size',
  );
  const bundle = parseStrictJson(bytes);
  exact(bundle, ['schema', 'target', 'producerSourceSha', 'readerAuditId', 'captures']);
  need(
    [NATIVE_MONITOR_BUNDLE, NATIVE_MONITOR_BATCH_BUNDLE].includes(bundle.schema) &&
      same(bundle.target, TARGET) &&
      SHA.test(bundle.producerSourceSha ?? '') &&
      bundle.producerSourceSha === expectedSourceSha &&
      bundle.readerAuditId === APPROVED_NATIVE_READER,
    'bundle_identity',
  );
  const observedAt = stamp(observedAtInput),
    roles = ['configuration', 'statistics-api', 'statistics-web', 'incidents-api', 'incidents-web'];
  need(
    Array.isArray(bundle.captures) && bundle.captures.length === roles.length,
    'capture_inventory',
  );
  const captures = new Map();
  for (const role of roles) {
    const matches = bundle.captures.filter((capture) => capture.role === role);
    need(matches.length === 1, 'capture_inventory');
    const definition = NATIVE_MONITORS.find((row) => role.endsWith('-' + row.service));
    captures.set(role, validateCapture(matches[0], role, observedAt, definition));
  }
  need(
    new Set(bundle.captures.map((capture) => capture.toolCallId)).size ===
      (bundle.schema === NATIVE_MONITOR_BATCH_BUNDLE ? 1 : roles.length) &&
      new Set(bundle.captures.map((capture) => capture.nativeResponse.response_id)).size ===
        roles.length,
    'duplicate_capture',
  );
  if (bundle.schema === NATIVE_MONITOR_BATCH_BUNDLE)
    need(
      same(
        bundle.captures.map((capture) => capture.role),
        roles,
      ),
      'capture_order',
    );
  const config = captures.get('configuration').nativeResponse;
  nativeEnvelope(config, 'probes');
  need(
    config.probes.length === 2 && new Set(config.probes.map((probe) => probe.id)).size === 2,
    'native_probe_inventory',
  );
  const monitors = NATIVE_MONITORS.map((definition) => {
    const matches = config.probes.filter((probe) => probe.id === definition.id);
    need(matches.length === 1, 'native_probe_inventory');
    const probe = matches[0];
    validateConfiguration(probe, definition, stamp(captures.get('configuration').capturedAt));
    const stats = captures.get('statistics-' + definition.service),
      incidents = captures.get('incidents-' + definition.service);
    const nativeHistory = deriveHistory(stats.nativeResponse, stamp(stats.capturedAt));
    return {
      service: definition.service,
      name: probe.name,
      providerMonitorId: probe.id,
      enabled: probe.enabled,
      type: probe.probe,
      method: probe.parameters.request_method,
      url: probe.host,
      providerSuccessPolicy: 'HTTP_2XX',
      regions: [...probe.regions].sort(),
      intervalSeconds: probe.interval,
      timeoutSeconds: probe.timeout,
      authorizationHeaderConfigured: true,
      basicAuthConfigured: false,
      followRedirects: probe.parameters.follow_redirects,
      runtimeStatus: probe.runtime_status,
      runtimeStatusStartedAt: probe.runtime_status_started_at,
      lastCheckAt: nativeHistory.at(-1).time,
      nativeHistory,
      successfulConsecutiveRounds: 3,
      activeIncidentCount: zeroActiveIncidents(
        incidents.nativeResponse,
        definition,
        stamp(incidents.capturedAt),
      ),
      captureReferences: {
        configuration: captures.get('configuration').toolCallId,
        statistics: stats.toolCallId,
        incidents: incidents.toolCallId,
      },
    };
  });
  return {
    schema: NATIVE_MONITOR_SCHEMA,
    source: 'timeweb-native-http-probe-readback-v2',
    readAt: new Date(
      Math.max(...bundle.captures.map((capture) => stamp(capture.capturedAt))),
    ).toISOString(),
    projectId: TARGET.projectId,
    producerSourceSha: bundle.producerSourceSha,
    readerAuditId: bundle.readerAuditId,
    trust: 'APPROVED_READER_ROOT_OPERATOR_ATTESTED_V1',
    captureBundleSha256: digest(bytes),
    monitors,
  };
}

export function verifyNativeMonitorReadback(readback, bundleBytes, observedAt, expectedSourceSha) {
  need(
    readback?.schema === NATIVE_MONITOR_SCHEMA &&
      HASH.test(readback.captureBundleSha256 ?? '') &&
      digest(bundleBytes) === readback.captureBundleSha256,
    'readback_identity',
  );
  const derived = deriveNativeMonitorReadback(bundleBytes, observedAt, expectedSourceSha);
  need(same(readback, derived), 'readback_drift');
  return derived.monitors;
}
