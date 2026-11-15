import { describe, expect, it, vi } from 'vitest';
import { ownerDirectedTestChoices } from './timeweb-owner-directed-fixture.js';
import {
  reviewedNativeFixture,
  reviewedNativeBatchFixture,
  encodedNativeFixture as bytes,
  nativeFixtureHash as hash,
  NATIVE_ADAPTER_SHA256,
  SOURCE,
  NOW,
} from './timeweb-native-observability-fixtures.js';
import {
  WAIVER_OPERATION,
  OWNER_OPERATION,
  OWNER_RECEIPT,
  OWNER_KIND,
  createOwnerDirectedBinding,
  validateOwnerDirectedBinding,
  validateOwnerDirectedDecisions,
  ownerDirectedReceipt,
  WAIVER_STATUS,
  OWNER_DECISION_SHA256,
  NATIVE_INPUTS,
  NATIVE_DERIVED,
  NATIVE_ENVELOPE,
  validateRosterAlertWaiver,
  createNativeWaiverAdmission,
  validateRetainedNativeAdmission,
  validateSealedNativeAdmission,
  nativeAdmissionReceipt,
  decodeNativeInputEnvelope,
  ownerWaiverScopeSha256,
} from './timeweb-roster-alert-waiver.js';

describe('explicit owner-directed procedure preserves truthful skipped evidence', () => {
  function ownerFixture() {
    const op: Record<string, unknown> = { ...fixture().op, schema: OWNER_OPERATION };
    delete op.alertWaiver;
    op.ownerDecisions = ownerDirectedTestChoices(op);
    return op;
  }
  it('binds three independent decisions without native/provider inputs or synthetic PASS', () => {
    const op = ownerFixture(),
      sha = hash(bytes(op));
    validateOwnerDirectedDecisions(op, true, Date.parse(NOW));
    const binding = createOwnerDirectedBinding(op, sha);
    validateOwnerDirectedBinding(op, binding, sha);
    expect(ownerDirectedReceipt(binding)).toMatchObject({
      ownerDecisionPolicy: 'OWNER_SKIPPED_ALERT_DRILL_PROVIDER_READBACK_AND_REPEAT_RESTORE_V1',
      providerMonitoringStatus: 'NOT_CHECKED_OWNER_SKIPPED',
      alertTestStatus: 'NOT_TESTED_OWNER_DECLINED',
      restoreAdmissionPolicy: 'EXACT_PRIOR_FULL_RESTORE_OWNER_WAIVER_V1',
      repeatRestoreStatus: 'NOT_REPEATED_PRIOR_FULL_RESTORE_VERIFIED',
    });
    expect(JSON.stringify(binding)).not.toMatch(/PASS|readAt|admittedAt|captureSha256/u);
    expect(() =>
      createNativeWaiverAdmission(
        op,
        {},
        { adapterSourceSha256: '', reviewValidatorSha256: '' },
        NOW,
        sha,
      ),
    ).toThrow();
    expect(OWNER_RECEIPT).not.toBe(WAIVER_OPERATION);
    expect(OWNER_KIND).toBe('API_WORKER_WEB_OWNER_DIRECTED_CUTOVER');
  });
  it.each([
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
    'legacyBaseline',
  ])('rejects decision replay across %s', (key) => {
    const op = ownerFixture();
    op[key] = 'foreign';
    expect(() => validateOwnerDirectedDecisions(op)).toThrow();
  });
  it.each(['alertDrill', 'providerMonitoring', 'repeatedRestore'])(
    'rejects missing, broad or fabricated %s',
    (key) => {
      for (const field of [
        'schema',
        'authority',
        'scope',
        'status',
        'messageSha256',
        'scopeSha256',
        'reference',
        'receivedAt',
      ]) {
        const op = ownerFixture();
        const decisions = op.ownerDecisions as Record<string, Record<string, string>>;
        decisions[key]![field] = field === 'status' ? 'PASS' : 'foreign';
        expect(() => validateOwnerDirectedDecisions(op), `${key}.${field}`).toThrow();
        delete decisions[key]![field];
        expect(() => validateOwnerDirectedDecisions(op)).toThrow();
      }
    },
  );
  it('rejects extra native fields, wrong operation binding, expiry and cross-schema admission', () => {
    const op = ownerFixture(),
      sha = hash(bytes(op));
    const binding = createOwnerDirectedBinding(op, sha);
    for (const delta of [
      { providerSha256: 'a'.repeat(64) },
      { readAt: NOW },
      { providerMonitoringStatus: 'PASS' },
      { operationSha256: 'b'.repeat(64) },
    ])
      expect(() => validateOwnerDirectedBinding(op, { ...binding, ...delta }, sha)).toThrow();
    expect(() =>
      validateOwnerDirectedDecisions(op, true, Date.parse(String(op.expiresAt))),
    ).toThrow();
    for (const schema of [WAIVER_OPERATION, 'PHUB_TIMEWEB_API_WORKER_WEB_PRODUCTION_CUTOVER_V2'])
      expect(() => validateOwnerDirectedDecisions({ ...op, schema })).toThrow();
  });
});

function fixture(batch = false) {
  const reviewed = batch ? reviewedNativeBatchFixture() : reviewedNativeFixture();
  const ownerValue = {
    schema: 'PHUB_TIMEWEB_OWNER_MESSAGE_RECEIPT_V1',
    authority: 'ROOT_OPERATOR_ATTESTED_OWNER_MESSAGE_V1',
    decisionSha256: OWNER_DECISION_SHA256,
    reference:
      'codex-thread:00000000-0000-4000-8000-000000000000/message:msg_00000000-0000-4000-8000-000000000001',
    receivedAt: '2026-11-14T11:00:00.000Z',
  };
  const op = {
    schema: WAIVER_OPERATION,
    profile: 'production',
    target: 'lk2.padlhub.su',
    controllerSha: SOURCE,
    candidateSha: SOURCE,
    candidateTree: 'b'.repeat(40),
    sourceCiRunId: '100',
    publicationRunId: '101',
    artifactId: '102',
    artifactDigest: 'sha256:' + 'c'.repeat(64),
    manifestSha256: 'd'.repeat(64),
    backupOperationSha256: 'e'.repeat(64),
    expiresAt: '2026-11-14T12:30:00.000Z',
    legacyBaseline: { synthetic: 'unit binding only' },
    alertWaiver: {} as Record<string, unknown>,
  };
  const owner = bytes({ ...ownerValue, scopeSha256: ownerWaiverScopeSha256(op) });
  const baselineHash = hash(JSON.stringify(op.legacyBaseline));
  op.alertWaiver = {
    schema: 'PHUB_TIMEWEB_ROSTER_ALERT_WAIVER_V1',
    authority: 'ROOT_OPERATOR_ATTESTED_OWNER_MESSAGE_V1',
    scope: 'INDUCED_ALERT_DRILL_ONLY',
    status: WAIVER_STATUS,
    ownerMessageSha256: OWNER_DECISION_SHA256,
    ownerReceiptSha256: hash(owner),
    serverId: 8886471,
    projectId: 262717,
    legacyBaselineSha256: baselineHash,
    ...Object.fromEntries(
      [
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
      ].map((k) => [k, Reflect.get(op, k)]),
    ),
  };
  const inputs: Record<string, Buffer> = {
    'native-monitor-capture.json': bytes(reviewed.f.bundle),
    'native-monitor-review.json': bytes(reviewed.review),
    'native-monitor-public-trace.json': bytes(reviewed.trace),
    'owner-alert-waiver.json': owner,
  };
  const source = {
    adapterSourceSha256: NATIVE_ADAPTER_SHA256,
    reviewValidatorSha256: 'c'.repeat(64),
  };
  const operationHash = hash(bytes(op));
  return { op, baselineHash, inputs, source, operationHash };
}
function admit(f: ReturnType<typeof fixture>, at = NOW) {
  return createNativeWaiverAdmission(f.op, f.inputs, f.source, at, f.operationHash);
}
describe('one-operation owner waiver preserves truthful native health and historical custody', () => {
  it.each([false, true])(
    'requires native facts and retains admission/receipt for batch=%s',
    (batch) => {
      const f = fixture(batch);
      validateRosterAlertWaiver(f.op, f.baselineHash, true, Date.parse(NOW));
      const result = admit(f),
        receipt = nativeAdmissionReceipt(result.admission);
      expect(receipt.alertTestStatus).toBe('NOT_TESTED_OWNER_DECLINED');
      expect(receipt).not.toHaveProperty('alertReadbackSha256');
      expect(receipt).not.toHaveProperty('providerReadbackSha256');
      expect(Object.keys(result.evidence).sort()).toEqual(
        [...NATIVE_INPUTS, NATIVE_DERIVED, NATIVE_ENVELOPE].sort(),
      );
      validateSealedNativeAdmission(f.op, result.admission, f.operationHash, result.evidence);
      expect(
        validateRetainedNativeAdmission(f.op, result.admission, f.operationHash, result.evidence),
      ).toEqual({ historicalAdmission: true, authorizesDeploy: false });
    },
  );
  it.each([
    'schema',
    'authority',
    'scope',
    'status',
    'ownerMessageSha256',
    'ownerReceiptSha256',
    'serverId',
    'projectId',
    'legacyBaselineSha256',
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
  ])('rejects changed or absent waiver %s', (key) => {
    const f = fixture();
    f.op.alertWaiver[key] = 'changed';
    expect(() => validateRosterAlertWaiver(f.op, f.baselineHash)).toThrow();
    Reflect.deleteProperty(f.op.alertWaiver, key);
    expect(() => validateRosterAlertWaiver(f.op, f.baselineHash)).toThrow();
  });
  it.each([
    'PHUB_TIMEWEB_API_WEB_PRODUCTION_CUTOVER_V1',
    'PHUB_TIMEWEB_API_WORKER_WEB_PRODUCTION_CUTOVER_V2',
    'PHUB_TIMEWEB_API_WEB_DIRECT_OPERATION_V2',
    'PHUB_TIMEWEB_JOIN_DORMANT_OPERATION_V1',
    'beta',
  ])('cannot move the waiver to %s', (schema) => {
    const f = fixture();
    f.op.schema = schema;
    expect(() => validateRosterAlertWaiver(f.op, f.baselineHash)).toThrow();
  });
  it('expires new admission without expiring exact historical custody', () => {
    const f = fixture(),
      result = admit(f);
    expect(() =>
      validateRosterAlertWaiver(f.op, f.baselineHash, true, Date.parse(f.op.expiresAt)),
    ).toThrow(/expired/);
    validateRetainedNativeAdmission(f.op, result.admission, f.operationHash, result.evidence);
    expect(() => admit(f, '2026-11-14T13:00:00.000Z')).toThrow();
    expect(() => admit(f, '2026-11-14T11:59:00.000Z')).toThrow();
  });
  it('refuses unreviewed, changed, noncanonical or incomplete inputs', () => {
    for (const name of NATIVE_INPUTS) {
      const f = fixture();
      f.inputs[name] = Buffer.concat([f.inputs[name]!, Buffer.from(' ')]);
      expect(() => admit(f), name).toThrow();
    }
    const f = fixture();
    Reflect.deleteProperty(f.inputs, NATIVE_INPUTS[0]!);
    expect(() => admit(f)).toThrow();
  });
  it('rejects changed source, review, operation and owner receipt', () => {
    const source = fixture();
    source.source.adapterSourceSha256 = 'f'.repeat(64);
    expect(() => admit(source)).toThrow();
    const f = fixture();
    const result = admit(f);
    expect(() =>
      validateRetainedNativeAdmission(f.op, result.admission, 'f'.repeat(64), result.evidence),
    ).toThrow();
    f.inputs['owner-alert-waiver.json'] = bytes({ synthetic: 'unapproved' });
    expect(() => admit(f)).toThrow();
  });
  it('checks every retained file and every admission hash without a current-source dependency', () => {
    const f = fixture(),
      result = admit(f);
    for (const file of Object.keys(result.evidence)) {
      const changed = { ...result.evidence, [file]: bytes({ tampered: true }) };
      expect(
        () => validateRetainedNativeAdmission(f.op, result.admission, f.operationHash, changed),
        file,
      ).toThrow();
    }
    for (const field of [
      'candidateSourceSha',
      'candidateSourceTree',
      'sourceCiRunId',
      'policy',
      'operationSha256',
      'captureSha256',
      'reviewSha256',
      'traceSha256',
      'derivedReadbackSha256',
      'ownerReceiptSha256',
      'waiverSha256',
    ]) {
      const changed = { ...result.admission, [field]: 'f'.repeat(64) };
      expect(
        () => validateRetainedNativeAdmission(f.op, changed, f.operationHash, result.evidence),
        field,
      ).toThrow();
    }
    // No current clock/Git/config is an input to historical custody.
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw Error('current clock forbidden');
    });
    try {
      validateRetainedNativeAdmission(f.op, result.admission, f.operationHash, result.evidence);
    } finally {
      clock.mockRestore();
    }
  });
  it.each([
    'candidateSha',
    'controllerSha',
    'candidateTree',
    'sourceCiRunId',
    'publicationRunId',
    'artifactId',
    'artifactDigest',
    'manifestSha256',
    'backupOperationSha256',
    'expiresAt',
  ])('cannot replay an owner receipt into a new %s', (key) => {
    const f = fixture();
    Reflect.set(f.op, key, key === 'expiresAt' ? '2026-11-14T12:45:00.000Z' : '0'.repeat(40));
    f.op.alertWaiver[key] = Reflect.get(f.op, key);
    expect(() => admit(f)).toThrow(/owner_receipt/);
  });
  it('rejects envelope schema, operation, file inventory, types and noncanonical bytes', () => {
    const f = fixture(),
      result = admit(f);
    const envelope = JSON.parse(result.evidence[NATIVE_ENVELOPE]!.toString()) as {
      schema: string;
      operationSha256: string;
      files: Record<string, string>;
    };
    expect(
      Object.keys(decodeNativeInputEnvelope(result.evidence[NATIVE_ENVELOPE]!, f.operationHash)),
    ).toEqual(NATIVE_INPUTS);
    for (const delta of [
      { schema: 'OTHER' },
      { operationSha256: '0'.repeat(64) },
      { extra: true },
      { files: {} },
      { files: { ...envelope.files, 'owner-alert-waiver.json': 7 } },
    ]) {
      expect(() =>
        decodeNativeInputEnvelope(bytes({ ...envelope, ...delta }), f.operationHash),
      ).toThrow();
    }
    expect(() =>
      decodeNativeInputEnvelope(
        Buffer.concat([result.evidence[NATIVE_ENVELOPE]!, Buffer.from(' ')]),
        f.operationHash,
      ),
    ).toThrow();
    expect(() =>
      decodeNativeInputEnvelope(Buffer.alloc(16 * 1024 * 1024 + 1), f.operationHash),
    ).toThrow();
  });
  it('uses sealed snapshots when all operator input Buffers are subsequently replaced', () => {
    const f = fixture(),
      result = admit(f);
    for (const name of NATIVE_INPUTS) f.inputs[name] = bytes({ changed: 'operator path' });
    validateSealedNativeAdmission(f.op, result.admission, f.operationHash, result.evidence);
  });
});
