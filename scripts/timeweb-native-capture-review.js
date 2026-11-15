// Custody inside the approved collector/root-input trust model. Not a signature or
// provider-origin authentication. The independent reviewer must inspect these actual calls.
import { createHash } from 'node:crypto';
import { parseStrictJson } from './strict-json.js';
import {
  redactNativeProbeResponse,
  APPROVED_NATIVE_READER,
  NATIVE_MONITOR_BUNDLE,
  NATIVE_MONITOR_BATCH_BUNDLE,
  NATIVE_CUA_BATCH_RESULT,
  nativeBatchCuaArguments,
} from './timeweb-native-observability.js';

export const NATIVE_REVIEW_SCHEMA = 'PHUB_TIMEWEB_NATIVE_CAPTURE_REVIEW_V1';
export const NATIVE_TRACE_SCHEMA = 'PHUB_TIMEWEB_NATIVE_CUA_PUBLIC_TRACE_V1';
export const NATIVE_BATCH_REVIEW_SCHEMA = 'PHUB_TIMEWEB_NATIVE_CAPTURE_BATCH_REVIEW_V2';
export const NATIVE_BATCH_TRACE_SCHEMA = 'PHUB_TIMEWEB_NATIVE_CUA_BATCH_PUBLIC_TRACE_V2';
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const ROLES = [
  'configuration',
  'statistics-api',
  'statistics-web',
  'incidents-api',
  'incidents-web',
];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const need = (value, code) => {
  if (!value) throw Error('native_capture_review_' + code);
};
function exact(value, keys) {
  need(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      same(Object.keys(value).sort(), [...keys].sort()),
    'fields',
  );
}
function timestamp(value) {
  need(
    typeof value === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    'timestamp',
  );
  return Date.parse(value);
}
function clean(value) {
  need(
    !/\b(?:Basic|Bearer)\s+\S+|auth_hash(?:=|%3[dD])|-----BEGIN [^-]*PRIVATE KEY-----/iu.test(
      JSON.stringify(value),
    ),
    'credential_contamination',
  );
}

export function nativeRedactorSha256() {
  return hash(redactNativeProbeResponse.toString());
}

export function verifyNativeCaptureReview(
  reviewBytes,
  bundleBytes,
  traceBytes,
  sourceSha,
  adapterSourceSha256,
  now = new Date().toISOString(),
) {
  for (const bytes of [reviewBytes, bundleBytes, traceBytes])
    need(
      (typeof bytes === 'string' || bytes instanceof Uint8Array) &&
        Buffer.byteLength(bytes) > 0 &&
        Buffer.byteLength(bytes) <= 4 * 1024 * 1024,
      'size',
    );
  const review = parseStrictJson(reviewBytes),
    bundle = parseStrictJson(bundleBytes),
    trace = parseStrictJson(traceBytes);
  const batch = bundle.schema === NATIVE_MONITOR_BATCH_BUNDLE;
  need(batch || bundle.schema === NATIVE_MONITOR_BUNDLE, 'bundle_schema');
  exact(review, [
    'schema',
    'target',
    'producerSourceSha',
    'adapterSourceSha256',
    'redactorSha256',
    'readerAuditId',
    'captureBundleSha256',
    'actualTraceSha256',
    'tracePolicy',
    'reviewer',
    'reviewedAt',
    'captures',
    'conclusion',
  ]);
  exact(review.reviewer, ['kind', 'rootThreadId', 'taskPath']);
  need(
    review.schema === (batch ? NATIVE_BATCH_REVIEW_SCHEMA : NATIVE_REVIEW_SCHEMA) &&
      review.tracePolicy === 'PUBLIC_IO_INTERNAL_METADATA_EXCLUDED_NOT_ORIGIN_AUTHENTICATION_V1' &&
      review.conclusion === 'APPROVED_COLLECTOR_ROOT_INPUT_REVIEWED_V1' &&
      review.readerAuditId === APPROVED_NATIVE_READER &&
      bundle.readerAuditId === APPROVED_NATIVE_READER &&
      review.producerSourceSha === sourceSha &&
      bundle.producerSourceSha === sourceSha &&
      same(review.target, bundle.target),
    'identity',
  );
  need(
    HASH.test(adapterSourceSha256 ?? '') &&
      review.adapterSourceSha256 === adapterSourceSha256 &&
      review.redactorSha256 === nativeRedactorSha256() &&
      review.captureBundleSha256 === hash(bundleBytes) &&
      review.actualTraceSha256 === hash(traceBytes),
    'hash',
  );
  need(
    review.reviewer.kind === 'CODEX_READONLY_INDEPENDENT_REVIEW_V1' &&
      UUID.test(review.reviewer.rootThreadId ?? '') &&
      /^\/root\/[a-z0-9_]+$/u.test(review.reviewer.taskPath ?? ''),
    'reviewer',
  );
  const reviewed = timestamp(review.reviewedAt),
    current = timestamp(now);
  need(
    reviewed <= current &&
      reviewed >= Math.max(...bundle.captures.map((c) => timestamp(c.capturedAt))) &&
      reviewed - Math.max(...bundle.captures.map((c) => timestamp(c.capturedAt))) <= 300000,
    'review_time',
  );
  exact(trace, ['schema', 'calls']);
  need(
    trace.schema === (batch ? NATIVE_BATCH_TRACE_SCHEMA : NATIVE_TRACE_SCHEMA) &&
      Array.isArray(trace.calls) &&
      trace.calls.length === (batch ? 1 : ROLES.length) &&
      Array.isArray(review.captures) &&
      review.captures.length === ROLES.length,
    'trace',
  );
  clean(trace);
  for (let index = 0; index < ROLES.length; index++) {
    const role = ROLES[index],
      capture = bundle.captures.find((c) => c.role === role),
      approved = review.captures[index],
      call = trace.calls[batch ? 0 : index];
    need(capture, 'capture');
    exact(approved, [
      'role',
      'toolCallId',
      'url',
      'capturedAt',
      'projection',
      'responseSha256',
      'requestCodeSha256',
      'requestArgumentsSha256',
    ]);
    exact(call, ['request', 'response']);
    exact(call.request, ['type', 'name', 'namespace', 'arguments', 'call_id']);
    exact(call.response, ['type', 'call_id', 'output']);
    need(
      call.request.type === 'function_call' &&
        call.request.namespace === 'mcp__cua_repl' &&
        call.request.name === 'js' &&
        call.response.type === 'function_call_output' &&
        call.request.call_id === capture.toolCallId &&
        call.response.call_id === capture.toolCallId,
      'actual_call',
    );
    const args = parseStrictJson(call.request.arguments);
    exact(
      args,
      Object.hasOwn(args, 'timeout_ms') ? ['code', 'title', 'timeout_ms'] : ['code', 'title'],
    );
    need(
      typeof args.code === 'string' &&
        args.code.length <= 128 * 1024 &&
        typeof args.title === 'string' &&
        args.title.length <= 160,
      'request',
    );
    if (batch) need(same(args, nativeBatchCuaArguments()), 'batch_request_source');
    if (!batch && role === 'configuration')
      need(args.code.includes(redactNativeProbeResponse.toString()), 'redactor_source');
    const output = call.response.output;
    need(Array.isArray(output) && output.length === 2, 'actual_output');
    for (const block of output) {
      exact(block, ['type', 'text']);
      need(block.type === 'input_text' && typeof block.text === 'string', 'actual_output');
    }
    need(/^Wall time: [0-9.]+ seconds\nOutput:$/u.test(output[0].text), 'actual_output');
    let returned = parseStrictJson(output[1].text);
    if (batch) {
      exact(returned, ['schema', 'captures']);
      need(
        returned.schema === NATIVE_CUA_BATCH_RESULT &&
          Array.isArray(returned.captures) &&
          returned.captures.length === ROLES.length,
        'batch_output',
      );
      returned = returned.captures[index];
    }
    exact(returned, ['role', 'projection', 'capturedAt', 'url', 'nativeResponse']);
    const expected = {
      role: capture.role,
      projection: capture.projection,
      capturedAt: capture.capturedAt,
      url: capture.url,
      nativeResponse: capture.nativeResponse,
    };
    need(
      same(returned, expected) &&
        same(approved, {
          role,
          toolCallId: capture.toolCallId,
          url: capture.url,
          capturedAt: capture.capturedAt,
          projection: capture.projection,
          responseSha256: hash(JSON.stringify(capture.nativeResponse)),
          requestCodeSha256: hash(args.code),
          requestArgumentsSha256: hash(call.request.arguments),
        }),
      'capture_mapping',
    );
  }
  need(
    new Set(trace.calls.map((c) => c.request.call_id)).size === (batch ? 1 : ROLES.length),
    'duplicate_call',
  );
  return {
    reviewSha256: hash(reviewBytes),
    actualTraceSha256: hash(traceBytes),
    captureBundleSha256: hash(bundleBytes),
    reviewedAt: review.reviewedAt,
  };
}
