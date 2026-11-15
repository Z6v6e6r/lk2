// One owner-authorized legacy cutover. This policy never grants provider-write authority.
import { createHash } from 'node:crypto';
import { parseStrictJson } from './strict-json.js';
import { deriveNativeMonitorReadback } from './timeweb-native-observability.js';
import { verifyNativeCaptureReview } from './timeweb-native-capture-review.js';

export const WAIVER_OPERATION = 'PHUB_TIMEWEB_API_WORKER_WEB_PRODUCTION_CUTOVER_ALERT_WAIVER_V3';
export const WAIVER_PLAN = 'PHUB_TIMEWEB_API_WORKER_WEB_CUTOVER_ALERT_WAIVER_PLAN_V3';
export const WAIVER_RECEIPT = 'PHUB_TIMEWEB_API_WORKER_WEB_CUTOVER_ALERT_WAIVER_RECEIPT_V3';
export const WAIVER_KIND = 'API_WORKER_WEB_PRODUCTION_CUTOVER_ALERT_WAIVER';
export const WAIVER_POLICY = 'NATIVE_HEALTH_OWNER_WAIVED_INDUCED_ALERT_DRILL_V1';
export const WAIVER_STATUS = 'NOT_TESTED_OWNER_DECLINED';
export const ADMISSION_SCHEMA = 'PHUB_TIMEWEB_NATIVE_MONITOR_ADMISSION_V1';
// Digest of the original owner instruction, including its original trailing newline.
export const OWNER_DECISION_SHA256 =
  'b781e63240ac0a9c57ba234be2522e41c4769f21a9076a8ccdc3d326f61972c7';
export const NATIVE_INPUTS = [
  'native-monitor-capture.json',
  'native-monitor-review.json',
  'native-monitor-public-trace.json',
  'owner-alert-waiver.json',
];
export const NATIVE_DERIVED = 'native-monitor-derived-readback.json';
export const NATIVE_ENVELOPE = 'native-monitor-inputs.json';
const FILE_HASHES = {
  'native-monitor-capture.json': 'captureSha256',
  'native-monitor-review.json': 'reviewSha256',
  'native-monitor-public-trace.json': 'traceSha256',
  'owner-alert-waiver.json': 'ownerReceiptSha256',
  [NATIVE_DERIVED]: 'derivedReadbackSha256',
  [NATIVE_ENVELOPE]: 'inputEnvelopeSha256',
};
const HASH = /^[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{40}$/u;
export const isWaivedRosterCutover = (op) => op?.schema === WAIVER_OPERATION;
export const nativeEvidenceBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export const nativeEvidenceHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const need = (value, code) => {
  if (!value) throw Error('roster_alert_waiver_' + code);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function exact(value, fields) {
  need(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      same(Object.keys(value).sort(), [...fields].sort()),
    'fields',
  );
}
function stamp(value) {
  need(
    typeof value === 'string' &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    'timestamp',
  );
  return Date.parse(value);
}
function canonical(bytes, maximum = 4 * 1024 * 1024) {
  need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximum, 'input_size');
  const value = parseStrictJson(bytes);
  need(nativeEvidenceBytes(value).equals(bytes), 'canonical_input');
  return value;
}
export function decodeNativeInputEnvelope(bytes, operationSha256) {
  const value = canonical(bytes, 16 * 1024 * 1024);
  exact(value, ['schema', 'operationSha256', 'files']);
  exact(value.files, NATIVE_INPUTS);
  need(
    value.schema === 'PHUB_TIMEWEB_NATIVE_INPUT_ENVELOPE_V1' &&
      value.operationSha256 === operationSha256,
    'input_envelope_operation',
  );
  need(
    NATIVE_INPUTS.every((name) => typeof value.files[name] === 'string'),
    'input_envelope_files',
  );
  return Object.fromEntries(NATIVE_INPUTS.map((name) => [name, Buffer.from(value.files[name])]));
}
const WAIVER_BINDINGS = [
  'target',
  'controllerSha',
  'candidateSha',
  'candidateTree',
  'sourceCiRunId',
  'publicationRunId',
  'artifactId',
  'artifactDigest',
  'manifestSha256',
  'backupOperationSha256',
  'expiresAt',
];
export function validateRosterAlertWaiver(op, baselineHash, fresh = false, now = undefined) {
  need(isWaivedRosterCutover(op), 'operation_schema');
  const w = op.alertWaiver;
  exact(w, [
    'schema',
    'authority',
    'scope',
    'status',
    'ownerMessageSha256',
    'ownerReceiptSha256',
    'serverId',
    'projectId',
    'legacyBaselineSha256',
    ...WAIVER_BINDINGS,
  ]);
  need(
    w.schema === 'PHUB_TIMEWEB_ROSTER_ALERT_WAIVER_V1' &&
      w.authority === 'ROOT_OPERATOR_ATTESTED_OWNER_MESSAGE_V1' &&
      w.scope === 'INDUCED_ALERT_DRILL_ONLY' &&
      w.status === WAIVER_STATUS &&
      w.ownerMessageSha256 === OWNER_DECISION_SHA256 &&
      HASH.test(w.ownerReceiptSha256 ?? '') &&
      w.serverId === 8886471 &&
      w.projectId === 262717 &&
      w.target === 'lk2.padlhub.su' &&
      HASH.test(baselineHash ?? '') &&
      w.legacyBaselineSha256 === baselineHash &&
      WAIVER_BINDINGS.every((k) => w[k] === op[k]),
    'scope',
  );
  const expiry = stamp(w.expiresAt);
  if (fresh) {
    const clock = now ?? Date.now();
    need(expiry > clock && expiry - clock <= 3600000, 'expired');
  }
  return w;
}
export function ownerWaiverScopeSha256(op) {
  return nativeEvidenceHash(
    nativeEvidenceBytes({
      schema: op.schema,
      profile: op.profile,
      serverId: 8886471,
      projectId: 262717,
      policy: WAIVER_POLICY,
      scope: 'INDUCED_ALERT_DRILL_ONLY',
      status: WAIVER_STATUS,
      ownerMessageSha256: OWNER_DECISION_SHA256,
      legacyBaselineSha256: nativeEvidenceHash(Buffer.from(JSON.stringify(op.legacyBaseline))),
      ...Object.fromEntries(WAIVER_BINDINGS.map((key) => [key, op[key]])),
    }),
  );
}
function ownerReceipt(op, bytes) {
  const r = canonical(bytes);
  exact(r, ['schema', 'authority', 'decisionSha256', 'scopeSha256', 'reference', 'receivedAt']);
  need(
    r.schema === 'PHUB_TIMEWEB_OWNER_MESSAGE_RECEIPT_V1' &&
      r.authority === 'ROOT_OPERATOR_ATTESTED_OWNER_MESSAGE_V1' &&
      r.decisionSha256 === OWNER_DECISION_SHA256 &&
      r.scopeSha256 === ownerWaiverScopeSha256(op) &&
      /^codex-thread:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/message:msg_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
        r.reference ?? '',
      ) &&
      nativeEvidenceHash(bytes) === op.alertWaiver.ownerReceiptSha256 &&
      stamp(r.receivedAt) < stamp(op.expiresAt),
    'owner_receipt',
  );
  return r;
}
const ADMISSION_FIELDS = [
  'schema',
  'policy',
  'operationSha256',
  'admittedAt',
  'readAt',
  'candidateSourceSha',
  'candidateSourceTree',
  'sourceCiRunId',
  'adapterSourceSha256',
  'reviewValidatorSha256',
  ...Object.values(FILE_HASHES),
  'waiverSha256',
];
export function validateNativeAdmissionBinding(op, admission, operationSha256) {
  const baselineHash = nativeEvidenceHash(Buffer.from(JSON.stringify(op.legacyBaseline)));
  validateRosterAlertWaiver(op, baselineHash);
  exact(admission, ADMISSION_FIELDS);
  need(
    admission.schema === ADMISSION_SCHEMA &&
      admission.policy === WAIVER_POLICY &&
      admission.operationSha256 === operationSha256 &&
      HASH.test(operationSha256 ?? '') &&
      admission.candidateSourceSha === op.candidateSha &&
      SHA.test(admission.candidateSourceSha) &&
      admission.candidateSourceTree === op.candidateTree &&
      SHA.test(admission.candidateSourceTree) &&
      admission.sourceCiRunId === op.sourceCiRunId &&
      admission.ownerReceiptSha256 === op.alertWaiver.ownerReceiptSha256 &&
      admission.waiverSha256 === nativeEvidenceHash(nativeEvidenceBytes(op.alertWaiver)) &&
      ['adapterSourceSha256', 'reviewValidatorSha256', ...Object.values(FILE_HASHES)].every((key) =>
        HASH.test(admission[key] ?? ''),
      ),
    'admission_identity',
  );
  const age = stamp(admission.admittedAt) - stamp(admission.readAt);
  need(age >= 0 && age <= 30000, 'admission_age');
  return admission;
}
// Buffers are read once by the existing controller under its existing rollout lease.
export function createNativeWaiverAdmission(op, inputs, source, admittedAt, operationSha256) {
  need(isWaivedRosterCutover(op), 'operation_schema');
  exact(inputs, NATIVE_INPUTS);
  exact(source, ['adapterSourceSha256', 'reviewValidatorSha256']);
  const parsed = Object.fromEntries(NATIVE_INPUTS.map((name) => [name, canonical(inputs[name])]));
  ownerReceipt(op, inputs['owner-alert-waiver.json']);
  need(stamp(parsed['owner-alert-waiver.json'].receivedAt) <= stamp(admittedAt), 'owner_future');
  const derived = deriveNativeMonitorReadback(
    inputs['native-monitor-capture.json'],
    admittedAt,
    op.candidateSha,
  );
  verifyNativeCaptureReview(
    inputs['native-monitor-review.json'],
    inputs['native-monitor-capture.json'],
    inputs['native-monitor-public-trace.json'],
    op.candidateSha,
    source.adapterSourceSha256,
    admittedAt,
  );
  const evidence = {
    ...inputs,
    [NATIVE_DERIVED]: nativeEvidenceBytes(derived),
    [NATIVE_ENVELOPE]: nativeEvidenceBytes({
      schema: 'PHUB_TIMEWEB_NATIVE_INPUT_ENVELOPE_V1',
      operationSha256,
      files: Object.fromEntries(NATIVE_INPUTS.map((name) => [name, inputs[name].toString()])),
    }),
  };
  const admission = {
    schema: ADMISSION_SCHEMA,
    policy: WAIVER_POLICY,
    operationSha256,
    admittedAt,
    readAt: derived.readAt,
    candidateSourceSha: op.candidateSha,
    candidateSourceTree: op.candidateTree,
    sourceCiRunId: op.sourceCiRunId,
    ...source,
    ...Object.fromEntries(
      Object.entries(FILE_HASHES).map(([file, key]) => [key, nativeEvidenceHash(evidence[file])]),
    ),
    waiverSha256: nativeEvidenceHash(nativeEvidenceBytes(op.alertWaiver)),
  };
  validateNativeAdmissionBinding(op, admission, operationSha256);
  return { admission, evidence };
}
// Historical admission is attested by the successful installed rollout receipt. It is not
// current health/freshness and never depends on a subsequent controller checkout/redactor.
export function validateRetainedNativeAdmission(op, admission, operationSha256, evidence) {
  validateNativeAdmissionBinding(op, admission, operationSha256);
  exact(evidence, Object.keys(FILE_HASHES));
  for (const [file, field] of Object.entries(FILE_HASHES)) {
    canonical(evidence[file], file === NATIVE_ENVELOPE ? 16 * 1024 * 1024 : 4 * 1024 * 1024);
    need(nativeEvidenceHash(evidence[file]) === admission[field], 'retained_bytes');
  }
  ownerReceipt(op, evidence['owner-alert-waiver.json']);
  const unpacked = decodeNativeInputEnvelope(evidence[NATIVE_ENVELOPE], operationSha256);
  need(
    NATIVE_INPUTS.every((name) => unpacked[name].equals(evidence[name])),
    'retained_envelope',
  );
  const derived = canonical(evidence[NATIVE_DERIVED]);
  need(
    derived.schema === 'PHUB_TIMEWEB_MONITOR_READBACK_V2' &&
      derived.producerSourceSha === op.candidateSha &&
      derived.readAt === admission.readAt,
    'retained_header',
  );
  return { historicalAdmission: true, authorizesDeploy: false };
}
export function validateSealedNativeAdmission(op, admission, operationSha256, evidence) {
  validateRetainedNativeAdmission(op, admission, operationSha256, evidence);
  const repeated = createNativeWaiverAdmission(
    op,
    Object.fromEntries(NATIVE_INPUTS.map((file) => [file, evidence[file]])),
    {
      adapterSourceSha256: admission.adapterSourceSha256,
      reviewValidatorSha256: admission.reviewValidatorSha256,
    },
    admission.admittedAt,
    operationSha256,
  );
  need(
    same(repeated.admission, admission) &&
      repeated.evidence[NATIVE_DERIVED].equals(evidence[NATIVE_DERIVED]),
    'sealed_derivation',
  );
}
export function nativeAdmissionReceipt(admission) {
  return {
    monitoringPolicy: WAIVER_POLICY,
    alertTestStatus: WAIVER_STATUS,
    nativeMonitoringAdmissionSha256: nativeEvidenceHash(nativeEvidenceBytes(admission)),
    ownerAlertWaiverSha256: admission.waiverSha256,
    nativeMonitorReadbackSha256: admission.derivedReadbackSha256,
  };
}
