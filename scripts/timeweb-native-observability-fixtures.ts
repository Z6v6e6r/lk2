import { createHash } from 'node:crypto';
import {
  NATIVE_MONITORS,
  NATIVE_MONITOR_BUNDLE,
  NATIVE_MONITOR_BATCH_BUNDLE,
  NATIVE_CUA_BATCH_RESULT,
  nativeBatchCuaArguments,
  REDACTED_PRESENT,
  APPROVED_NATIVE_READER,
  redactNativeProbeResponse,
} from './timeweb-native-observability.js';
import {
  NATIVE_REVIEW_SCHEMA,
  NATIVE_TRACE_SCHEMA,
  NATIVE_BATCH_TRACE_SCHEMA,
  NATIVE_BATCH_REVIEW_SCHEMA,
  nativeRedactorSha256,
} from './timeweb-native-capture-review.js';

export const NOW = '2026-11-14T12:00:30.000Z';
export const SOURCE = 'a'.repeat(40);
export function fixture() {
  const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const config = {
    probes: NATIVE_MONITORS.map((row) => ({
      id: row.id,
      probe: 'http',
      host: row.host,
      interval: 60,
      timeout: 10,
      regions: ['ru-1', 'nl-1'],
      parameters: {
        follow_redirects: true,
        request_method: 'GET',
        request_headers: { Authorization: REDACTED_PRESENT },
        request_basic_auth: null,
        is_check_cert: true,
      },
      enabled: true,
      name: row.name,
      description: '',
      project_id: 262717,
      status: 'CREATED',
      runtime_status: 'UP',
      runtime_status_started_at: '2026-10-22T08:18:00.000Z',
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
    })),
    meta: { total: 2 },
    response_id: id(1),
  };
  const statistics = (n: number) => ({
    probe_statistics: {
      statistics: ['ru-1', 'nl-1'].map((name) => ({
        name,
        list: Array.from({ length: 8 }, (_, index) => ({
          value: 0.1 + index / 100,
          time: new Date(Date.parse('2026-11-14T11:53:00.000Z') + index * 60000).toISOString(),
          status: 'online',
        })),
        meta: { amount: 8 },
      })),
    },
    response_id: id(n),
  });
  const incidents = (n: number, probeId: string) => ({
    incidents: [
      {
        id: id(n + 10),
        probe_id: probeId,
        status: 'RESOLVED',
        root_reason_category: 'TIMEOUT',
        reason_code: 'HTTP_TIMED_OUT',
        affected_regions: ['ru-1', 'nl-1'],
        opened_regions: ['ru-1', 'nl-1'],
        opened_at: '2026-10-22T08:04:00.000Z',
        last_seen_at: '2026-10-22T08:19:33.000Z',
        resolved_at: '2026-10-22T08:18:00.000Z',
      },
    ],
    meta: { total: 1 },
    response_id: id(n),
  });
  const statsApi = statistics(2),
    statsWeb = statistics(3),
    incApi = incidents(4, NATIVE_MONITORS[0]!.id),
    incWeb = incidents(5, NATIVE_MONITORS[1]!.id);
  function capture(role: string, nativeResponse: unknown, index: number) {
    const row = role.endsWith('-web') ? NATIVE_MONITORS[1]! : NATIVE_MONITORS[0]!;
    const url =
      role === 'configuration'
        ? 'https://timeweb.cloud/api/v1/probes?limit=10000&offset=0'
        : role.startsWith('statistics')
          ? `https://timeweb.cloud/api/v1/probes/${row.id}/statistics?time_from=2026-11-14T12:00:24.000Z&period=6`
          : `https://timeweb.cloud/api/v1/probes/${row.id}/incidents?limit=10000&offset=0`;
    return {
      role,
      projection:
        role === 'configuration'
          ? 'native-authorization-redacted-v1'
          : role.startsWith('statistics')
            ? 'native-complete-v1'
            : 'native-complete-v1',
      toolCallId: 'call_' + String(index).repeat(32),
      capturedAt: '2026-11-14T12:00:25.000Z',
      url,
      nativeResponse,
    };
  }
  const bundle = {
    schema: NATIVE_MONITOR_BUNDLE,
    target: { hostname: 'lk2.padlhub.su', serverId: 8886471, projectId: 262717 },
    producerSourceSha: SOURCE,
    readerAuditId: APPROVED_NATIVE_READER,
    captures: [
      capture('configuration', config, 1),
      capture('statistics-api', statsApi, 2),
      capture('statistics-web', statsWeb, 3),
      capture('incidents-api', incApi, 4),
      capture('incidents-web', incWeb, 5),
    ],
  };
  return { bundle, config, statsApi, statsWeb, incApi, incWeb };
}

export const NATIVE_ADAPTER_SHA256 = 'b'.repeat(64);
export const encodedNativeFixture = (value: unknown) =>
  Buffer.from(JSON.stringify(value, null, 2) + '\n');
export const nativeFixtureHash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export function reviewedNativeFixture() {
  const f = fixture();
  const trace = {
    schema: NATIVE_TRACE_SCHEMA,
    calls: f.bundle.captures.map((capture) => {
      const { toolCallId, ...publicOutput } = capture;
      const code =
        (capture.role === 'configuration' ? redactNativeProbeResponse.toString() + '\n' : '') +
        '// Synthetic read-only GET capture fixture';
      return {
        request: {
          type: 'function_call',
          name: 'js',
          namespace: 'mcp__cua_repl',
          arguments: JSON.stringify({
            code,
            title: 'Reading native monitor fixture',
            timeout_ms: 30000,
          }),
          call_id: toolCallId,
        },
        response: {
          type: 'function_call_output',
          call_id: toolCallId,
          output: [
            { type: 'input_text', text: 'Wall time: 0.012 seconds\nOutput:' },
            { type: 'input_text', text: JSON.stringify(publicOutput) },
          ],
        },
      };
    }),
  };
  const review = {
    schema: NATIVE_REVIEW_SCHEMA,
    target: f.bundle.target,
    producerSourceSha: SOURCE,
    adapterSourceSha256: NATIVE_ADAPTER_SHA256,
    redactorSha256: nativeRedactorSha256(),
    readerAuditId: f.bundle.readerAuditId,
    captureBundleSha256: nativeFixtureHash(encodedNativeFixture(f.bundle)),
    actualTraceSha256: nativeFixtureHash(encodedNativeFixture(trace)),
    tracePolicy: 'PUBLIC_IO_INTERNAL_METADATA_EXCLUDED_NOT_ORIGIN_AUTHENTICATION_V1',
    reviewer: {
      kind: 'CODEX_READONLY_INDEPENDENT_REVIEW_V1',
      rootThreadId: '00000000-0000-4000-8000-000000000000',
      taskPath: '/root/native_capture_security_fixture',
    },
    reviewedAt: NOW,
    conclusion: 'APPROVED_COLLECTOR_ROOT_INPUT_REVIEWED_V1',
    captures: f.bundle.captures.map((capture, index) => {
      const args = JSON.parse(trace.calls[index]!.request.arguments) as { code: string };
      return {
        role: capture.role,
        toolCallId: capture.toolCallId,
        url: capture.url,
        capturedAt: capture.capturedAt,
        projection: capture.projection,
        responseSha256: nativeFixtureHash(JSON.stringify(capture.nativeResponse)),
        requestCodeSha256: nativeFixtureHash(args.code),
        requestArgumentsSha256: nativeFixtureHash(trace.calls[index]!.request.arguments),
      };
    }),
  };
  return { f, trace, review };
}

export function reviewedNativeBatchFixture() {
  const value = reviewedNativeFixture();
  value.f.bundle.schema = NATIVE_MONITOR_BATCH_BUNDLE;
  const call = value.trace.calls[0]!;
  for (const capture of value.f.bundle.captures) capture.toolCallId = call.request.call_id;
  call.request.arguments = JSON.stringify(nativeBatchCuaArguments());
  call.response.output[1]!.text = JSON.stringify({
    schema: NATIVE_CUA_BATCH_RESULT,
    captures: value.f.bundle.captures.map(
      ({ role, projection, capturedAt, url, nativeResponse }) => ({
        role,
        projection,
        capturedAt,
        url,
        nativeResponse,
      }),
    ),
  });
  value.trace.schema = NATIVE_BATCH_TRACE_SCHEMA;
  value.trace.calls = [call];
  value.review.schema = NATIVE_BATCH_REVIEW_SCHEMA;
  const args = nativeBatchCuaArguments();
  for (const capture of value.review.captures) {
    capture.toolCallId = call.request.call_id;
    capture.requestCodeSha256 = nativeFixtureHash(args.code);
    capture.requestArgumentsSha256 = nativeFixtureHash(call.request.arguments);
  }
  value.review.captureBundleSha256 = nativeFixtureHash(encodedNativeFixture(value.f.bundle));
  value.review.actualTraceSha256 = nativeFixtureHash(encodedNativeFixture(value.trace));
  return value;
}
