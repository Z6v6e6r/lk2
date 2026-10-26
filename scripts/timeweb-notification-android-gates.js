// One closed preservation profile for the existing Android FCM delivery boundary.
import { createHash } from 'node:crypto';
export const PRESERVED_NOTIFICATION_ROLLOUT_SCHEMA =
  'PHUB_TIMEWEB_API_WORKER_NOTIFICATION_0105_OPERATION_V3';
export const PRESERVED_NOTIFICATION_PLAN_SCHEMA = 'PHUB_TIMEWEB_NOTIFICATION_0105_ROLLOUT_PLAN_V3';
export const PRESERVED_NOTIFICATION_RECEIPT_SCHEMA =
  'PHUB_TIMEWEB_NOTIFICATION_0105_ROLLOUT_RECEIPT_V3';
export const isPreservedNotificationRollout = (op) =>
  op?.schema === PRESERVED_NOTIFICATION_ROLLOUT_SCHEMA;
const H = /^[a-f0-9]{64}$/;
const U = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = (code) => {
  throw Error('NOTIFICATION_ANDROID_' + code);
};
const digest = (v) =>
  createHash('sha256')
    .update(JSON.stringify(v) + '\n')
    .digest('hex');
function exact(v, fields) {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    JSON.stringify(Object.keys(v).sort()) !== JSON.stringify([...fields].sort())
  )
    fail('FIELDS');
}
export function validateAndroidGateExpectation(v) {
  exact(v, ['schema', 'snapshotSha256', 'enabledTenantCount', 'activeProviderCount']);
  if (
    v.schema !== 'PHUB_ANDROID_GATE_EXPECTATION_V1' ||
    !H.test(v.snapshotSha256 ?? '') ||
    ![v.enabledTenantCount, v.activeProviderCount].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    v.enabledTenantCount + v.activeProviderCount === 0
  )
    fail('EXPECTATION');
  return v;
}
export function androidGateSnapshotSha256(v) {
  exact(v, ['schema', 'runtime', 'providers']);
  if (
    v.schema !== 'PHUB_ANDROID_GATE_SNAPSHOT_V1' ||
    !Array.isArray(v.runtime) ||
    !Array.isArray(v.providers)
  )
    fail('SNAPSHOT');
  const timestamp = (value) => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value);
  let previous = '';
  const runtime = v.runtime.map((row) => {
    exact(row, ['tenantId', 'androidEnabled', 'updatedAt']);
    if (
      !U.test(row.tenantId ?? '') ||
      row.tenantId <= previous ||
      row.androidEnabled !== true ||
      !timestamp(row.updatedAt)
    )
      fail('RUNTIME');
    previous = row.tenantId;
    return { tenantId: row.tenantId, androidEnabled: true, updatedAt: row.updatedAt };
  });
  previous = '';
  const providers = v.providers.map((row) => {
    exact(row, [
      'tenantId',
      'id',
      'channel',
      'platform',
      'provider',
      'appId',
      'environment',
      'status',
      'credentialRefSha256',
      'updatedAt',
    ]);
    const key = row.tenantId + ':' + row.id;
    if (
      ![row.tenantId, row.id].every((id) => U.test(id ?? '')) ||
      key <= previous ||
      row.channel !== 'PUSH' ||
      row.platform !== 'ANDROID' ||
      row.provider !== 'FCM' ||
      row.appId !== 'ru.padlhub.app' ||
      row.environment !== 'SANDBOX' ||
      !['ACTIVE', 'DISABLED', 'DEGRADED'].includes(row.status) ||
      !H.test(row.credentialRefSha256 ?? '') ||
      !timestamp(row.updatedAt)
    )
      fail('PROVIDER');
    previous = key;
    return Object.fromEntries(
      [
        'tenantId',
        'id',
        'channel',
        'platform',
        'provider',
        'appId',
        'environment',
        'status',
        'credentialRefSha256',
        'updatedAt',
      ].map((k) => [k, row[k]]),
    );
  });
  return digest({ schema: v.schema, runtime, providers });
}
export function assertAndroidGateSnapshot(value, expected) {
  validateAndroidGateExpectation(expected);
  if (
    androidGateSnapshotSha256(value) !== expected.snapshotSha256 ||
    value.runtime.length !== expected.enabledTenantCount ||
    value.providers.filter((row) => row.status === 'ACTIVE').length !== expected.activeProviderCount
  )
    fail('SNAPSHOT_DRIFT');
  return true;
}
// Each subquery is one statement snapshot in the held READ ONLY fence. No credential bytes.
export const ANDROID_GATE_SNAPSHOT_SQL = `json_build_object(
 'schema','PHUB_ANDROID_GATE_SNAPSHOT_V1',
 'runtime',(SELECT coalesce(json_agg(json_build_object('tenantId',tenant_id,'androidEnabled',android_push_enabled,'updatedAt',extract(epoch from updated_at)::text) ORDER BY tenant_id),'[]'::json) FROM notifications.tenant_runtime_settings WHERE android_push_enabled),
 'providers',(SELECT coalesce(json_agg(json_build_object('tenantId',tenant_id,'id',id,'channel',channel,'platform',platform,'provider',provider,'appId',app_id,'environment',environment,'status',status,'credentialRefSha256',encode(sha256(convert_to(credential_ref,'UTF8')),'hex'),'updatedAt',extract(epoch from updated_at)::text) ORDER BY tenant_id,id),'[]'::json) FROM integration.notification_provider_accounts WHERE channel='PUSH' AND platform='ANDROID' AND provider='FCM' AND app_id='ru.padlhub.app' AND environment='SANDBOX'))`;
// Do not hide an ambiguous send behind an expired lease or disabled account/endpoint.
export const ANDROID_ALL_SENDING_SQL = `(SELECT count(*) FROM notifications.deliveries d
 JOIN integration.notification_endpoints e ON e.tenant_id=d.tenant_id AND e.id=d.endpoint_id
 JOIN integration.notification_provider_accounts a ON a.tenant_id=e.tenant_id AND a.id=e.provider_account_id
 WHERE d.channel='PUSH' AND d.state='SENDING' AND a.channel='PUSH' AND a.platform='ANDROID'
 AND a.provider='FCM' AND a.app_id='ru.padlhub.app' AND a.environment='SANDBOX')`;
export function validateFcmDrainProof(v, op, planSha256) {
  exact(v, ['schema', 'planSha256', 'snapshotSha256', 'workerId', 'sendingCount', 'observedAt']);
  if (
    v.schema !== 'PHUB_FCM_DRAIN_PROOF_V1' ||
    v.planSha256 !== planSha256 ||
    !H.test(planSha256 ?? '') ||
    v.snapshotSha256 !== op.androidGate.snapshotSha256 ||
    v.workerId !== op.expectedWorker.id ||
    v.sendingCount !== 0 ||
    !Number.isFinite(Date.parse(v.observedAt)) ||
    new Date(v.observedAt).toISOString() !== v.observedAt
  )
    fail('DRAIN_PROOF');
  return v;
}

export function validateFcmRollbackProof(v, op, planSha256) {
  exact(v, ['schema', 'planSha256', 'snapshotSha256', 'allSending', 'observedAt']);
  if (
    v.schema !== 'PHUB_FCM_ROLLBACK_READBACK_V1' ||
    v.planSha256 !== planSha256 ||
    !H.test(planSha256 ?? '') ||
    v.snapshotSha256 !== op.androidGate.snapshotSha256 ||
    !Number.isSafeInteger(v.allSending) ||
    v.allSending < 0 ||
    !Number.isFinite(Date.parse(v.observedAt)) ||
    new Date(v.observedAt).toISOString() !== v.observedAt
  )
    fail('ROLLBACK_PROOF');
  return v;
}

// Exact rollback boundary used by the host adapter. The immutable FIRST observation survives
// a crash after old8158 has resumed; current state is always read again, never repaired.
export async function verifyFcmHeldRollback(op, planSha256, io) {
  if (io.readGateState() !== 'HELD') fail('ROLLBACK_GATE');
  const current = await io.readDatabase(false);
  assertAndroidGateSnapshot(current.androidSnapshot, op.androidGate);
  if (!Number.isSafeInteger(current.allSending) || current.allSending < 0) fail('ROLLBACK_PROOF');
  const existing = io.readFirstProof();
  if (existing !== null) {
    validateFcmRollbackProof(existing, op, planSha256);
    return existing;
  }
  const proof = {
    schema: 'PHUB_FCM_ROLLBACK_READBACK_V1',
    planSha256,
    snapshotSha256: op.androidGate.snapshotSha256,
    allSending: current.allSending,
    observedAt: io.now(),
  };
  validateFcmRollbackProof(proof, op, planSha256);
  io.writeFirstProof(proof);
  return proof;
}
