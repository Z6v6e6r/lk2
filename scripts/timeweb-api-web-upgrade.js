import {
  isR1ApiWorker119,
  R1_API_WORKER119_INSTALLED,
} from './timeweb-r1-api-worker119-profile.js';
import {
  fcmGateBinding,
  fcmGateComposeOverride,
  readFcmDeliveryGate,
  validateFcmGateRuntime,
} from './timeweb-notification-delivery-gate.js';
import { isPreservedNotificationRollout } from './timeweb-notification-android-gates.js';
// Explicit manual mode of the enrolled standard controller. Never execute candidate source.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  readdirSync,
  linkSync,
  unlinkSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, basename } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { validateCanonicalManifest } from './timeweb-release-manifest-contract.js';
import { validateTimewebRuntimeSecretPaths } from './render-timeweb-beta-release-env.js';
import { validateInstalledApiWorkerEvidence } from './timeweb-api-worker-contract.js';
import { verifySourceCi } from './verify-source-ci.js';
import { parseStrictJson } from './strict-json.js';
import {
  deriveNativeMonitorReadback,
  NATIVE_MONITOR_BATCH_BUNDLE,
} from './timeweb-native-observability.js';
import { verifyNativeCaptureReview } from './timeweb-native-capture-review.js';
import {
  CUP_SUPPORT_LEGACY_RUNTIME_SET_ID,
  describeTimewebRuntimeSecretSet,
  parseTimewebScheduleRuntimeEnvironment,
  parseTimewebSecretEnvironment,
  SCHEDULE_LEGACY_RUNTIME_SET_ID,
  validateTimewebDormantJoinSecretDelta,
  validateTimewebCupSupportHandoffSecretDelta,
  validateTimewebScheduleRunningEnvironment,
  validateTimewebScheduleSecretDelta,
  transitionPreparedTimewebRuntimeSecrets,
} from './provision-timeweb-beta-runtime-secrets.js';
import { validateTimewebCupSupportHandoffEnvironment } from './verify-timeweb-deployment-contract.js';
import {
  JOIN_PLAN,
  JOIN_POST105_BACKUP_SCHEMA,
  JOIN_RECEIPT,
  JOIN_INSTALLED_KIND,
  JOIN_RUNTIME_ANCHOR,
  isJoinOperation,
  validateJoinOperation,
  validateJoinRuntimeTail,
  validateJoinNotificationSnapshot,
  validateJoinReceipt,
  validateJoinRunningEnvironment,
  buildJoinInstalledDescriptor,
  validateJoinObservation,
  validateJoinPost105BackupOperation,
  validateJoinPost105BackupBundle,
} from './timeweb-join-dormant-profile.js';
import {
  validateTimewebMonitorReadback,
  validateTimewebAlertReadback,
} from './produce-timeweb-api-web-observability-evidence.js';
import {
  validateTimewebMonitoringEvidence,
  validateTimewebProviderMonitoringEvidence,
} from './verify-timeweb-api-web-observability.js';
import {
  OWNER_PLAN,
  OWNER_RECEIPT,
  OWNER_KIND,
  CANONICAL_PLAN,
  CANONICAL_RECEIPT,
  CANONICAL_KIND,
  CANONICAL_FRESH_OPERATION,
  CANONICAL_FRESH_RECEIPT,
  isCanonicalOwnerDirectedUpgrade,
  CANONICAL_OWNER_POLICY,
  CANONICAL_PRIOR_RESTORE_POLICY,
  OWNER_POLICY,
  PROVIDER_SKIPPED,
  FRESH_BACKUP_OPERATION,
  FRESH_BACKUP_RECEIPT,
  PRIOR_RESTORE_POLICY,
  isOwnerDirectedCutover,
  createOwnerDirectedBinding,
  validateOwnerDirectedBinding,
  ownerDirectedReceipt,
  WAIVER_PLAN,
  WAIVER_RECEIPT,
  WAIVER_KIND,
  WAIVER_POLICY,
  WAIVER_STATUS,
  NATIVE_INPUTS,
  NATIVE_DERIVED,
  NATIVE_ENVELOPE,
  decodeNativeInputEnvelope,
  isWaivedRosterCutover,
  createNativeWaiverAdmission,
  validateRetainedNativeAdmission,
  validateSealedNativeAdmission,
  nativeAdmissionReceipt,
} from './timeweb-roster-alert-waiver.js';
import {
  ADOPTED_MANUAL_FULL_KIND,
  validateAdoptedBaseline,
} from './timeweb-adopt-manual-baseline.js';
import {
  CUTOVER_RECEIPT,
  ROSTER_CUTOVER_RECEIPT,
  ROSTER_CUTOVER_KIND,
  isRosterCutover,
  cutoverPlanSchema,
  cutoverReceiptSchema,
  cutoverInstalledKind,
  validateRosterCutoverObservation,
  isProductionCutover,
  validateProductionCutover,
  legacyBaselineHash,
  validateCanonicalBaseline,
  isLegacyProductionCutover,
  cutoverBaseline,
  cutoverBaselineHash,
  cutoverBaselineField,
  legacyReleaseEnvPath,
  legacyBuildArchivePath,
  legacyEnvironment,
  validateLegacyRuntime,
  validateLegacyRun,
  validateLegacyArtifact,
  validateLegacyBuildRecord,
  validateCutoverLineage,
  validateCutoverBackupOperation,
  assertCutoverBackupFiles,
  validateCutoverPlanProofs,
  assertCutoverReadbackFreshness,
  COMPONENTS,
} from './timeweb-production-cutover.js';

import {
  STATION_APPLICATION,
  STATION_TREE,
  STATION_OPERATION,
  STATION_PLAN,
  STATION_RECEIPT,
  STATION_ALERT_STATUS,
  STATION_PROVIDER_STATUS,
  STATION_KIND,
  STATION_POSTGRES,
  STATION_SNAPSHOT,
  STATION_BACKUP,
  STATION_CUP_RECEIPT,
  isStationRollout,
  isStationDirectOperation,
  validateStationOperation,
  validateStationWindow,
  validateStationSourceTail,
  validateStationDirectControllerTail,
  validateStationDirectControllerReview,
  stationObservationIdentity,
  validateStationBackupMetadata,
  validateStationDatabaseReadback,
  validateStationRetainedAdmission,
  validateStationRuntimeEnvironment,
  validateStationObservation,
} from './timeweb-station-rollout.js';
import { CUP_0119, CUP_0119_TARGET, buildCup0119Sql } from './timeweb-cup-0119-migration.js';

const ROOT = '/opt/phub/timeweb-beta';
const SOURCE = `${ROOT}/standard/source`;
const REQUEST = `${ROOT}/operator/api-web-upgrade.json`;
const CONFIG = '/etc/phub/timeweb-beta-standard-delivery.json';
const LOCK = `${ROOT}/standard/active`;
const COMPOSE = `${SOURCE}/deploy/timeweb/compose.beta.yaml`;
const RUNTIME = '/etc/phub/timeweb-beta';
const REPO = 'Z6v6e6r/lk2';
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{40}-[1-9][0-9]*-1$/;
const NUMBER = /^[1-9][0-9]*$/;
const CALLBACK_DIRECT_POLICY = 'CALLBACK_DIRECT_OBSERVATION_V1';
const CALLBACK_DIRECT_EXPIRY = '2026-10-06T00:00:00.000Z';
const CALLBACK_DIRECT_CANDIDATE = {
  candidateSha: '0d6078be7a50ed3f5761d66071527be003bd568f',
  candidateTree: '5e50be3cb680e0c9db5faf3fcf3fca57ccdedaa4',
  sourceCiRunId: '37034485776',
  publicationRunId: '37038298584',
  artifactId: '11241473445',
  artifactDigest: 'sha256:64b2cbf7f6613d62f3aa08d6da6c65c6d5ff50ebc88e19c5bcbd2239237913e9',
  manifestSha256: '9d631c9adf4ffce0ab68527bcf99828faa72ee1c51f655bf5325c97f435d042e',
  previousReleaseId: 'c43e9dc8da3eb19a1684ed28e989aafacdb5d8bf-36629104876-1',
  apiImage:
    'ghcr.io/z6v6e6r/phub-api@sha256:c798c0f881daecca72500d0e3e2d525f77ee4df500c2f662a346b521fa9d1681',
  webImage:
    'ghcr.io/z6v6e6r/phub-web@sha256:887455ea273abc6138bdb176f4af82295c37d56ac9a7a96b83c006e5f4d72b9e',
};
const SECRET_NAMES = [
  'api.env',
  'worker.env',
  'realtime.env',
  'migrator.env',
  '.release-identity.json',
];
const SCHEDULE_OPERATION = 'PHUB_TIMEWEB_API_WEB_SCHEDULE_READ_OPERATION_V1';
const SCHEDULE_BACKUP_SCHEMA = 'PHUB_TIMEWEB_BACKUP_SCHEDULE_0A4_API_WEB_V1';
const SCHEDULE_DISK_BACKUP_SCHEMA = 'PHUB_TIMEWEB_BACKUP_SCHEDULE_0A4_DISK_V1';
const SCHEDULE_PREDECESSOR_RELEASE = '0a4d640965e921e6d06eeb22de6cc6dcae07f0b1-45011215364-1';
const SCHEDULE_LEDGER = '4dab86cb18f7e3db7a0598cd657eaebc86f07d5af497dc0eea2e33900b6526c1';
const SCHEDULE_PLAN = 'PHUB_TIMEWEB_API_WEB_SCHEDULE_READ_PLAN_V1';
const SCHEDULE_RECEIPT = 'PHUB_TIMEWEB_API_WEB_SCHEDULE_READ_RECEIPT_V1';
const SCHEDULE_INSTALLED_KIND = 'API_WEB_SCHEDULE_READ';
const SCHEDULE_PHASES = ['SECRET_SWAP_INTENT', 'SECRETS_ACTIVE', 'BASELINE_INTENT'];
const isScheduleOperation = (value) => value?.schema === SCHEDULE_OPERATION;
const APP_ONLY_OPERATION = 'PHUB_TIMEWEB_API_WEB_APP_ONLY_OPERATION_V1';
const APP_ONLY_PLAN = 'PHUB_TIMEWEB_API_WEB_APP_ONLY_PLAN_V1';
const APP_ONLY_RECEIPT = 'PHUB_TIMEWEB_API_WEB_APP_ONLY_RECEIPT_V1';
const APP_ONLY_BACKUP = 'PHUB_TIMEWEB_APP_ONLY_FRESH_BACKUP_V1';
const APP_ONLY_BACKUP_RECEIPT = 'PHUB_TIMEWEB_APP_ONLY_FRESH_DUMP_V1';
const APP_ONLY_BACKUP_POLICY = 'APP_ONLY_WITH_VERIFIED_PRIOR_RESTORE_V1';
const CUP_SUPPORT_OPERATION = 'PHUB_TIMEWEB_API_WEB_CUP_SUPPORT_OPERATION_V1';
const CUP_SUPPORT_PLAN = 'PHUB_TIMEWEB_API_WEB_CUP_SUPPORT_PLAN_V1';
const CUP_SUPPORT_RECEIPT = 'PHUB_TIMEWEB_API_WEB_CUP_SUPPORT_RECEIPT_V1';
const CUP_SUPPORT_BACKUP = 'PHUB_TIMEWEB_CUP_SUPPORT_FRESH_BACKUP_V1';
const CUP_SUPPORT_BACKUP_RECEIPT = 'PHUB_TIMEWEB_CUP_SUPPORT_FRESH_DUMP_V1';
const CUP_SUPPORT_BACKUP_POLICY = 'CUP_SUPPORT_FRESH_DUMP_INTEGRITY_ONLY_V1';
const CUP_SUPPORT_ALERT_MESSAGE =
  'a6414dc35154adabb89b9d04b3e446f1ec85746bbaf0f0a74677f7eeb2546446';
const CUP_SUPPORT_ALERT_STATUS = 'REPLACED_BY_OWNER_APPROVED_DIRECT_HTTP';
const CUP_SUPPORT_DIRECT_OBSERVATION = 'PHUB_TIMEWEB_CUP_SUPPORT_DIRECT_OBSERVATION_V1';
const CUP_SUPPORT_NATIVE_EVIDENCE = 'PHUB_TIMEWEB_CUP_SUPPORT_NATIVE_MONITOR_EVIDENCE_V1';
const CUP_SUPPORT_APPLICATION = '62da4b92e65a02488f893b7ebc53d8b86faca9c9';
const CUP_SUPPORT_APPLICATION_TREE = '08e6eafb72c67065c78ccb1409c46e6d6358bb62';
const CUP_SUPPORT_PREDECESSOR = 'b81a2ec93f384d3d40aeb9b39eabdeaa4929ff61-45606826648-1';
const isCupSupportOperation = (value) => value?.schema === CUP_SUPPORT_OPERATION;
const isAppOnlyOperation = (value) =>
  value?.schema === APP_ONLY_OPERATION || isCupSupportOperation(value);

// These root-owned controller modules and their tests are not runtime inputs.
const APP_ONLY_CONTROLLER_POLICY_FILES = new Set([
  'scripts/timeweb-api-web-upgrade.js',
  'scripts/timeweb-api-web-upgrade.test.ts',
  'scripts/control-timeweb-database-backup.py',
  'scripts/test-timeweb-database-backup.py',
]);
const REVIEWED_APP_ONLY_READ_CHANGES = new Map([
  [
    'apps/api/src/locations/location-routes.test.ts',
    ['5cc449d84bb3f4b6e2fa345407826807cb6235e4', 'ed77394ea6e841d1ab79b4eb69339c35f4b20135'],
  ],
  [
    'packages/locations/src/index.test.ts',
    ['b7136a0d44acb6b97fd0fbacdb688149c213143e', 'c7006fc17eab6603b76fd05f2370db46e26b650b'],
  ],
  [
    'packages/locations/src/index.ts',
    ['b7fa4d093ce4a66624e919db649559ba3c43df7c', 'c17679b5ac2d5e9867decc9c504290f3c120bd96'],
  ],
  [
    'contracts/openapi/user/v1/openapi.yaml',
    ['8e412186cfea1f7c18de1384e0dbdcbda877d3ed', '889da8bba985597db0704f637a08e08c2c3d82c6'],
  ],
]);
const SCHEDULE_MONITORING_POLICY = 'SCHEDULE_OWNER_DIRECT_API_WEB_V1';
const SCHEDULE_MONITORING_MESSAGE =
  'cd676c7ab14c553671966ee0feede57c53c833b3075140ac1407e8adb108334e';
const SCHEDULE_DIRECT_OBSERVATION = 'PHUB_TIMEWEB_SCHEDULE_DIRECT_OBSERVATION_V1';
const SCHEDULE_MONITORING_STATUS = {
  monitoringPolicy: SCHEDULE_MONITORING_POLICY,
  providerMonitoringStatus: PROVIDER_SKIPPED,
  alertTestStatus: 'NOT_REQUIRED_OWNER_WAIVED',
};
export function scheduleMonitoringScopeSha256({ ownerProviderMonitoringWaiver, ...operation }) {
  return hash(JSON.stringify({ serverId: 8886471, projectId: 262717, ...operation }));
}
function validateScheduleMonitoringWaiver(op) {
  const waiver = op.ownerProviderMonitoringWaiver;
  exact(waiver, ['schema', 'authority', 'messageSha256', 'reference', 'receivedAt', 'scopeSha256']);
  if (
    waiver.schema !== 'PHUB_TIMEWEB_SCHEDULE_PROVIDER_MONITORING_WAIVER_V1' ||
    waiver.authority !== 'ROOT_OPERATOR_ATTESTED_OWNER_MESSAGE_V1' ||
    waiver.messageSha256 !== SCHEDULE_MONITORING_MESSAGE ||
    waiver.reference !== `codex-user-message-sha256:${waiver.messageSha256}` ||
    waiver.scopeSha256 !== scheduleMonitoringScopeSha256(op) ||
    !Number.isFinite(Date.parse(waiver.receivedAt)) ||
    new Date(waiver.receivedAt).toISOString() !== waiver.receivedAt ||
    Date.parse(waiver.receivedAt) >= Date.parse(op.expiresAt) ||
    Date.parse(op.expiresAt) - Date.parse(waiver.receivedAt) > 86_400_000
  )
    fail('schedule_monitoring_waiver');
}
function scheduleMonitoringReceipt(op) {
  return {
    ...SCHEDULE_MONITORING_STATUS,
    ownerProviderMonitoringWaiverSha256: hash(JSON.stringify(op.ownerProviderMonitoringWaiver)),
  };
}

export function cupSupportAlertScopeSha256({ ownerAlertDecision, ...operation }) {
  return hash(JSON.stringify({ serverId: 8886471, projectId: 262717, ...operation }));
}

function validateCupSupportAlertDecision(op) {
  const decision = op.ownerAlertDecision;
  exact(decision, [
    'schema',
    'authority',
    'messageSha256',
    'reference',
    'receivedAt',
    'scopeSha256',
  ]);
  const receivedAt = Date.parse(decision.receivedAt);
  if (
    decision.schema !== 'PHUB_TIMEWEB_CUP_SUPPORT_ALERT_DECISION_V1' ||
    decision.authority !== 'ROOT_OPERATOR_ATTESTED_OWNER_MESSAGE_V1' ||
    decision.messageSha256 !== CUP_SUPPORT_ALERT_MESSAGE ||
    decision.reference !== `codex-user-message-sha256:${CUP_SUPPORT_ALERT_MESSAGE}` ||
    decision.scopeSha256 !== cupSupportAlertScopeSha256(op) ||
    !Number.isFinite(receivedAt) ||
    new Date(receivedAt).toISOString() !== decision.receivedAt ||
    receivedAt >= Date.parse(op.expiresAt) ||
    Date.parse(op.expiresAt) - receivedAt > 86_400_000
  )
    fail('cup_support_alert_decision');
}

function cupSupportAlertReceipt(op) {
  return {
    alertTestStatus: CUP_SUPPORT_ALERT_STATUS,
    ownerAlertDecisionSha256: hash(JSON.stringify(op.ownerAlertDecision)),
  };
}

function validateScheduleExpiry(value, minimumMs = 0) {
  const remaining = Date.parse(value) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= minimumMs || remaining > 3_600_000)
    fail('schedule_operation_expired');
}
const CONTROLLER_FILES = new Set([
  'scripts/run-timeweb-standard-delivery.js',
  'scripts/timeweb-critical-web.js',
  'scripts/timeweb-critical-web.test.ts',
  'scripts/timeweb-api-web-upgrade.js',
  'scripts/timeweb-api-web-upgrade.test.ts',
  'scripts/timeweb-production-cutover.js',
  'scripts/timeweb-production-cutover.test.ts',
  'scripts/timeweb-api-worker-contract.d.ts',
  'scripts/control-timeweb-location-photo-acl.py',
  'scripts/control-timeweb-location-photo-acl.test.ts',
  'scripts/timeweb-adopt-manual-baseline.js',
  'scripts/timeweb-adopt-manual-baseline.d.ts',
  'scripts/timeweb-adopt-manual-baseline.test.ts',
  'scripts/rehearse-timeweb-standard-compose.js',
  'scripts/timeweb-standard-compose.test.ts',
  'scripts/verify-timeweb-api-web-observability.js',
  'scripts/verify-timeweb-api-web-observability.d.ts',
  'docs/runbooks/timeweb-standard-delivery.md',
]);
// One reviewed, nonexecuted ancestry bridge; never a runtime/migration allowance.
export const INERT_CONTROLLER_BRIDGE = {
  candidate: '5429a69ca350c3277b8e6de4c2f5714176ac3f8e',
  sha: '9bbe61d63ba078f54d683d561ff097e96b59274e',
  blobs: {
    'docs/plans/customer-core/ARCHITECTURE.md': '926db8080242ef884b922087aedb8d39dac0e07e',
    'docs/plans/customer-core/AUDIT.md': 'cc562a50c1a63f50ca143bd08224c0ed437c00b2',
    'docs/plans/customer-core/MIGRATION_AND_ACCEPTANCE.md':
      'c80f7ac6af15e7e4382c49a2138850becd08154d',
    'docs/plans/customer-core/NEXT_CODEX_TASK.md': '987d8aa4aa58d736dc3be2a1f1317c84fd8e66c2',
    'docs/plans/customer-core/ROADMAP.md': '1ae333d67475eb7ac3bfedc6f222d223ae60aabb',
    'packages/database/migrations/0096_profile_contacts.sql':
      'dc9171185f0a7b75d80ecde64c6b08b4f3baa4c1',
    'packages/database/src/contact-repository-postgres.test.ts':
      '3a48fd7cb7b2bb796dfad7f7b913df31ae8b5258',
    'packages/database/src/contact-repository.test.ts': '70b5a7a0d89949a0e8326dd4ed1dab324bd0f371',
    'packages/database/src/contact-repository.ts': 'fffe999d05e73170a516d758cd210657171d18c1',
  },
};
export function validateControllerBridge(candidate, bridge, entries) {
  if (
    candidate !== INERT_CONTROLLER_BRIDGE.candidate ||
    bridge !== INERT_CONTROLLER_BRIDGE.sha ||
    !Array.isArray(entries) ||
    entries.length !== Object.keys(INERT_CONTROLLER_BRIDGE.blobs).length ||
    new Set(entries.map((v) => v.path)).size !== entries.length ||
    entries.some(
      (v) =>
        v.status !== 'A' ||
        v.mode !== '100644' ||
        v.type !== 'blob' ||
        INERT_CONTROLLER_BRIDGE.blobs[v.path] !== v.oid,
    )
  )
    fail('inert_controller_bridge');
}
const environment = {
  PATH: '/usr/bin:/bin',
  HOME: '/root',
  LANG: 'C',
  DOCKER_CONFIG: '/root/.docker',
  DOCKER_HOST: 'unix:///var/run/docker.sock',
  COMPOSE_PROFILES: '',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_NO_PROMISOR_FETCH: '1',
  GIT_GRAFT_FILE: '/dev/null',
  GIT_ALTERNATE_OBJECT_DIRECTORIES: '',
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code) => {
  throw new Error(code);
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
function exact(value, keys) {
  if (!value || Array.isArray(value) || !equal(Object.keys(value).sort(), [...keys].sort()))
    fail('invalid_keys');
}
// Historical admission owns its bounded reader. The deployed renderer remains byte-frozen.
function decodePredecessorArchiveUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('canonical_artifact_filename');
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function extractCanonicalPredecessorArtifactPair(archiveBytes) {
  if (archiveBytes.length > 4_194_304 || archiveBytes.length < 22)
    fail('canonical_artifact_archive_size');
  let eocd = -1;
  const searchStart = Math.max(0, archiveBytes.length - 65_557);
  for (let offset = archiveBytes.length - 22; offset >= searchStart; offset -= 1) {
    if (archiveBytes.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) fail('canonical_artifact_archive');
  const entryCount = archiveBytes.readUInt16LE(eocd + 10);
  const directorySize = archiveBytes.readUInt32LE(eocd + 12);
  const directoryOffset = archiveBytes.readUInt32LE(eocd + 16);
  if (
    entryCount !== 2 ||
    archiveBytes.readUInt16LE(eocd + 8) !== entryCount ||
    archiveBytes.readUInt16LE(eocd + 4) !== 0 ||
    archiveBytes.readUInt16LE(eocd + 6) !== 0 ||
    eocd + 22 + archiveBytes.readUInt16LE(eocd + 20) !== archiveBytes.length ||
    directoryOffset + directorySize !== eocd
  )
    fail('canonical_artifact_inventory');

  const files = new Map();
  const ranges = [];
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd) fail('canonical_artifact_archive');
    if (archiveBytes.readUInt32LE(cursor) !== 0x02014b50) fail('canonical_artifact_archive');
    const flags = archiveBytes.readUInt16LE(cursor + 8);
    const method = archiveBytes.readUInt16LE(cursor + 10);
    const expectedCrc = archiveBytes.readUInt32LE(cursor + 16);
    const compressedSize = archiveBytes.readUInt32LE(cursor + 20);
    const uncompressedSize = archiveBytes.readUInt32LE(cursor + 24);
    const nameLength = archiveBytes.readUInt16LE(cursor + 28);
    const extraLength = archiveBytes.readUInt16LE(cursor + 30);
    const commentLength = archiveBytes.readUInt16LE(cursor + 32);
    const localOffset = archiveBytes.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameLength + extraLength + commentLength > eocd)
      fail('canonical_artifact_archive');
    const name = decodePredecessorArchiveUtf8(
      archiveBytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    if (
      flags & 0x1 ||
      ![0, 8].includes(method) ||
      !['release-manifest.json', 'release-manifest.sha256'].includes(name) ||
      files.has(name) ||
      uncompressedSize > 1_048_576 ||
      localOffset + 30 > directoryOffset ||
      archiveBytes.readUInt32LE(localOffset) !== 0x04034b50
    )
      fail('canonical_artifact_inventory');
    const localNameLength = archiveBytes.readUInt16LE(localOffset + 26);
    const localExtraLength = archiveBytes.readUInt16LE(localOffset + 28);
    if (
      archiveBytes.readUInt16LE(localOffset + 6) !== flags ||
      archiveBytes.readUInt16LE(localOffset + 8) !== method ||
      localOffset + 30 + localNameLength + localExtraLength > directoryOffset ||
      !archiveBytes
        .subarray(localOffset + 30, localOffset + 30 + localNameLength)
        .equals(archiveBytes.subarray(cursor + 46, cursor + 46 + nameLength))
    )
      fail('canonical_artifact_archive');
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > directoryOffset) fail('canonical_artifact_archive');
    ranges.push({ start: localOffset, end: dataEnd });
    let contents;
    try {
      const compressed = archiveBytes.subarray(dataStart, dataEnd);
      contents =
        method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, { maxOutputLength: 1_048_576 });
    } catch {
      fail('canonical_artifact_archive');
    }
    if (contents.length !== uncompressedSize || crc32(contents) !== expectedCrc)
      fail('canonical_artifact_archive');
    files.set(name, contents);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== directoryOffset + directorySize) fail('canonical_artifact_archive');
  ranges.sort((a, b) => a.start - b.start);
  if (ranges.some((range, index) => index > 0 && range.start < ranges[index - 1].end))
    fail('canonical_artifact_archive');
  return files;
}

export function validateApiWebOperation(value) {
  if (isProductionCutover(value)) return validateProductionCutover(value);
  if (isJoinOperation(value)) return validateJoinOperation(value);
  if (isStationRollout(value)) return validateStationOperation(value, validateApiWebOperation);
  if (isAppOnlyOperation(value)) {
    const { backupOperationSha256, expiresAt, ...fields } = value;
    const cupSupport = isCupSupportOperation(value);
    const {
      expectedCurrentSecretSetReleaseId,
      candidateSecretHashes,
      ownerRestoreDecisionSha256,
      ownerAlertDecision,
      ...operation
    } = fields;
    const base = cupSupport ? operation : fields;
    const suffix = cupSupport ? '_CUP_SUPPORT_STAGING' : '_APP_ONLY_PRIOR_RESTORE';
    if (
      value.profile !== 'production' ||
      value.controllerSha !== value.candidateSha ||
      !HASH.test(backupOperationSha256 ?? '') ||
      !Number.isFinite(Date.parse(expiresAt)) ||
      new Date(expiresAt).toISOString() !== expiresAt ||
      typeof base.confirmation !== 'string' ||
      !base.confirmation.endsWith(suffix)
    )
      fail('app_only_operation');
    if (cupSupport) {
      if (
        expectedCurrentSecretSetReleaseId !== CUP_SUPPORT_LEGACY_RUNTIME_SET_ID ||
        !HASH.test(ownerRestoreDecisionSha256 ?? '') ||
        [value.expectedApi, value.expectedWeb].some(
          (previous) => previous?.releaseId !== CUP_SUPPORT_PREDECESSOR,
        )
      )
        fail('cup_support_operation');
      exact(candidateSecretHashes, SECRET_NAMES);
      if (SECRET_NAMES.some((name) => !HASH.test(candidateSecretHashes[name] ?? '')))
        fail('cup_support_secret_hashes');
      validateCupSupportAlertDecision(value);
    }
    validateApiWebOperation({
      ...base,
      schema: 'PHUB_TIMEWEB_API_WEB_OPERATION_V1',
      confirmation: base.confirmation.slice(0, -suffix.length),
    });
    return value;
  }
  if (isScheduleOperation(value)) {
    const {
      expectedCurrentSecretSetReleaseId,
      candidateSecretHashes,
      backupOperationSha256,
      preexistingSidecarArchiveSha256,
      ownerProviderMonitoringWaiver,
      expiresAt,
      ...base
    } = value;
    const suffix =
      ownerProviderMonitoringWaiver === undefined
        ? '_SCHEDULE_READ'
        : '_SCHEDULE_READ_WITHOUT_PROVIDER_MONITORING';
    if (
      value.profile !== 'production' ||
      value.controllerSha !== value.candidateSha ||
      !ID.test(expectedCurrentSecretSetReleaseId ?? '') ||
      !HASH.test(backupOperationSha256 ?? '') ||
      (expectedCurrentSecretSetReleaseId === SCHEDULE_LEGACY_RUNTIME_SET_ID
        ? !HASH.test(preexistingSidecarArchiveSha256 ?? '')
        : preexistingSidecarArchiveSha256 !== undefined) ||
      typeof expiresAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt) ||
      !Number.isFinite(Date.parse(expiresAt)) ||
      new Date(expiresAt).toISOString() !== expiresAt ||
      [value.expectedApi, value.expectedWeb].some(
        (previous) => previous?.releaseId !== SCHEDULE_PREDECESSOR_RELEASE,
      ) ||
      typeof base.confirmation !== 'string' ||
      !base.confirmation.endsWith(suffix)
    )
      fail('schedule_operation');
    exact(candidateSecretHashes, SECRET_NAMES);
    if (SECRET_NAMES.some((name) => !HASH.test(candidateSecretHashes[name] ?? '')))
      fail('schedule_secret_hashes');
    validateApiWebOperation({
      ...base,
      schema: 'PHUB_TIMEWEB_API_WEB_OPERATION_V1',
      confirmation: base.confirmation.slice(0, -suffix.length),
    });
    if (ownerProviderMonitoringWaiver !== undefined) validateScheduleMonitoringWaiver(value);
    return value;
  }
  if (value?.schema === 'PHUB_TIMEWEB_API_WEB_OPERATION_V2')
    return validateDirectApiWebOperation(value);
  exact(value, [
    'schema',
    'target',
    ...(value?.profile === undefined ? [] : ['profile']),
    'controllerSha',
    'candidateSha',
    'candidateTree',
    'sourceCiRunId',
    'publicationRunId',
    'artifactId',
    'artifactDigest',
    'manifestSha256',
    'expectedApi',
    'expectedWeb',
    'confirmation',
  ]);
  if (
    value.schema !== 'PHUB_TIMEWEB_API_WEB_OPERATION_V1' ||
    (value.profile !== undefined && value.profile !== 'beta' && value.profile !== 'production') ||
    value.target !== 'lk2.padlhub.su' ||
    ![value.controllerSha, value.candidateSha, value.candidateTree].every((v) =>
      SHA.test(v ?? ''),
    ) ||
    ![value.sourceCiRunId, value.publicationRunId, value.artifactId].every(
      (v) => typeof v === 'string' && NUMBER.test(v),
    ) ||
    !DIGEST.test(value.artifactDigest ?? '') ||
    !HASH.test(value.manifestSha256 ?? '')
  )
    fail('invalid_operation');
  for (const service of ['api', 'web']) {
    const previous = value[service === 'api' ? 'expectedApi' : 'expectedWeb'];
    exact(previous, ['id', 'image', 'releaseId']);
    if (
      !HASH.test(previous.id ?? '') ||
      !ID.test(previous.releaseId ?? '') ||
      !new RegExp(`^ghcr.io/z6v6e6r/phub-${service}@sha256:[a-f0-9]{64}$`).test(
        previous.image ?? '',
      )
    )
      fail('invalid_previous');
  }
  if (
    value.confirmation !==
    `DEPLOY_API_WEB_${value.candidateSha.slice(0, 12).toUpperCase()}_FROM_${value.expectedApi.releaseId.slice(0, 12).toUpperCase()}_${value.expectedWeb.releaseId.slice(0, 12).toUpperCase()}`
  )
    fail('invalid_confirmation');
  return value;
}
export function validateDirectApiWebOperation(value, requireUnexpired = false) {
  exact(value, [
    'schema',
    'target',
    ...(value?.profile === undefined ? [] : ['profile']),
    'controllerSha',
    'candidateSha',
    'candidateTree',
    'sourceCiRunId',
    'publicationRunId',
    'artifactId',
    'artifactDigest',
    'manifestSha256',
    'expectedApi',
    'expectedWeb',
    'evidencePolicy',
    'expiresAt',
    'confirmation',
  ]);
  if (
    value.schema !== 'PHUB_TIMEWEB_API_WEB_OPERATION_V2' ||
    (value.profile !== undefined && value.profile !== 'beta' && value.profile !== 'production') ||
    value.target !== 'lk2.padlhub.su' ||
    !SHA.test(value.controllerSha ?? '') ||
    value.evidencePolicy !== CALLBACK_DIRECT_POLICY ||
    value.expiresAt !== CALLBACK_DIRECT_EXPIRY ||
    (requireUnexpired && Date.now() > Date.parse(value.expiresAt)) ||
    Object.entries(CALLBACK_DIRECT_CANDIDATE).some(([key, expected]) =>
      ['apiImage', 'webImage', 'previousReleaseId'].includes(key) ? false : value[key] !== expected,
    )
  )
    fail('direct_operation_identity');
  for (const [service, image] of [
    ['Api', CALLBACK_DIRECT_CANDIDATE.apiImage],
    ['Web', CALLBACK_DIRECT_CANDIDATE.webImage],
  ]) {
    const expected = value[`expected${service}`];
    exact(expected, ['id', 'image', 'releaseId']);
    if (
      !HASH.test(expected.id ?? '') ||
      expected.image !== image ||
      expected.releaseId !== CALLBACK_DIRECT_CANDIDATE.previousReleaseId
    )
      fail('direct_previous_identity');
  }
  const suffix = `_DIRECT_15M_NO_PROVIDER_EVIDENCE`;
  if (
    value.confirmation !==
    `DEPLOY_API_WEB_${value.candidateSha.slice(0, 12).toUpperCase()}_FROM_${value.expectedApi.releaseId.slice(0, 12).toUpperCase()}_${value.expectedWeb.releaseId.slice(0, 12).toUpperCase()}${suffix}`
  )
    fail('direct_confirmation');
  return value;
}
function isDirectOperation(op) {
  return op.schema === 'PHUB_TIMEWEB_API_WEB_OPERATION_V2';
}
function policyHash(op) {
  return hash(
    Buffer.from(
      JSON.stringify({
        evidencePolicy: op.evidencePolicy,
        expiresAt: op.expiresAt,
        confirmation: op.confirmation,
      }),
    ),
  );
}
export function validateDirectOwnerObservation(value, op, operationSha256) {
  exact(value, [
    'schema',
    'evidencePolicy',
    'authorization',
    'operationSha256',
    'policySha256',
    'candidateSha',
    'target',
  ]);
  if (
    value.schema !== 'PHUB_TIMEWEB_API_WEB_OWNER_OBSERVATION_V1' ||
    value.evidencePolicy !== CALLBACK_DIRECT_POLICY ||
    value.authorization !== 'NOT_COLLECTED_EXPLICIT_OVERRIDE' ||
    value.operationSha256 !== operationSha256 ||
    value.policySha256 !== policyHash(op) ||
    value.candidateSha !== op.candidateSha ||
    value.target !== op.target
  )
    fail('direct_owner_observation');
  return value;
}
export function directOwnerBytes(op, operationSha256) {
  const value = {
    schema: 'PHUB_TIMEWEB_API_WEB_OWNER_OBSERVATION_V1',
    evidencePolicy: CALLBACK_DIRECT_POLICY,
    authorization: 'NOT_COLLECTED_EXPLICIT_OVERRIDE',
    operationSha256,
    policySha256: policyHash(op),
    candidateSha: op.candidateSha,
    target: op.target,
  };
  validateDirectOwnerObservation(value, op, operationSha256);
  return Buffer.from(`${JSON.stringify(value)}\n`);
}
export function validateControllerDelta(entries) {
  if (
    !Array.isArray(entries) ||
    !entries.length ||
    entries.some(({ status, path }) => !['A', 'M'].includes(status) || !CONTROLLER_FILES.has(path))
  )
    fail('candidate_controller_delta');
}
export function apiWebComposeArgs(baseline, overlay, action, service, roster = false) {
  if (
    !['api', 'web', ...(roster ? ['worker'] : [])].includes(service) ||
    !['config', 'pull', 'up'].includes(action)
  )
    fail('invalid_stage');
  return [
    'compose',
    '--env-file',
    baseline,
    '--env-file',
    overlay,
    '-f',
    COMPOSE,
    // Render dormant services for identity checks; activation never enables profiles.
    ...(action === 'config' ? ['--profile', '*'] : []),
    ...(service === 'worker' && action !== 'config' ? ['--profile', 'background'] : []),
    ...(action === 'config'
      ? ['config', '--format', 'json']
      : action === 'pull'
        ? ['pull', service]
        : ['up', '-d', '--no-deps', service]),
  ];
}
// nginx -t creates its pid and cache paths even when it only validates configuration.
// Keep the artifact root read-only; only these bounded, ephemeral scratch paths are writable.
export function apiWebArtifactSmokeArgs(service, image, roster = false) {
  if (
    !['api', 'web', ...(roster ? ['worker'] : [])].includes(service) ||
    !new RegExp(`^ghcr\\.io/z6v6e6r/phub-${service}@sha256:[a-f0-9]{64}$`).test(image)
  )
    fail('invalid_artifact_smoke');
  return [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    ...(service === 'web'
      ? [
          '--tmpfs',
          '/run:rw,noexec,nosuid,nodev,size=1m,mode=0755',
          '--tmpfs',
          '/var/cache/nginx:rw,noexec,nosuid,nodev,size=8m,mode=0755',
        ]
      : []),
    '--entrypoint',
    service === 'api' ? 'node' : '/bin/sh',
    image,
    ...(service === 'api'
      ? ['--check', '/app/apps/api/dist/main.js']
      : service === 'worker'
        ? [
            '-ec',
            'node --check /app/apps/worker/dist/main.js && node --check /app/apps/worker/dist/repair-legacy-game-rosters.js',
          ]
        : ['-ec', 'nginx -t && test -s /usr/share/nginx/html/index.html']),
  ];
}
// Every ambiguous activation has a durable intent. Recovery always converges to the previous pair.
export async function runApiWebTransition(ops) {
  const swapsSecrets = swapsRuntimeSecrets(ops);
  let activationIntent = false;
  try {
    await ops.preflight();
    await ops.pullAndSmoke();
    await ops.journal('PREPARED');
    activationIntent = true; // An intent write may have committed even when its fsync fails.
    if (ops.workerMode === 'legacy-roster-cutover') {
      await ops.journal('WORKER_STOP_INTENT');
      await ops.containWorker(false);
      await ops.journal('WORKER_STOPPED');
    }
    if (swapsSecrets) {
      await ops.journal('SECRET_SWAP_INTENT');
      await ops.installSecrets();
      await ops.journal('SECRETS_ACTIVE');
    }
    await ops.journal('API_INTENT');
    await ops.activate('api');
    await ops.journal('API_ACTIVE');
    if (ops.workerMode === 'legacy-roster-cutover') {
      await ops.journal('WORKER_INTENT');
      await ops.activate('worker');
      await ops.journal('WORKER_ACTIVE');
    }
    await ops.journal('WEB_INTENT');
    await ops.activate('web');
    await ops.journal('OBSERVING');
    await ops.observe();
    await ops.attest();
    if (swapsSecrets || ops.workerMode === 'legacy-roster-cutover' || ops.backupMode === 'app-only')
      await ops.journal('BASELINE_INTENT');
    await ops.installBaseline();
    await ops.journal('SUCCESS');
  } catch (error) {
    if (activationIntent) await recoverApiWebTransition(ops);
    else {
      await ops.abort();
      await ops.journal('ABORTED');
    }
    throw error;
  }
}
export async function recoverApiWebTransition(ops) {
  const swapsSecrets = swapsRuntimeSecrets(ops);
  try {
    await ops.journal('ROLLBACK_INTENT');
    // Continue API restoration even if Web restoration fails; never declare a partial restore safe.
    const errors = [];
    if (ops.workerMode === 'legacy-roster-cutover') {
      try {
        await ops.containWorker(true);
      } catch {
        fail('worker_containment_failed');
      }
    }
    if (swapsSecrets) {
      try {
        await ops.restoreSecrets();
      } catch {
        errors.push('secrets');
      }
    }
    for (const service of [
      'web',
      'api',
      ...(ops.workerMode === 'legacy-roster-cutover' ? ['worker'] : []),
    ]) {
      if (service === 'api' && errors.includes('secrets')) continue;
      try {
        await ops.restore(service);
      } catch {
        errors.push(service);
      }
    }
    if (errors.length) fail('restore_failed');
    if (swapsSecrets || ops.workerMode === 'legacy-roster-cutover' || ops.backupMode === 'app-only')
      await ops.removeCandidateBaseline();
    await (ops.attestRestored ?? ops.attest)();
    await ops.journal('ROLLED_BACK');
  } catch {
    await ops.journal('ROLLBACK_FAILED');
    fail('rollback_failed');
  }
}
export async function recoverApiWebPhase(phase, ops) {
  const swapsSecrets = swapsRuntimeSecrets(ops);
  if (['PREPARING', 'PREPARED'].includes(phase)) {
    await ops.abort();
    await ops.journal('ABORTED');
    return 'ABORTED';
  }
  if (
    ![
      'API_INTENT',
      'API_ACTIVE',
      'WEB_INTENT',
      'OBSERVING',
      'ROLLBACK_INTENT',
      'ROLLBACK_FAILED',
      ...(ops.workerMode === 'legacy-roster-cutover'
        ? [
            'WORKER_STOP_INTENT',
            'WORKER_STOPPED',
            'WORKER_INTENT',
            'WORKER_ACTIVE',
            'BASELINE_INTENT',
          ]
        : []),
      ...(swapsSecrets ? SCHEDULE_PHASES : []),
      ...(ops.backupMode === 'app-only' ? ['BASELINE_INTENT'] : []),
    ].includes(phase)
  )
    fail('invalid_recovery_phase');
  await recoverApiWebTransition(ops);
  return 'ROLLED_BACK';
}
function swapsRuntimeSecrets(ops) {
  if (ops.secretMode === undefined) return false;
  if (!['join-dormant', 'schedule-read', 'cup-support-staging'].includes(ops.secretMode))
    fail('invalid_secret_mode');
  return true;
}
export function validateUnchangedImages(values, roster = false) {
  const services = roster ? ['realtime'] : ['worker', 'realtime'];
  exact(values, services);
  for (const service of services)
    if (
      values[service] !== null &&
      !new RegExp(`^ghcr.io/z6v6e6r/phub-${service}@sha256:[a-f0-9]{64}$`).test(
        values[service] ?? '',
      )
    )
      fail('unchanged_image_identity');
  return values;
}
export async function reconcileApiWebPhase(receipt, ops) {
  const terminal = receipt.status === 'RECONCILED' ? receipt.reconciledStatus : receipt.status;
  if (!['SUCCESS', 'ROLLED_BACK', 'ABORTED'].includes(terminal)) fail('nonterminal_reconciliation');
  await ops.attestTerminal(terminal);
  await ops.journalReconciled(terminal);
  await ops.releaseLock();
  return 'RECONCILED';
}
// A lost disaster-recovery dump blocks forward success, never verification of a safe abort
// or restoration of the recorded images. All other configuration/runtime guards still run.
export async function attestApiWebTerminal(terminal, attest) {
  if (!['SUCCESS', 'ROLLED_BACK', 'ABORTED'].includes(terminal)) fail('invalid_terminal');
  await attest(terminal !== 'SUCCESS');
}
// Stops only a recognized member of this sealed three-service transaction. Never guesses
// after a missing/foreign container. The caller journals intent before this command.
export function containRosterCutoverWorker(plan, runDocker = docker) {
  const ids = runDocker([
    'ps',
    '-aq',
    '--filter',
    'label=com.docker.compose.project=phub-timeweb-beta',
    '--filter',
    'label=com.docker.compose.service=worker',
  ])
    .trim()
    .split('\n')
    .filter(Boolean);
  if (ids.length !== 1) fail('worker_containment_count');
  const load = () => JSON.parse(runDocker(['inspect', ids[0]]))[0];
  const actual = load();
  const known = [plan.previous.worker, plan.candidate.worker].find(
    (v) =>
      v.image === actual.Config.Image &&
      v.releaseId === (actual.Config.Labels['phub.release-id'] ?? null) &&
      v.revision === (actual.Config.Labels['org.opencontainers.image.revision'] ?? null),
  );
  if (!known || !HASH.test(actual.Id ?? '') || (known.imageId && actual.Image !== known.imageId))
    fail('foreign_worker_containment');
  const image = JSON.parse(runDocker(['image', 'inspect', known.image]))[0];
  if (image.Id !== actual.Image || !image.RepoDigests?.includes(known.image))
    fail('worker_containment_image');
  if (actual.State.Status === 'running') runDocker(['stop', '--time', '60', actual.Id]);
  const stopped = load();
  if (
    stopped.Id !== actual.Id ||
    stopped.Image !== actual.Image ||
    !['exited', 'created'].includes(stopped.State.Status) ||
    stopped.State.Running !== false
  )
    fail('worker_not_contained');
  return stopped.Id;
}
export function retainLegacyAttestation(path, bytes, readExisting, create) {
  if (existsSync(path)) {
    if (!readExisting(path).equals(bytes)) fail('legacy_attestation_drift');
  } else create(path, bytes, true);
}
function secure(path, mode) {
  const value = lstatSync(path);
  if (
    value.isSymbolicLink() ||
    value.uid !== 0 ||
    value.gid !== 0 ||
    value.mode & 0o022 ||
    (!value.isDirectory() && (!value.isFile() || value.nlink !== 1)) ||
    (mode !== undefined && (value.mode & 0o777) !== mode)
  )
    fail('insecure_path');
  if (path !== '/') secure(dirname(path));
  return value;
}
// A power loss between link and unlink may preserve the writer's exact second name.
// Normalize only that single secure inode twin, never an unrelated hardlink or a symlink.
export function normalizeUpgradeHardlink(path, expectedUid = 0, expectedGid = 0) {
  const value = lstatSync(path);
  if (value.nlink === 1) return false;
  if (
    !value.isFile() ||
    value.isSymbolicLink() ||
    value.nlink !== 2 ||
    value.uid !== expectedUid ||
    value.gid !== expectedGid ||
    (value.mode & 0o777) !== 0o600
  )
    fail('invalid_atomic_twin');
  const prefix = basename(path) + '.incoming-';
  const twins = readdirSync(dirname(path))
    .filter((name) => name.startsWith(prefix) && /^[a-f0-9]{24}$/.test(name.slice(prefix.length)))
    .map((name) => `${dirname(path)}/${name}`)
    .filter((twin) => {
      const current = lstatSync(twin);
      return (
        current.isFile() &&
        !current.isSymbolicLink() &&
        current.dev === value.dev &&
        current.ino === value.ino &&
        current.nlink === 2 &&
        current.uid === expectedUid &&
        current.gid === expectedGid &&
        (current.mode & 0o777) === 0o600
      );
    });
  if (twins.length !== 1) fail('ambiguous_atomic_twin');
  unlinkSync(twins[0]);
  const fd = openSync(dirname(path), 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (lstatSync(path).nlink !== 1) fail('atomic_twin_changed');
  return true;
}
function read(path, mode = 0o600, max = 4 * 1024 * 1024, normalizeAtomicTwin = true) {
  if (path.startsWith(ROOT + '/')) {
    secure(dirname(path));
    if (normalizeAtomicTwin) normalizeUpgradeHardlink(path);
  }
  const before = secure(path, mode);
  if (!before.isFile() || before.size > max) fail('invalid_file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev) fail('file_race');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
// Hash large backups in bounded memory while preserving the secure descriptor identity.
export function hashUpgradeDescriptor(fd, maximum = 64 * 1024 ** 3) {
  const before = fstatSync(fd);
  if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > maximum)
    fail('invalid_backup_file');
  const digest = createHash('sha256');
  const block = Buffer.alloc(1024 * 1024);
  let position = 0;
  while (position < before.size) {
    const count = readSync(fd, block, 0, Math.min(block.length, before.size - position), position);
    if (!count) fail('backup_changed');
    digest.update(block.subarray(0, count));
    position += count;
  }
  const after = fstatSync(fd);
  if (
    ['ino', 'dev', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].some((key) => before[key] !== after[key])
  )
    fail('backup_changed');
  return digest.digest('hex');
}
function hashBackupFile(path) {
  const before = secure(path, 0o600);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev) fail('file_race');
    return hashUpgradeDescriptor(fd);
  } finally {
    closeSync(fd);
  }
}
function attestStationPrevious(actual, expected) {
  if (
    !actual ||
    actual.restarts !== 0 ||
    Object.entries(expected).some(([key, value]) => actual[key] !== value) ||
    actual.revision !== (expected.revision ?? expected.releaseId.slice(0, 40))
  )
    fail('station_rollout_predecessor');
}
function attestStationAuthorization(transaction, op) {
  const bytes = read(`${transaction}/owner-authorization.txt`, 0o600, 16384, false);
  if (!bytes.length || hash(bytes) !== op.ownerDecision.releaseAuthorizationSha256)
    fail('station_rollout_release_authorization');
}
function attestStationDatabase() {
  const postgres = JSON.parse(docker(['inspect', STATION_POSTGRES.id]))[0];
  if (
    postgres.Id !== STATION_POSTGRES.id ||
    postgres.Name !== '/phub-timeweb-beta-dependencies-postgres-1' ||
    postgres.Config.Image !== STATION_POSTGRES.image ||
    postgres.State.StartedAt !== STATION_POSTGRES.startedAt ||
    postgres.State.Status !== 'running' ||
    postgres.State.Health?.Status !== 'healthy'
  )
    fail('station_rollout_postgres');
  const migration = read(`${SOURCE}/packages/database/migrations/${CUP_0119.filename}`, 0o644);
  const input = buildCup0119Sql(migration, CUP_0119_TARGET, 'readback');
  const result = docker(
    [
      'exec',
      '-i',
      STATION_POSTGRES.id,
      '/usr/local/bin/psql',
      '-XqAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      '/var/run/postgresql',
      '-U',
      CUP_0119_TARGET.projectionOwner,
      '-d',
      CUP_0119_TARGET.database,
    ],
    { input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 45_000, maxBuffer: 8192 },
  );
  validateStationDatabaseReadback(parseStrictJson(result.trim()));
}
function attestStationArchive(previous, full) {
  secure(STATION_SNAPSHOT, 0o700);
  validateStationBackupMetadata(
    read(`${STATION_SNAPSHOT}/backup-receipt.json`, 0o600, 16384, false),
    read(`${STATION_SNAPSHOT}/toc.txt`, 0o600, 4 * 1024 * 1024, false),
    read(STATION_CUP_RECEIPT, 0o600, 16384, false),
    read(`${dirname(STATION_CUP_RECEIPT)}/intent.json`, 0o600, 16384, false),
  );
  const path = STATION_BACKUP.dumpPath;
  const identity = (stat) => ({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  });
  const before = secure(path, 0o600);
  const current = identity(before);
  if (
    !before.isFile() ||
    current.size !== STATION_BACKUP.dumpBytes ||
    (previous && !equal(current, previous))
  )
    fail('station_rollout_archive_identity');
  if (!full) return current;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (
      !equal(identity(fstatSync(fd)), current) ||
      hashUpgradeDescriptor(fd) !== STATION_BACKUP.dumpSha256
    )
      fail('station_rollout_archive_digest');
    const toc = docker(
      [
        'exec',
        '-i',
        '-e',
        'LC_ALL=C',
        '-e',
        'TZ=UTC',
        STATION_POSTGRES.id,
        '/usr/local/bin/pg_restore',
        '--list',
      ],
      { stdio: [fd, 'pipe', 'pipe'], encoding: null, timeout: 45_000, maxBuffer: 4 * 1024 * 1024 },
    );
    if (hash(toc) !== STATION_BACKUP.tocSha256) fail('station_rollout_toc');
  } finally {
    closeSync(fd);
  }
  if (!equal(identity(secure(path, 0o600)), current)) fail('station_rollout_archive_drift');
  return current;
}
function durable(path, bytes, exclusive = false) {
  secure(dirname(path));
  if (exclusive && existsSync(path)) fail('existing_receipt');
  if (existsSync(path)) secure(path, 0o600);
  writeUpgradeAtomic(path, bytes, exclusive);
}
export function writeUpgradeAtomic(path, bytes, exclusive = false) {
  const temporary = `${path}.incoming-${randomBytes(12).toString('hex')}`;
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (exclusive) {
      linkSync(temporary, path);
      unlinkSync(temporary);
    } else renameSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function command(program, args, opts = {}) {
  return execFileSync(program, args, {
    cwd: SOURCE,
    env: environment,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}
const git = (args) => {
  const neutral = equal(args, [
    '--git-dir=/dev/null',
    'config',
    '--file',
    SOURCE + '/.git/config',
    '--no-includes',
    '--null',
    '--list',
  ]);
  if (args[0] === '--git-dir=/dev/null' && !neutral) fail('git_config_path');
  const result = command(
    '/usr/bin/git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.commitGraph=false',
      '-c',
      'protocol.allow=never',
      ...args,
    ],
    { cwd: neutral ? '/' : SOURCE },
  );
  return neutral ? result : result.trim();
};
Object.defineProperty(git, 'sourcePath', { value: SOURCE });
const docker = (args, options) => command('/usr/bin/docker', args, options);
export async function githubPublic(path) {
  if (
    !/^(?:actions\/runs\/[1-9][0-9]*(?:\/attempts\/1\/jobs\?per_page=100|\/artifacts\?per_page=100)?|pulls\/[1-9][0-9]*)$/.test(
      path,
    )
  )
    fail('github_path');
  const response = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: { Accept: 'application/vnd.github+json' },
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) fail('github_read_failed');
  return response.json();
}
async function verifyCi(id, sha) {
  const run = await githubPublic(`actions/runs/${id}`);
  const jobs = await githubPublic(`actions/runs/${id}/attempts/1/jobs?per_page=100`);
  if (jobs.total_count !== jobs.jobs?.length) fail('truncated_jobs');
  verifySourceCi(run, jobs.jobs, sha);
}
function parseEnv(bytes) {
  const values = {};
  for (const line of bytes.toString('utf8').trimEnd().split('\n')) {
    const match = /^([A-Z_0-9]+)=([a-zA-Z0-9_./:@-]*)$/.exec(line);
    if (!match || Object.hasOwn(values, match[1])) fail('noncanonical_env');
    values[match[1]] = match[2];
  }
  return values;
}
function inspect(service, project = 'phub-timeweb-beta', optional = false) {
  const ids = docker([
    'ps',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--filter',
    `label=com.docker.compose.service=${service}`,
  ])
    .trim()
    .split('\n')
    .filter(Boolean);
  if (!ids.length && optional) return null;
  if (ids.length !== 1) fail('service_count');
  const value = JSON.parse(docker(['inspect', ids[0]]))[0];
  if (value.State.Status !== 'running' || value.State.Health?.Status !== 'healthy')
    fail('unhealthy_service');
  return {
    id: value.Id,
    image: value.Config.Image,
    imageId: value.Image,
    releaseId: value.Config.Labels['phub.release-id'] ?? null,
    revision: value.Config.Labels['org.opencontainers.image.revision'] ?? null,
    restarts: value.RestartCount,
    startedAt: value.State.StartedAt,
  };
}
function excluded(targets = ['api', 'web']) {
  if (docker(['ps', '-q', '--filter', 'label=com.docker.compose.service=migrator']).trim())
    fail('active_migrator');
  // All existing non-target running containers are part of the unchanged boundary, including ingress/dependencies.
  const ids = docker(['ps', '-q']).trim().split('\n').filter(Boolean);
  return ids
    .map((id) => JSON.parse(docker(['inspect', id]))[0])
    .filter(
      (v) =>
        !(
          v.Config.Labels['com.docker.compose.project'] === 'phub-timeweb-beta' &&
          targets.includes(v.Config.Labels['com.docker.compose.service'])
        ),
    )
    .map((v) => ({
      id: v.Id,
      image: v.Config.Image,
      imageId: v.Image,
      restarts: v.RestartCount,
      startedAt: v.State.StartedAt,
      status: v.State.Status,
      health: v.State.Health?.Status ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
function secretHashes() {
  return Object.fromEntries(
    SECRET_NAMES.map((name) => [name, hash(read(`${RUNTIME}/${name}`, 0o600, 131072))]),
  );
}
async function candidateAuthority(op, directory) {
  const run = await githubPublic(`actions/runs/${op.publicationRunId}`);
  if (
    String(run.id) !== op.publicationRunId ||
    run.head_sha !== op.candidateSha ||
    run.head_branch !== 'main' ||
    run.run_attempt !== 1 ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.event !== 'workflow_dispatch' ||
    run.path !== '.github/workflows/publish-timeweb-amd64-images.yaml'
  )
    fail('publication_identity');
  const list = await githubPublic(`actions/runs/${op.publicationRunId}/artifacts?per_page=100`);
  if (list.total_count !== list.artifacts?.length) fail('truncated_artifacts');
  const name = `timeweb-amd64-canonical-release-${op.candidateSha}-${op.publicationRunId}-1`;
  const matches = list.artifacts.filter((v) => v.name === name);
  const artifact = matches[0];
  if (
    matches.length !== 1 ||
    artifact.expired !== false ||
    String(artifact.id) !== op.artifactId ||
    artifact.digest !== op.artifactDigest ||
    String(artifact.workflow_run?.id) !== op.publicationRunId ||
    artifact.workflow_run?.head_sha !== op.candidateSha
  )
    fail('artifact_identity');
  const archive = `${directory}/artifact/canonical-artifact.zip`;
  if (`sha256:${hash(read(archive))}` !== op.artifactDigest) fail('archive_digest');
  const entries = command('/usr/bin/unzip', ['-Z1', archive]).trim().split('\n').sort();
  if (!equal(entries, ['release-manifest.json', 'release-manifest.sha256']))
    fail('archive_inventory');
  const bytes = command('/usr/bin/unzip', ['-p', archive, 'release-manifest.json'], {
    encoding: null,
  });
  const checksum = command('/usr/bin/unzip', ['-p', archive, 'release-manifest.sha256']);
  if (hash(bytes) !== op.manifestSha256 || checksum !== `${hash(bytes)}  release-manifest.json\n`)
    fail('manifest_checksum');
  const manifest = JSON.parse(bytes);
  validateCanonicalManifest(manifest, {
    expectedPublication: {
      workflowSha: op.candidateSha,
      runId: op.publicationRunId,
      runAttempt: '1',
    },
    expectedBaseLockPath: `${SOURCE}/deploy/timeweb/base-images.lock.json`,
  });
  if (manifest.gitCommit !== op.candidateSha || manifest.gitTree !== op.candidateTree)
    fail('manifest_source');
  return manifest;
}
function imagePresent(ref, source, legacyImageId = undefined) {
  const v = JSON.parse(docker(['image', 'inspect', ref]))[0];
  if (
    v.Os !== 'linux' ||
    v.Architecture !== 'amd64' ||
    !v.RepoDigests?.includes(ref) ||
    (legacyImageId
      ? v.Id !== legacyImageId ||
        (v.Config.Labels?.['org.opencontainers.image.revision'] ?? null) !== null
      : v.Config.Labels?.['org.opencontainers.image.revision'] !== source)
  )
    fail('image_identity');
}
async function probe(service, publicProbe = false) {
  if (!['api', 'web', 'worker'].includes(service) || (service === 'worker' && publicProbe))
    fail('invalid_probe');
  const url = publicProbe
    ? `https://lk2.padlhub.su/${service === 'api' ? 'health/ready' : ''}`
    : service === 'api'
      ? 'http://172.30.26.12:3000/health/ready'
      : service === 'worker'
        ? 'http://172.30.26.14:3002/health/ready'
        : 'http://172.30.26.11:8080/';
  const started = performance.now();
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  const body = await response.text();
  if (response.status !== 200 || (service === 'web' && !body.includes('<div id="phub-app"></div>')))
    fail('probe_failed');
  return performance.now() - started;
}
// The production route deliberately has no request/env overrides: it observes a real 15-minute
// window. Tests may inject a virtual clock and probes to cover all failure paths without claiming
// wall-clock evidence.
export async function observeDirectApiWeb({
  inspectService,
  probeService,
  attest,
  now = () => Date.now(),
  sleep = delay,
}) {
  const started = now();
  const samples = Object.fromEntries(
    ['api', 'web'].map((service) => [service, { privateMs: [], publicMs: [], timestamps: [] }]),
  );
  for (let round = 0; round < 61; round++) {
    for (const service of ['api', 'web']) {
      inspectService(service);
      const privateMs = await probeService(service, false);
      const publicMs = await probeService(service, true);
      if (![privateMs, publicMs].every(Number.isFinite)) fail('direct_probe_latency');
      samples[service].privateMs.push(privateMs);
      samples[service].publicMs.push(publicMs);
      samples[service].timestamps.push(new Date(now()).toISOString());
    }
    await attest();
    if (round < 60) await sleep(15000);
  }
  const completed = now();
  for (const service of ['api', 'web']) {
    const percentile = (values) =>
      [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
    samples[service].p95PrivateMs = percentile(samples[service].privateMs);
    samples[service].p95PublicMs = percentile(samples[service].publicMs);
  }
  const evidence = {
    schema: 'PHUB_TIMEWEB_API_WEB_DIRECT_OBSERVATION_V1',
    evidencePolicy: CALLBACK_DIRECT_POLICY,
    authorization: 'NOT_COLLECTED_EXPLICIT_OVERRIDE',
    startedAt: new Date(started).toISOString(),
    completedAt: new Date(completed).toISOString(),
    elapsedSeconds: (completed - started) / 1000,
    samples,
    providerEvidence: 'NOT_COLLECTED_EXPLICIT_OVERRIDE',
    candidateSha: CALLBACK_DIRECT_CANDIDATE.candidateSha,
  };
  validateDirectObservation(evidence, evidence.completedAt);
  return evidence;
}
export async function observeStationRollout({
  inspectService,
  probeService,
  attest,
  identity,
  now = () => Date.now(),
  sleep = delay,
}) {
  const started = now();
  const latencyMs = { api: [], worker: [], web: [] };
  const publicLatencyMs = { api: [], web: [] };
  for (let round = 0; round <= 60; round++) {
    for (const service of ['api', 'worker', 'web']) {
      inspectService(service);
      latencyMs[service].push(await probeService(service, false));
      if (service !== 'worker') publicLatencyMs[service].push(await probeService(service, true));
    }
    await attest();
    if (round < 60) await sleep(15000);
  }
  const completed = now();
  const observation = {
    ...identity,
    windowSeconds: 900,
    samplesPerService: 61,
    latencyMs,
    publicLatencyMs,
    serverErrors: 0,
    startedAt: new Date(started).toISOString(),
    completedAt: new Date(completed).toISOString(),
    elapsedSeconds: (completed - started) / 1000,
  };
  validateStationObservation(observation, validateRosterCutoverObservation, undefined, identity);
  return observation;
}
async function callbackProbe() {
  const response = await fetch('https://lk2.padlhub.su/android/oauth/yandex', {
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.text();
  if (
    response.status !== 200 ||
    response.headers.has('location') ||
    !body.includes('history.replaceState(null')
  )
    fail('callback_probe_failed');
}
async function wait(service, expected) {
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      const v = inspect(service);
      if (
        v.image !== expected.image ||
        v.releaseId !== expected.releaseId ||
        v.revision !==
          (Object.hasOwn(expected, 'revision')
            ? expected.revision
            : expected.releaseId.slice(0, 40)) ||
        (expected.imageId !== undefined && v.imageId !== expected.imageId) ||
        v.restarts !== 0
      )
        fail('runtime_identity');
      await probe(service);
      return v;
    } catch {
      await delay(2000);
    }
  }
  fail('readiness_timeout');
}
function validateBackupProof(directory, previous, profile = 'beta', cutover = undefined) {
  // Operator-authorized degraded proof: when an interrupted transition left no receipt,
  // bind a deterministic marker. The authoritative database backup and restore evidence
  // remains in the release evidence store. A present receipt is still validated strictly.
  const path = `${directory}/database-backup-receipt.json`;
  let bytes;
  try {
    bytes = read(path);
  } catch {
    if (profile === 'production') fail('backup_restore_proof_missing');
    return {
      path: `${directory}/degraded-backup-proof.json`,
      sha256: hash(`PHUB_DEGRADED_BACKUP_PROOF_V1|${previous.releaseId}|${directory}\n`),
    };
  }
  const v = JSON.parse(bytes);
  if (cutover && isOwnerDirectedCutover(cutover))
    return validateFreshDumpProof(directory, previous, cutover, bytes, v);
  const diskCutover = cutover && v.schema === 'PHUB_TIMEWEB_CUTOVER_BACKUP_RESTORE_V2';
  exact(v, [
    'schema',
    'baselineReleaseId',
    'completedAt',
    'backupFile',
    'backupSha256',
    'restoreVerified',
    'restoreImage',
    'restoredLedgerSha256',
    'sourceLedgerSha256',
    ...(cutover
      ? [
          'operationSha256',
          'predecessorAttestationSha256',
          'databaseTarget',
          'sourceAccountsSha256',
          'restoredAccountsSha256',
          ...(diskCutover
            ? ['snapshotWitnessSha256', 'dumpBytes', 'dumpLimitBytes', 'dumpCompression']
            : []),
        ]
      : []),
  ]);
  if (
    v.schema !==
      (cutover
        ? diskCutover
          ? 'PHUB_TIMEWEB_CUTOVER_BACKUP_RESTORE_V2'
          : 'PHUB_TIMEWEB_CUTOVER_BACKUP_RESTORE_V1'
        : 'PHUB_TIMEWEB_DATABASE_BACKUP_RESTORE_V1') ||
    v.baselineReleaseId !== previous.releaseId ||
    v.restoreVerified !== true ||
    !/^docker\.io\/library\/postgres@sha256:[a-f0-9]{64}$/.test(v.restoreImage ?? '') ||
    !HASH.test(v.restoredLedgerSha256 ?? '') ||
    v.restoredLedgerSha256 !== v.sourceLedgerSha256 ||
    v.backupFile !== `${directory}/database.pgcustom` ||
    !HASH.test(v.backupSha256 ?? '') ||
    !Number.isFinite(Date.parse(v.completedAt)) ||
    Date.now() - Date.parse(v.completedAt) < 0 ||
    Date.now() - Date.parse(v.completedAt) > 3600000 ||
    hashBackupFile(v.backupFile) !== v.backupSha256
  )
    fail('backup_restore_proof');
  if (
    cutover &&
    (v.predecessorAttestationSha256 !== cutoverBaselineHash(cutover) ||
      !equal(v.databaseTarget, cutoverBaseline(cutover).databaseTarget) ||
      v.sourceLedgerSha256 !== cutoverBaseline(cutover).ledgerSha256 ||
      !HASH.test(v.sourceAccountsSha256 ?? '') ||
      v.sourceAccountsSha256 !== v.restoredAccountsSha256)
  )
    fail('cutover_backup_binding');
  if (cutover) {
    const operationPath = `${directory}/backup-operation.json`;
    const operationBytes = read(operationPath);
    const operationSha256 = hash(operationBytes);
    if (v.operationSha256 !== operationSha256) fail('cutover_backup_operation');
    const producer = validateCutoverBackupOperation(cutover, operationBytes, {
      directory,
      postgres: inspect('postgres', 'phub-timeweb-beta-dependencies'),
      toolFileSha256: hash(read(`${SOURCE}/scripts/control-timeweb-database-backup.py`, 0o644)),
      configSha256: hash(read(CONFIG)),
    });
    if (
      diskCutover !== (producer.schema === 'PHUB_TIMEWEB_BACKUP_ATTESTED_BETA122_DISK_V2') ||
      (diskCutover &&
        (!HASH.test(v.snapshotWitnessSha256 ?? '') ||
          !Number.isSafeInteger(v.dumpBytes) ||
          v.dumpBytes <= 0 ||
          v.dumpBytes > (13 * 1024 ** 3) / 2 ||
          v.dumpLimitBytes !== (13 * 1024 ** 3) / 2 ||
          v.dumpCompression !== 'zstd:3' ||
          lstatSync(v.backupFile).size !== v.dumpBytes))
    )
      fail('cutover_backup_profile');
    // Pure request validation and local installation/Git-object custody checks. This entry calls
    // neither execute() nor any Docker/database operation in the producer.
    const program = `import importlib.util,json,sys,time
spec=importlib.util.spec_from_file_location('backup','${SOURCE}/scripts/control-timeweb-database-backup.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
raw=sys.stdin.buffer.read();op=m.strict(raw);m.validate_operation(op,time.time(),op['toolFileSha256'],allow_expired=True)
m.tool_custody(op)
if op['schema']==m.CUTOVER_DISK_SCHEMA:
 m.validate_cutover_disk_terminal(op,raw)
sys.stdout.write('CUTOVER_BACKUP_CUSTODY_VERIFIED')`;
    if (
      command('/usr/bin/python3', ['-I', '-S', '-B', '-c', program], {
        input: operationBytes,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000,
      }) !== 'CUTOVER_BACKUP_CUSTODY_VERIFIED'
    )
      fail('cutover_backup_custody');
    const terminal = parseStrictJson(read(`${directory}/SUCCESS_CLEANUP_VERIFIED.json`));
    exact(terminal, ['phase', 'operationSha256', 'observedAt', 'receiptSha256']);
    if (
      terminal.phase !== 'SUCCESS_CLEANUP_VERIFIED' ||
      terminal.operationSha256 !== operationSha256 ||
      terminal.receiptSha256 !== hash(bytes) ||
      !Number.isFinite(Date.parse(terminal.observedAt)) ||
      Date.parse(terminal.observedAt) < Date.parse(v.completedAt)
    )
      fail('cutover_backup_terminal');
    return {
      path,
      sha256: hash(bytes),
      operationPath,
      operationSha256,
      receiptPath: path,
      receiptSha256: hash(bytes),
      dumpSha256: v.backupSha256,
    };
  }
  return { path, sha256: hash(bytes) };
}

function scheduleDumpIdentity(path) {
  const info = secure(path, 0o600);
  if (!info.isFile() || info.size <= 0 || info.nlink !== 1) fail('schedule_backup_dump');
  return Object.fromEntries(
    ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].map((key) => [key, info[key]]),
  );
}

export function validateScheduleSidecarArchiveReceipt(receipt, op, previousFiles) {
  exact(receipt, [
    'schema',
    'status',
    'releaseId',
    'previousSecretSetReleaseId',
    'archivePlanSha256',
    'activeFiles',
    'archivedFiles',
  ]);
  exact(receipt.activeFiles, SECRET_NAMES);
  if (
    receipt.schema !== 'PHUB_TIMEWEB_SCHEDULE_SIDECAR_ARCHIVE_V1' ||
    receipt.status !== 'ARCHIVED' ||
    receipt.releaseId !== `${op.candidateSha}-${op.publicationRunId}-1` ||
    receipt.previousSecretSetReleaseId !== SCHEDULE_LEGACY_RUNTIME_SET_ID ||
    op.expectedCurrentSecretSetReleaseId !== SCHEDULE_LEGACY_RUNTIME_SET_ID ||
    !HASH.test(receipt.archivePlanSha256 ?? '') ||
    receipt.archivedFiles !== 15 ||
    SECRET_NAMES.some(
      (name) =>
        !HASH.test(receipt.activeFiles[name] ?? '') ||
        receipt.activeFiles[name] !== previousFiles[name],
    )
  )
    fail('schedule_sidecar_archive');
}

function attestScheduleSidecarArchive(op, previousFiles) {
  if (!op.preexistingSidecarArchiveSha256) return;
  const id = `${op.candidateSha}-${op.publicationRunId}-1`;
  const directory = `/etc/phub/timeweb-beta-backups/${id}-preexisting-sidecars`;
  secure(directory, 0o700);
  const bytes = read(`${directory}/archive-receipt.json`);
  if (hash(bytes) !== op.preexistingSidecarArchiveSha256) fail('schedule_sidecar_archive_hash');
  const receipt = parseStrictJson(bytes);
  validateScheduleSidecarArchiveReceipt(receipt, op, previousFiles);
  const planBytes = read(`${directory}/archive-plan.json`);
  if (hash(planBytes) !== receipt.archivePlanSha256) fail('schedule_sidecar_plan_hash');
  const archivePlan = parseStrictJson(planBytes);
  exact(archivePlan, [
    'schema',
    'releaseId',
    'previousSecretSetReleaseId',
    'activeFiles',
    'sidecars',
  ]);
  if (
    archivePlan.schema !== 'PHUB_TIMEWEB_SCHEDULE_SIDECAR_ARCHIVE_PLAN_V1' ||
    archivePlan.releaseId !== id ||
    archivePlan.previousSecretSetReleaseId !== SCHEDULE_LEGACY_RUNTIME_SET_ID ||
    !equal(archivePlan.activeFiles, receipt.activeFiles)
  )
    fail('schedule_sidecar_plan');
  const sidecars = Object.entries(archivePlan.sidecars);
  if (
    sidecars.length !== receipt.archivedFiles ||
    !archivePlan.sidecars['lk1-result-bridge.token'] ||
    !equal(
      readdirSync(directory).sort(),
      [
        'archive-plan.json',
        'archive-receipt.json',
        'local-operator.lock',
        ...sidecars.map(([name]) => name),
      ].sort(),
    )
  )
    fail('schedule_sidecar_inventory');
  for (const [name, record] of sidecars) {
    if (!/^(?:(?:api|worker)\.env\.bak-[A-Za-z0-9+_-]+|lk1-result-bridge\.token)$/.test(name))
      fail('schedule_sidecar_name');
    exact(record, ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtime_ns', 'sha256']);
    const path = `${directory}/${name}`;
    const info = secure(path, 0o600);
    if (
      ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size'].some(
        (key) => info[key] !== record[key],
      ) ||
      String(lstatSync(path, { bigint: true }).mtimeNs) !== record.mtime_ns ||
      hash(read(path, 0o600, 131072)) !== record.sha256
    )
      fail('schedule_sidecar_file');
  }
}

function validateBoundBackupPlan(backup, op, transaction) {
  exact(backup, [
    'path',
    'sha256',
    'operationPath',
    'operationSha256',
    'dumpPath',
    'dumpSha256',
    'dumpIdentity',
    'terminalPath',
    'terminalSha256',
  ]);
  const phases = isAppOnlyOperation(op)
    ? ['FRESH_DUMP_INTEGRITY_VERIFIED']
    : ['SUCCESS_CLEANUP_VERIFIED', 'FRESH_DUMP_INTEGRITY_VERIFIED'];
  if (
    backup.path !== `${transaction}/database-backup-receipt.json` ||
    backup.operationPath !== `${transaction}/backup-operation.json` ||
    backup.dumpPath !== `${transaction}/database.pgcustom` ||
    !phases.some((phase) => backup.terminalPath === `${transaction}/${phase}.json`) ||
    backup.operationSha256 !== op.backupOperationSha256 ||
    ![backup.sha256, backup.dumpSha256, backup.terminalSha256].every((value) =>
      HASH.test(value ?? ''),
    )
  )
    fail('schedule_backup_plan_identity');
}

function attestBoundBackupFiles(backup) {
  const receiptBytes = read(backup.path);
  if (
    hash(receiptBytes) !== backup.sha256 ||
    hash(read(backup.operationPath)) !== backup.operationSha256 ||
    hash(read(backup.terminalPath)) !== backup.terminalSha256 ||
    !equal(scheduleDumpIdentity(backup.dumpPath), backup.dumpIdentity)
  )
    fail('schedule_backup_drift');
  const receipt = parseStrictJson(receiptBytes);
  if (
    receipt.schema === CUP_SUPPORT_BACKUP_RECEIPT &&
    (hash(read(`${dirname(backup.path)}/owner-restore-decision.json`)) !== receipt.policySha256 ||
      hash(read(`${dirname(backup.path)}/restore-admission-reference.json`)) !==
        receipt.admissionReferenceSha256)
  )
    fail('cup_support_backup_evidence_drift');
}

function validateBoundApiWebBackupProof(directory, releaseId, op, api) {
  const dumpPath = `${directory}/database.pgcustom`;
  const dumpIdentity = scheduleDumpIdentity(dumpPath);
  const operationPath = `${directory}/backup-operation.json`;
  const bytes = read(operationPath);
  const backup = parseStrictJson(bytes);
  const disk = backup.schema === SCHEDULE_DISK_BACKUP_SCHEMA;
  const appOnly = isAppOnlyOperation(op);
  const cupSupport = isCupSupportOperation(op);
  const requiredAppOnlySchema = cupSupport ? CUP_SUPPORT_BACKUP : APP_ONLY_BACKUP;
  const fresh = [CANONICAL_FRESH_OPERATION, APP_ONLY_BACKUP, CUP_SUPPORT_BACKUP].includes(
    backup.schema,
  );
  if (
    (appOnly && backup.schema !== requiredAppOnlySchema) ||
    (!appOnly && [APP_ONLY_BACKUP, CUP_SUPPORT_BACKUP].includes(backup.schema))
  )
    fail('app_only_backup_schema');
  const receiptPath = `${directory}/database-backup-receipt.json`;
  const receiptBytes = read(receiptPath);
  const receipt = parseStrictJson(receiptBytes);
  const proof =
    disk || fresh
      ? { path: receiptPath, sha256: hash(receiptBytes) }
      : validateBackupProof(directory, api, 'production');
  const phase = fresh ? 'FRESH_DUMP_INTEGRITY_VERIFIED' : 'SUCCESS_CLEANUP_VERIFIED';
  const terminalPath = `${directory}/${phase}.json`;
  const terminalBytes = read(terminalPath);
  const terminal = parseStrictJson(terminalBytes);
  const postgres = inspect('postgres', 'phub-timeweb-beta-dependencies');
  exact(terminal, ['phase', 'operationSha256', 'observedAt', 'receiptSha256']);
  if (
    (!disk && !fresh && backup.schema !== SCHEDULE_BACKUP_SCHEMA) ||
    (fresh &&
      ((!appOnly &&
        backup.confirmation !==
          `FRESH_DUMP_SCHEDULE_${op.candidateSha.slice(0, 12).toUpperCase()}_KEEP_API_0A4D640965E9`) ||
        receipt.schema !==
          (cupSupport
            ? CUP_SUPPORT_BACKUP_RECEIPT
            : appOnly
              ? APP_ONLY_BACKUP_RECEIPT
              : CANONICAL_FRESH_RECEIPT) ||
        receipt.restoreAdmissionPolicy !==
          (cupSupport
            ? CUP_SUPPORT_BACKUP_POLICY
            : appOnly
              ? APP_ONLY_BACKUP_POLICY
              : CANONICAL_PRIOR_RESTORE_POLICY) ||
        (cupSupport && receipt.policySha256 !== op.ownerRestoreDecisionSha256) ||
        receipt.freshDumpRestored !== false ||
        receipt.freshDumpIntegrityStatus !== 'PG16_TOC_PARSE_VERIFIED' ||
        Date.parse(op.expiresAt) > Date.parse(backup.expiresAt))) ||
    backup.releaseId !== releaseId ||
    backup.publicationRunId !== op.publicationRunId ||
    backup.controllerSha !== op.controllerSha ||
    backup.controllerTree !== op.candidateTree ||
    backup.toolCommit !== op.controllerSha ||
    backup.controllerConfigSha256 !== hash(read(CONFIG)) ||
    Object.entries(api).some(([key, value]) => backup.expectedApi?.[key] !== value) ||
    Object.entries(postgres).some(([key, value]) => backup.expectedPostgres?.[key] !== value) ||
    hash(bytes) !== op.backupOperationSha256 ||
    (disk && receipt.schema !== 'PHUB_TIMEWEB_CUTOVER_BACKUP_RESTORE_V2') ||
    receipt.baselineReleaseId !== api.releaseId ||
    receipt.backupFile !== dumpPath ||
    proof.sha256 !== hash(receiptBytes) ||
    !Number.isFinite(Date.parse(receipt.completedAt)) ||
    Date.parse(receipt.completedAt) > Date.now() ||
    Date.now() - Date.parse(receipt.completedAt) > 3600000 ||
    receipt.sourceLedgerSha256 !== (appOnly ? backup.expectedLedgerSha256 : SCHEDULE_LEDGER) ||
    (appOnly &&
      (backup.candidateSha !== op.candidateSha || !equal(backup.expectedWeb, inspect('web')))) ||
    terminal.phase !== phase ||
    terminal.operationSha256 !== op.backupOperationSha256 ||
    terminal.receiptSha256 !== proof.sha256 ||
    !Number.isFinite(Date.parse(terminal.observedAt)) ||
    Date.parse(terminal.observedAt) < Date.parse(receipt.completedAt) ||
    Date.parse(terminal.observedAt) > Date.now()
  )
    fail('schedule_backup_binding');
  const helper = `${SOURCE}/scripts/control-timeweb-database-backup.py`;
  const helperSha = hash(read(helper, 0o644));
  const attest = `import importlib.util,sys,time
spec=importlib.util.spec_from_file_location('backup',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
raw=sys.stdin.buffer.read();op=m.strict(raw);m.validate_operation(op,time.time(),sys.argv[2],allow_expired=True)
m.tool_custody(op)
if op['schema']==m.SCHEDULE_DISK_SCHEMA: m.validate_cutover_disk_terminal(op,raw)
if m.is_schedule_fresh(op) or m.is_app_only_fresh(op): m.validate_fresh_terminal(op,raw)
sys.stdout.write('SCHEDULE_BACKUP_CUSTODY_VERIFIED')`;
  if (
    command('/usr/bin/python3', ['-I', '-S', '-B', '-c', attest, helper, helperSha], {
      input: bytes,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: disk || fresh ? 180000 : 30000,
    }) !== 'SCHEDULE_BACKUP_CUSTODY_VERIFIED' ||
    !equal(dumpIdentity, scheduleDumpIdentity(dumpPath)) ||
    hash(read(receiptPath)) !== proof.sha256 ||
    hash(read(terminalPath)) !== hash(terminalBytes)
  )
    fail('schedule_backup_custody');
  return {
    ...proof,
    operationPath,
    operationSha256: op.backupOperationSha256,
    dumpPath,
    dumpSha256: receipt.backupSha256,
    dumpIdentity,
    terminalPath,
    terminalSha256: hash(terminalBytes),
  };
}

function validateFreshDumpProof(directory, previous, cutover, bytes, receipt) {
  exact(receipt, [
    'schema',
    'baselineReleaseId',
    'completedAt',
    'backupFile',
    'backupSha256',
    'operationSha256',
    'predecessorAttestationSha256',
    'databaseTarget',
    'sourceLedgerSha256',
    'sourceAccountsSha256',
    'snapshotWitnessSha256',
    'dumpBytes',
    'dumpLimitBytes',
    'dumpCompression',
    'postgresImage',
    'freshDumpRestored',
    'freshDumpIntegrityStatus',
    'restoreAdmissionPolicy',
    'priorReferenceSha256',
    'ownerReceiptSha256',
  ]);
  const operationPath = `${directory}/backup-operation.json`,
    operationBytes = read(operationPath);
  const producer = validateCutoverBackupOperation(cutover, operationBytes, {
    directory,
    postgres: inspect('postgres', 'phub-timeweb-beta-dependencies'),
    toolFileSha256: hash(read(`${SOURCE}/scripts/control-timeweb-database-backup.py`, 0o644)),
    configSha256: hash(read(CONFIG)),
  });
  const decision = cutover.ownerDecisions.repeatedRestore;
  if (
    producer.schema !==
      (isCanonicalOwnerDirectedUpgrade(cutover)
        ? CANONICAL_FRESH_OPERATION
        : FRESH_BACKUP_OPERATION) ||
    receipt.schema !==
      (isCanonicalOwnerDirectedUpgrade(cutover) ? CANONICAL_FRESH_RECEIPT : FRESH_BACKUP_RECEIPT) ||
    receipt.baselineReleaseId !== previous.releaseId ||
    receipt.operationSha256 !== hash(operationBytes) ||
    receipt.predecessorAttestationSha256 !== cutoverBaselineHash(cutover) ||
    !equal(receipt.databaseTarget, cutoverBaseline(cutover).databaseTarget) ||
    receipt.sourceLedgerSha256 !== cutoverBaseline(cutover).ledgerSha256 ||
    receipt.backupFile !== `${directory}/database.pgcustom` ||
    receipt.freshDumpRestored !== false ||
    receipt.freshDumpIntegrityStatus !== 'PG16_TOC_PARSE_VERIFIED' ||
    receipt.restoreAdmissionPolicy !==
      (isCanonicalOwnerDirectedUpgrade(cutover)
        ? CANONICAL_PRIOR_RESTORE_POLICY
        : PRIOR_RESTORE_POLICY) ||
    ![
      'backupSha256',
      'sourceAccountsSha256',
      'snapshotWitnessSha256',
      'priorReferenceSha256',
      'ownerReceiptSha256',
    ].every((k) => HASH.test(receipt[k] ?? '')) ||
    !Number.isSafeInteger(receipt.dumpBytes) ||
    receipt.dumpBytes <= 0 ||
    receipt.dumpBytes > (13 * 1024 ** 3) / 2 ||
    receipt.dumpLimitBytes !== (13 * 1024 ** 3) / 2 ||
    receipt.dumpCompression !== 'zstd:3' ||
    lstatSync(receipt.backupFile).size !== receipt.dumpBytes ||
    hashBackupFile(receipt.backupFile) !== receipt.backupSha256 ||
    hash(read(`${directory}/prior-full-restore-reference.json`)) !== receipt.priorReferenceSha256 ||
    hash(read(`${directory}/owner-restore-decision.json`)) !== receipt.ownerReceiptSha256 ||
    !Number.isFinite(Date.parse(receipt.completedAt)) ||
    Date.now() < Date.parse(receipt.completedAt) ||
    Date.now() - Date.parse(receipt.completedAt) > 3600000 ||
    ['messageSha256', 'reference', 'receivedAt'].some(
      (k) => producer.ownerRestoreDecision?.[k] !== decision[k],
    ) ||
    Date.parse(cutover.expiresAt) > Date.parse(producer.expiresAt)
  )
    fail('fresh_backup_proof');
  const program = `import importlib.util,sys,time
spec=importlib.util.spec_from_file_location('backup','${SOURCE}/scripts/control-timeweb-database-backup.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
raw=sys.stdin.buffer.read();op=m.strict(raw);m.validate_operation(op,time.time(),op['toolFileSha256'],allow_expired=True)
m.tool_custody(op);m.validate_fresh_terminal(op,raw)
sys.stdout.write('FRESH_DUMP_CUSTODY_VERIFIED')`;
  if (
    command('/usr/bin/python3', ['-I', '-S', '-B', '-c', program], {
      input: operationBytes,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
    }) !== 'FRESH_DUMP_CUSTODY_VERIFIED'
  )
    fail('fresh_backup_custody');
  const path = `${directory}/database-backup-receipt.json`;
  return {
    path,
    sha256: hash(bytes),
    operationPath,
    operationSha256: hash(operationBytes),
    receiptPath: path,
    receiptSha256: hash(bytes),
    dumpSha256: receipt.backupSha256,
    admissionPolicy: isCanonicalOwnerDirectedUpgrade(cutover)
      ? CANONICAL_PRIOR_RESTORE_POLICY
      : PRIOR_RESTORE_POLICY,
    priorReferenceSha256: receipt.priorReferenceSha256,
    ownerReceiptSha256: receipt.ownerReceiptSha256,
  };
}

// Read only the authenticated original POST105 bundle. The installed producer's terminal
// attestation verifies its sealed journal and complete namespace/storage cleanup.
// Forward admission only. Historical terminal backup attestation never calls this reader.
export function readJoinNotificationBaseline(op) {
  const post = op?.schema === JOIN_POST105_BACKUP_SCHEMA;
  if (!post && !isJoinOperation(op)) fail('join_notification_profile');
  const installed = readInstalledApiBaseline(op.expectedApi.releaseId);
  const { bytes, values, secretSetReleaseId } = installed;
  const tx = `${ROOT}/backups/${op.expectedApi.releaseId}-api-worker`;
  const bundle = {
    operation: read(`${tx}/operation.json`),
    plan: read(`${tx}/plan.json`),
    capsule: read(`${tx}/preparation.json`),
    receipt: read(`${tx}/rollout-receipt.json`),
    observation: read(`${tx}/observation.json`),
    descriptor: bytes,
    apiIdentity: read(`${tx}/candidate-api.identity.json`),
    workerIdentity: read(`${tx}/candidate-worker.identity.json`),
  };
  if (existsSync('/etc/phub/.timeweb-beta.provision.lock')) fail('join_notification_snapshot');
  const notificationBundleSha256 = validateJoinNotificationSnapshot(bundle, values, op, {
    api: inspect('api'),
    web: inspect('web'),
    secretSet: describeTimewebRuntimeSecretSet(RUNTIME),
    secretSetReleaseId,
    excluded: excluded(),
  });
  return {
    schema: 'PHUB_TIMEWEB_JOIN_NOTIFICATION_BASELINE_V1',
    notificationBundleSha256,
    notificationOperationSha256: hash(bundle.operation),
    notificationPlanSha256: hash(bundle.plan),
    notificationReceiptSha256: hash(bundle.receipt),
    installedDescriptorSha256: hash(bytes),
  };
}

export function readJoinPost105Backup(op, controllerTree, { fresh = true } = {}) {
  const request = `${ROOT}/operator/database-backup-restore.json`;
  const operation = read(request);
  if (hash(operation) !== op.post105BackupOperationSha256) fail('join_backup_operation_drift');
  const backupOp = validateJoinPost105BackupOperation(
    parseStrictJson(operation),
    op,
    controllerTree,
  );
  const directory = `${ROOT}/backups/${backupOp.releaseId}-join-post105`;
  secure(directory, 0o700);
  if (!read(`${directory}/backup-operation.json`).equals(operation))
    fail('join_backup_operation_drift');
  const receipt = read(`${directory}/database-backup-receipt.json`);
  const preimage = read(`${directory}/preimage-proof.json`);
  const tool = `${ROOT}/operator/tools/${backupOp.toolCommit}/control-timeweb-database-backup.py`;
  const toolBytes = read(tool, 0o755),
    installation = read(`${dirname(tool)}/installation-receipt.json`);
  if (
    hash(toolBytes) !== backupOp.toolFileSha256 ||
    hash(installation) !== backupOp.toolInstallationSha256
  )
    fail('join_backup_tool_drift');
  let terminal;
  try {
    terminal = Buffer.from(
      command('/usr/bin/python3', ['-I', '-S', '-B', tool, '--attest-disk', request], {
        timeout: 60000,
      }),
    );
  } catch {
    fail('join_backup_producer_capability_or_terminal');
  }
  return validateJoinPost105BackupBundle(
    {
      operation,
      receipt,
      preimage,
      terminal,
      golden: read(`${SOURCE}/deploy/timeweb/notification-migration-catalogs.v1.json`, 0o644),
      descriptor: read(`${SOURCE}/deploy/timeweb/notification-migrations-0099-0101.v1.json`, 0o644),
    },
    op,
    controllerTree,
    {
      dumpSha256: hashBackupFile(`${directory}/database.pgcustom`),
      toolSha256: hash(toolBytes),
      installationSha256: hash(installation),
    },
    { fresh },
  );
}

export function readNativeOperatorSnapshot(path) {
  if (path !== `${ROOT}/operator/${NATIVE_ENVELOPE}`) fail('native_input_path');
  secure(dirname(path));
  const before = secure(path, 0o600);
  if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > 16 * 1024 * 1024)
    fail('native_input_file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink', 'uid', 'gid', 'mode'].some(
        (key) => before[key] !== opened[key],
      )
    )
      fail('native_input_race');
    const bytes = readFileSync(fd),
      after = fstatSync(fd),
      named = lstatSync(path);
    if (
      bytes.length !== before.size ||
      ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink', 'uid', 'gid', 'mode'].some(
        (key) => before[key] !== after[key] || before[key] !== named[key],
      )
    )
      fail('native_input_race');
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function nativeSourceHashes() {
  return {
    adapterSourceSha256: hash(read(`${SOURCE}/scripts/timeweb-native-observability.js`, 0o644)),
    reviewValidatorSha256: hash(read(`${SOURCE}/scripts/timeweb-native-capture-review.js`, 0o644)),
  };
}
function readRetainedNativeEvidence(transaction) {
  return Object.fromEntries(
    [...NATIVE_INPUTS, NATIVE_DERIVED, NATIVE_ENVELOPE].map((name) => [
      name,
      read(
        `${transaction}/${name}`,
        0o600,
        name === NATIVE_ENVELOPE ? 16 * 1024 * 1024 : 4 * 1024 * 1024,
      ),
    ]),
  );
}
export async function admitNativeWaiverMonitoring(op, transaction, operationSha256) {
  if (
    process.getuid?.() !== 0 ||
    transaction !== `${ROOT}/backups/${op.candidateSha}-${op.publicationRunId}-1-api-web` ||
    existsSync(`${transaction}/plan.json`) ||
    !read(LOCK).equals(Buffer.from(`${transaction}/plan.json\n`)) ||
    hash(read(`${transaction}/operation.json`)) !== operationSha256
  )
    fail('native_admission_lease');
  validateProductionCutover(op, true);
  const source = nativeSourceHashes(),
    path = `${ROOT}/operator/${NATIVE_ENVELOPE}`;
  process.stderr.write(
    `PHUB_NATIVE_INPUT_REQUIRED|operationSha256=${operationSha256}|waitSeconds=120\n`,
  );
  const deadline = performance.now() + 120000;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) fail('native_input_deadline');
    await delay(250);
  }
  const envelope = readNativeOperatorSnapshot(path);
  const inputs = decodeNativeInputEnvelope(envelope, operationSha256);
  const { admission, evidence } = createNativeWaiverAdmission(
    op,
    inputs,
    source,
    new Date().toISOString(),
    operationSha256,
  );
  if (!evidence[NATIVE_ENVELOPE].equals(envelope)) fail('native_envelope_canonical_order');
  for (const [name, bytes] of Object.entries(evidence))
    durable(`${transaction}/${name}`, bytes, true);
  const retained = readRetainedNativeEvidence(transaction);
  validateRetainedNativeAdmission(op, admission, operationSha256, retained);
  return admission;
}
function attestSealedNativeMonitoring(op, plan, transaction) {
  if (
    !equal(nativeSourceHashes(), {
      adapterSourceSha256: plan.monitoring.adapterSourceSha256,
      reviewValidatorSha256: plan.monitoring.reviewValidatorSha256,
    })
  )
    fail('native_source_drift');
  validateSealedNativeAdmission(
    op,
    plan.monitoring,
    plan.operationSha256,
    readRetainedNativeEvidence(transaction),
  );
}
export function validateUpgradeMonitoring(provider, alerts, contract, observedAt) {
  const monitors = validateTimewebMonitorReadback(provider, contract, observedAt);
  const alertTest = validateTimewebAlertReadback(alerts, contract);
  validateTimewebMonitoringEvidence({ monitors, alertTest }, contract, observedAt);
}
export function validateStationMonitoring(provider, contract, observedAt) {
  assertCutoverReadbackFreshness(provider?.readAt, Date.parse(observedAt));
  const monitors = validateTimewebMonitorReadback(provider, contract, observedAt);
  validateTimewebProviderMonitoringEvidence(monitors, contract, observedAt);
}
export function validateCupSupportProviderEvidence(
  evidence,
  contract,
  observedAt,
  sourceSha,
  adapterSourceSha256,
) {
  if (evidence?.schema !== CUP_SUPPORT_NATIVE_EVIDENCE)
    return validateStationMonitoring(evidence, contract, observedAt);
  exact(evidence, ['schema', 'captureBundle', 'captureReview', 'captureTrace']);
  const { captureBundle, captureReview, captureTrace } = evidence;
  if (
    ![captureBundle, captureReview, captureTrace].every((value) => typeof value === 'string') ||
    parseStrictJson(captureBundle).schema !== NATIVE_MONITOR_BATCH_BUNDLE
  )
    fail('cup_support_native_monitor_input');
  verifyNativeCaptureReview(
    captureReview,
    captureBundle,
    captureTrace,
    sourceSha,
    adapterSourceSha256,
    observedAt,
  );
  const readback = deriveNativeMonitorReadback(captureBundle, observedAt, sourceSha);
  assertCutoverReadbackFreshness(readback.readAt, Date.parse(observedAt));
}

function attestCupSupportProviderBytes(provider, op, observedAt) {
  const contract = parseStrictJson(
    read(`${SOURCE}/deploy/timeweb/api-web-observability.v1.json`, 0o644),
  );
  validateCupSupportProviderEvidence(
    parseStrictJson(provider),
    contract,
    observedAt,
    op.candidateSha,
    nativeSourceHashes().adapterSourceSha256,
  );
}

function readCupSupportProviderEvidence(op) {
  const root = `${ROOT}/observability`;
  const native = `${root}/cup-support-native-monitor-input.json`;
  const provider = read(existsSync(native) ? native : `${root}/timeweb-monitor-readback.json`);
  const observedAt = new Date().toISOString();
  attestCupSupportProviderBytes(provider, op, observedAt);
  return { provider, observedAt };
}
function validateMonitoring(
  transaction,
  profile = 'beta',
  { fresh = false, station = false } = {},
) {
  const provider = read(`${ROOT}/observability/timeweb-monitor-readback.json`);
  const alerts = station ? null : read(`${ROOT}/observability/alert-test-readback.json`);
  if (profile === 'production') {
    const contract = parseStrictJson(
      read(`${SOURCE}/deploy/timeweb/api-web-observability.v1.json`, 0o644),
    );
    const providerValue = parseStrictJson(provider);
    if (station) {
      validateStationMonitoring(providerValue, contract, new Date().toISOString());
    } else {
      if (fresh) assertCutoverReadbackFreshness(providerValue.readAt);
      validateUpgradeMonitoring(
        providerValue,
        parseStrictJson(alerts),
        contract,
        fresh ? new Date().toISOString() : providerValue.readAt,
      );
    }
  }
  // Beta retains readbacks as evidence without revalidating current external state.
  return { providerSha256: hash(provider), alertSha256: alerts && hash(alerts), provider, alerts };
}
export function overlayBytes(plan, name) {
  if (name === 'candidate')
    return `PHUB_RELEASE_ID=${plan.candidate.api.releaseId}\nAPI_IMAGE_DIGEST=${plan.candidate.api.image.split('@')[1]}\nWEB_IMAGE_DIGEST=${plan.candidate.web.image.split('@')[1]}\n${plan.candidate.worker ? `WORKER_IMAGE_DIGEST=${plan.candidate.worker.image.split('@')[1]}\n` : ''}`;
  const service =
    name === 'previous-api'
      ? 'api'
      : name === 'previous-web'
        ? 'web'
        : name === 'previous-worker' && plan.candidate.worker
          ? 'worker'
          : fail('overlay_name');
  return `PHUB_RELEASE_ID=${service === 'worker' ? plan.previous.api.releaseId : plan.previous[service].releaseId}\n${service.toUpperCase()}_IMAGE_DIGEST=${plan.previous[service].image.split('@')[1]}\n`;
}
export function assertOverlayBytes(plan, name, bytes) {
  if (!Buffer.from(bytes).equals(Buffer.from(overlayBytes(plan, name)))) fail('overlay_drift');
}
export function validateRuntimeDelta(paths) {
  if (
    paths.some(
      (path) =>
        /^(?:deploy\/timeweb\/(?!operator-entry|run-standard)|contracts\/|packages\/database\/migrations\/|openapi\.yaml$)/.test(
          path,
        ) ||
        [
          'apps/api/Dockerfile',
          'apps/web/Dockerfile',
          'apps/worker/Dockerfile',
          'apps/realtime/Dockerfile',
          'apps/migrator/Dockerfile',
          'scripts/render-timeweb-beta-release-env.js',
          'scripts/timeweb-release-manifest-contract.js',
          'scripts/verify-source-ci.js',
          'scripts/timeweb-standard-policy.js',
          'scripts/produce-timeweb-api-web-observability-evidence.js',
          'scripts/produce-timeweb-api-web-observability-evidence.d.ts',
          'scripts/verify-timeweb-api-web-observability.js',
          'scripts/verify-timeweb-api-web-observability.d.ts',
        ].includes(path),
    )
  )
    fail('runtime_definition_changed');
}
// Closed compatibility proof for an already-reviewed application release. The generic
// runtime validator stays default-deny; this bridge cannot follow later main drift.
export const CALLBACK_RUNTIME_BRIDGE = {
  previousSha: 'c43e9dc8da3eb19a1684ed28e989aafacdb5d8bf',
  candidateSha: '0d6078be7a50ed3f5761d66071527be003bd568f',
  candidateTree: '5e50be3cb680e0c9db5faf3fcf3fca57ccdedaa4',
  transitions: [
    {
      path: 'packages/database/migrations/0096_profile_contacts.sql',
      status: 'A',
      oldMode: '000000',
      newMode: '100644',
      oldOid: '0000000000000000000000000000000000000000',
      newOid: 'dc9171185f0a7b75d80ecde64c6b08b4f3baa4c1',
      oldType: null,
      newType: 'blob',
    },
    {
      path: 'scripts/verify-timeweb-api-web-observability.d.ts',
      status: 'M',
      oldMode: '100644',
      newMode: '100644',
      oldOid: 'd282e352bc8cba454302bbaf5665b8341f67f78a',
      newOid: 'b6146afd73c86210bb1799dcd42a0e1760b346e1',
      oldType: 'blob',
      newType: 'blob',
    },
    {
      path: 'scripts/verify-timeweb-api-web-observability.js',
      status: 'M',
      oldMode: '100644',
      newMode: '100644',
      oldOid: '84b77275876866a14c3da9983d6d965a26c0f3e5',
      newOid: 'e7f8d4bbc520a459b1d389b4ee9fd87aee04a7bd',
      oldType: 'blob',
      newType: 'blob',
    },
  ],
};
// This release adds the #693 OpenAPI surface and an API-only environment admission.
// Git proves the application ancestor and the complete controller delta at execution.
const WHOLE_COURT_PREDECESSOR = '0a4d640965e921e6d06eeb22de6cc6dcae07f0b1';
const WHOLE_COURT_APPLICATION = 'fa6253a5e87bacd36502d077162b3e1fa11f8935';
const WHOLE_COURT_APPLICATION_TREE = '60b1e406e440a191b3a269d744ce4bf0e1919ae2';
const WHOLE_COURT_RUNTIME_FILES = new Map([
  [
    'contracts/openapi/user/v1/games.yaml',
    ['1b970798653c134286fadc3c340ae0fd7e2b1c5e', '7b3d498d1daf395f0d7c6bc6dfe08f7dc1047389'],
  ],
  [
    'contracts/openapi/user/v1/openapi.yaml',
    ['004f61e8bb7cdbbac4b96daae3efc422d283f9b2', '4ba386ed5969c9864794d09dce63a73dc188958b'],
  ],
  [
    'deploy/timeweb/runtime-environment.contract.json',
    ['6c239e3b55d64d5a9dcd4132f6c0575acd2e628c', '152ce28631763f1699a3fc44d0b70d28aed3bbab'],
  ],
]);
const WHOLE_COURT_CONTROLLER_FILES = new Set([
  'deploy/timeweb/runtime-environment.contract.json',
  'scripts/timeweb-api-web-upgrade.js',
  'scripts/timeweb-api-web-upgrade.test.ts',
  'scripts/timeweb-commercial-runtime-contract.js',
  'scripts/provision-timeweb-beta-runtime-secrets.test.ts',
  'docs/runbooks/timeweb-standard-delivery.md',
]);
const SCHEDULE_APPLICATION = '55f38b09d828f81e905f4c3b8709e29dbbba8bac';
const SCHEDULE_APPLICATION_TREE = '222180276f0ed790604636d92d0bcd318f1ea8f0';
const SCHEDULE_RUNTIME_FILES = new Map([
  [
    'contracts/openapi/user/v1/games.yaml',
    WHOLE_COURT_RUNTIME_FILES.get('contracts/openapi/user/v1/games.yaml'),
  ],
  [
    'contracts/openapi/user/v1/openapi.yaml',
    ['004f61e8bb7cdbbac4b96daae3efc422d283f9b2', 'cc59a6e8f48f9aa1ad29a64918413c0378987117'],
  ],
  [
    'deploy/timeweb/runtime-environment.contract.json',
    ['6c239e3b55d64d5a9dcd4132f6c0575acd2e628c', 'bbf85b5e48c58611709bf318c9ef02d7f78c845b'],
  ],
]);
const SCHEDULE_CONTROLLER_FILES = new Set([
  ...WHOLE_COURT_CONTROLLER_FILES,
  'scripts/provision-timeweb-beta-runtime-secrets.js',
  'scripts/provision-timeweb-beta-runtime-secrets.d.ts',
  'scripts/timeweb-api-web-upgrade.d.ts',
  'apps/api/src/main.ts',
  'apps/api/src/games/game-create-schedule-routes.ts',
  'apps/api/src/games/game-create-schedule-routes.test.ts',
  'apps/api/src/subscriptions/subscription-runtime-actor-delegation-issuer.ts',
  'scripts/control-timeweb-database-backup.py',
  'scripts/build-timeweb-canonical-backup-request.py',
  'scripts/test-timeweb-database-backup.py',
]);
const SCHEDULE_CI_FIX = {
  path: 'scripts/timeweb-closed-application-source.test.ts',
  oldOid: '51b39d77653eccd8ea7a35e964f299046aaf82c7',
  newOid: 'bba0007c041117a0bd67943661ff32f5e9bdfd95',
};
const regularModification = (entry) =>
  entry.status === 'M' &&
  entry.oldMode === '100644' &&
  entry.newMode === '100644' &&
  entry.oldType === 'blob' &&
  entry.newType === 'blob';

const CUP_SUPPORT_CONTROLLER_FILES = new Set([
  'deploy/timeweb/runtime-environment.contract.json',
  'docs/runbooks/timeweb-standard-delivery.md',
  'scripts/control-timeweb-database-backup.py',
  'scripts/provision-timeweb-beta-runtime-secrets.d.ts',
  'scripts/provision-timeweb-beta-runtime-secrets.js',
  'scripts/provision-timeweb-beta-runtime-secrets.test.ts',
  'scripts/test-timeweb-database-backup.py',
  'scripts/timeweb-api-web-upgrade.d.ts',
  'scripts/timeweb-api-web-upgrade.js',
  'scripts/timeweb-api-web-upgrade.test.ts',
  'scripts/verify-timeweb-deployment-contract.d.ts',
  'scripts/verify-timeweb-deployment-contract.js',
  'scripts/verify-timeweb-deployment-contract.test.ts',
]);

export function validateCupSupportRuntimeBridge(identity, applicationEntries, controllerEntries) {
  const openapiPath = 'contracts/openapi/user/v1/openapi.yaml';
  const contractPath = 'deploy/timeweb/runtime-environment.contract.json';
  const openapi = applicationEntries.find(({ path }) => path === openapiPath);
  const contract = controllerEntries.find(({ path }) => path === contractPath);
  if (
    identity.previousSha !== CUP_SUPPORT_PREDECESSOR.slice(0, 40) ||
    identity.applicationSha !== CUP_SUPPORT_APPLICATION ||
    identity.applicationTree !== CUP_SUPPORT_APPLICATION_TREE ||
    new Set(applicationEntries.map(({ path }) => path)).size !== applicationEntries.length ||
    new Set(controllerEntries.map(({ path }) => path)).size !== controllerEntries.length ||
    !openapi ||
    !regularModification(openapi) ||
    openapi.oldOid !== '889da8bba985597db0704f637a08e08c2c3d82c6' ||
    openapi.newOid !== '4635dd1e6ddc9d7d9449d221fbf591e73c18680a' ||
    !contract ||
    contract.oldOid !== 'bbf85b5e48c58611709bf318c9ef02d7f78c845b' ||
    contract.newOid !== '45de18e1ba5f5512579f6ef27099e59253e65088' ||
    controllerEntries.some(
      (entry) => !regularModification(entry) || !CUP_SUPPORT_CONTROLLER_FILES.has(entry.path),
    )
  )
    fail('cup_support_runtime_bridge');
  validateRuntimeDelta(
    applicationEntries.filter(({ path }) => path !== openapiPath).map(({ path }) => path),
  );
}

function inspectRuntimeDelta(from, to) {
  return parseRuntimeDelta(
    git(['diff', '--raw', '--no-abbrev', '--no-renames', '-z', from, to]),
  ).map((entry) => ({
    ...entry,
    oldType: entry.oldOid === '0'.repeat(40) ? null : git(['cat-file', '-t', entry.oldOid]),
    newType: entry.newOid === '0'.repeat(40) ? null : git(['cat-file', '-t', entry.newOid]),
  }));
}

function attestCupSupportSource(from, to) {
  git(['merge-base', '--is-ancestor', from, CUP_SUPPORT_APPLICATION]);
  git(['merge-base', '--is-ancestor', CUP_SUPPORT_APPLICATION, to]);
  validateCupSupportRuntimeBridge(
    {
      previousSha: from,
      applicationSha: CUP_SUPPORT_APPLICATION,
      applicationTree: git(['rev-parse', `${CUP_SUPPORT_APPLICATION}^{tree}`]),
    },
    inspectRuntimeDelta(from, CUP_SUPPORT_APPLICATION),
    inspectRuntimeDelta(CUP_SUPPORT_APPLICATION, to),
  );
}

export function validateScheduleRuntimeBridge(identity, entries, tail) {
  if (
    identity.previousSha !== WHOLE_COURT_PREDECESSOR ||
    identity.applicationSha !== SCHEDULE_APPLICATION ||
    identity.applicationTree !== SCHEDULE_APPLICATION_TREE ||
    !Array.isArray(tail) ||
    tail.length !==
      SCHEDULE_CONTROLLER_FILES.size +
        Number(tail.some((entry) => entry.path === SCHEDULE_CI_FIX.path)) ||
    new Set(tail.map(({ path }) => path)).size !== tail.length ||
    tail.some(
      (entry) =>
        !regularModification(entry) ||
        (entry.path === SCHEDULE_CI_FIX.path
          ? entry.oldOid !== SCHEDULE_CI_FIX.oldOid || entry.newOid !== SCHEDULE_CI_FIX.newOid
          : !SCHEDULE_CONTROLLER_FILES.has(entry.path)),
    ) ||
    new Set(entries.map(({ path }) => path)).size !== entries.length
  )
    fail('schedule_runtime_bridge');
  const protectedChanges = entries.filter(({ path }) => SCHEDULE_RUNTIME_FILES.has(path));
  if (
    protectedChanges.length !== SCHEDULE_RUNTIME_FILES.size ||
    protectedChanges.some((entry) => {
      const [before, after] = SCHEDULE_RUNTIME_FILES.get(entry.path);
      return !regularModification(entry) || entry.oldOid !== before || entry.newOid !== after;
    })
  )
    fail('schedule_runtime_bridge');
  validateRuntimeDelta(
    entries.filter(({ path }) => !SCHEDULE_RUNTIME_FILES.has(path)).map(({ path }) => path),
  );
}

function validateWholeCourtRuntimeBridge(identity, entries, tail) {
  if (
    identity.previousSha !== WHOLE_COURT_PREDECESSOR ||
    !tail?.length ||
    new Set(tail.map(({ path }) => path)).size !== tail.length ||
    tail.some(({ status, path }) => status !== 'M' || !WHOLE_COURT_CONTROLLER_FILES.has(path)) ||
    !tail.some(({ path }) => path === 'deploy/timeweb/runtime-environment.contract.json')
  )
    fail('whole_court_runtime_bridge');
  const definitionChanges = entries.filter(({ path }) => WHOLE_COURT_RUNTIME_FILES.has(path));
  if (
    definitionChanges.length !== WHOLE_COURT_RUNTIME_FILES.size ||
    definitionChanges.some(
      ({ path, status, oldMode, newMode, oldType, newType, oldOid, newOid }) => {
        const [before, after] = WHOLE_COURT_RUNTIME_FILES.get(path);
        return (
          status !== 'M' ||
          oldMode !== '100644' ||
          newMode !== '100644' ||
          oldType !== 'blob' ||
          newType !== 'blob' ||
          oldOid !== before ||
          newOid !== after
        );
      },
    )
  )
    fail('whole_court_runtime_bridge');
  validateRuntimeDelta(
    entries.filter(({ path }) => !WHOLE_COURT_RUNTIME_FILES.has(path)).map(({ path }) => path),
  );
}
export function parseRuntimeDelta(raw) {
  if (raw === '') return [];
  const parts = raw.split('\0');
  if (parts.pop() !== '' || parts.length % 2) fail('invalid_runtime_delta');
  return Array.from({ length: parts.length / 2 }, (_, i) => {
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMDT])$/.exec(parts[i * 2]);
    const path = parts[i * 2 + 1];
    if (!match || !path) fail('invalid_runtime_delta');
    return {
      path,
      oldMode: match[1],
      newMode: match[2],
      oldOid: match[3],
      newOid: match[4],
      status: match[5],
    };
  });
}
function attestAppOnlyDatabase(backup) {
  const proof = `import importlib.util,sys
spec=importlib.util.spec_from_file_location('backup',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
raw=sys.stdin.buffer.read()
op=m.strict(raw)
if not m.is_app_only_fresh(op): raise ValueError('APP_ONLY_BACKUP_SCHEMA')
m.attest_app_only_database(op)
sys.stdout.write('APP_ONLY_DATABASE_VERIFIED')`;
  const bytes = read(backup.operationPath);
  if (
    hash(bytes) !== backup.operationSha256 ||
    command(
      '/usr/bin/python3',
      ['-I', '-S', '-B', '-c', proof, `${SOURCE}/scripts/control-timeweb-database-backup.py`],
      { input: bytes, stdio: ['pipe', 'pipe', 'pipe'], timeout: 180000 },
    ) !== 'APP_ONLY_DATABASE_VERIFIED'
  )
    fail('app_only_database_drift');
}

// Nothing in the request can widen this scope. Every production read-code or
// contract change outside presentation must have reviewed, exact before/after blobs.
export function validateAppOnlyRuntimeDelta(entries) {
  if (!Array.isArray(entries) || new Set(entries.map(({ path }) => path)).size !== entries.length)
    fail('app_only_runtime_delta');
  for (const entry of entries) {
    const { path, oldMode, newMode, oldOid, newOid, status, oldType, newType } = entry;
    if (
      !['A', 'M'].includes(status) ||
      newMode !== '100644' ||
      newType !== 'blob' ||
      !SHA.test(newOid) ||
      (status === 'M'
        ? oldMode !== '100644' || oldType !== 'blob' || !SHA.test(oldOid) || oldOid === newOid
        : oldMode !== '000000' || oldType !== null || oldOid !== '0'.repeat(40))
    )
      fail('app_only_runtime_delta');
    if (
      /^docs\/[a-zA-Z0-9_./-]+\.md$/.test(path) ||
      /^apps\/web\/src\/[a-zA-Z0-9_./-]+\.css$/.test(path) ||
      (status === 'M' && APP_ONLY_CONTROLLER_POLICY_FILES.has(path))
    )
      continue;
    const reviewed = REVIEWED_APP_ONLY_READ_CHANGES.get(path);
    if (!reviewed || status !== 'M' || oldOid !== reviewed[0] || newOid !== reviewed[1])
      fail('app_only_runtime_delta');
  }
  return true;
}

function attestAppOnlySourceDelta(from, to) {
  if (!SHA.test(from) || !SHA.test(to)) fail('app_only_source');
  git(['merge-base', '--is-ancestor', from, to]);
  validateAppOnlyRuntimeDelta(inspectRuntimeDelta(from, to));
}

export function attestAppOnlyBackupScope(op) {
  const cupSupport = op?.schema === CUP_SUPPORT_BACKUP;
  if (
    (!cupSupport && op?.schema !== APP_ONLY_BACKUP) ||
    op.candidateSha !== op.controllerSha ||
    !SHA.test(op.candidateSha ?? '') ||
    git(['rev-parse', 'HEAD']) !== op.controllerSha ||
    git(['rev-parse', 'HEAD^{tree}']) !== op.controllerTree ||
    git(['status', '--porcelain', '--untracked-files=all']) !== ''
  )
    fail('app_only_source');
  for (const svc of ['api', 'web']) {
    const actual = inspect(svc);
    const expected = svc === 'api' ? op.expectedApi : op.expectedWeb;
    if (!ID.test(actual.releaseId ?? '') || !equal(actual, expected)) fail('app_only_predecessor');
    if (cupSupport) attestCupSupportSource(actual.releaseId.slice(0, 40), op.candidateSha);
    else attestAppOnlySourceDelta(actual.releaseId.slice(0, 40), op.candidateSha);
  }
  return 'APP_ONLY_BACKUP_SCOPE_VERIFIED';
}

export function validateRuntimeUpgrade(identity, entries, wholeCourtTail) {
  if (!Array.isArray(entries) || new Set(entries.map((v) => v.path)).size !== entries.length)
    fail('invalid_runtime_delta');
  const paths = entries.map((v) => v.path);
  try {
    validateRuntimeDelta(paths);
    return;
  } catch (error) {
    if (error.message !== 'runtime_definition_changed') throw error;
  }
  if (wholeCourtTail !== undefined)
    return validateWholeCourtRuntimeBridge(identity, entries, wholeCourtTail);
  const bridge = CALLBACK_RUNTIME_BRIDGE;
  if (
    identity.previousSha !== bridge.previousSha ||
    identity.candidateSha !== bridge.candidateSha ||
    identity.candidateTree !== bridge.candidateTree
  )
    fail('callback_runtime_bridge');
  const permitted = new Map(bridge.transitions.map((v) => [v.path, v]));
  const exceptional = entries.filter((v) => permitted.has(v.path));
  if (
    exceptional.length !== permitted.size ||
    exceptional.some((v) => {
      const expected = permitted.get(v.path);
      return Object.keys(expected).some((key) => v[key] !== expected[key]);
    })
  )
    fail('callback_runtime_bridge');
  validateRuntimeDelta(entries.filter((v) => !permitted.has(v.path)).map((v) => v.path));
}
export function validateUpgradeReceipt(
  receipt,
  planSha256,
  op = undefined,
  plan = undefined,
  planBytes = undefined,
) {
  if (receipt.schema === JOIN_RECEIPT)
    return validateJoinReceipt(receipt, planSha256, op, plan, planBytes);
  const keys = ['schema', 'status', 'planSha256', 'observedAt'];
  const direct = receipt.schema === 'PHUB_TIMEWEB_API_WEB_RECEIPT_V2';
  const schedule = receipt.schema === SCHEDULE_RECEIPT;
  const cupSupport = receipt.schema === CUP_SUPPORT_RECEIPT;
  const appOnly = receipt.schema === APP_ONLY_RECEIPT || cupSupport;
  const station = receipt.schema === STATION_RECEIPT;
  const stationDirect = station && Object.hasOwn(receipt, 'providerMonitoringStatus');
  const scheduleWaived = schedule && Object.hasOwn(receipt, 'ownerProviderMonitoringWaiverSha256');
  const cutover = [
    CUTOVER_RECEIPT,
    ROSTER_CUTOVER_RECEIPT,
    WAIVER_RECEIPT,
    OWNER_RECEIPT,
    CANONICAL_RECEIPT,
  ].includes(receipt.schema);
  const ownerDirected = [OWNER_RECEIPT, CANONICAL_RECEIPT].includes(receipt.schema);
  const baselineField =
    receipt.schema === CANONICAL_RECEIPT ? 'canonicalBaselineSha256' : 'legacyBaselineSha256';
  const waived = receipt.schema === WAIVER_RECEIPT;
  const roster = [
    ROSTER_CUTOVER_RECEIPT,
    WAIVER_RECEIPT,
    OWNER_RECEIPT,
    CANONICAL_RECEIPT,
  ].includes(receipt.schema);
  if (cutover) keys.push(baselineField);
  if (station) keys.push('databaseAdmissionSha256', 'alertTestStatus');
  if (stationDirect) keys.push('providerMonitoringStatus');
  if (direct) keys.push('evidencePolicy', 'providerEvidenceStatus');
  if (cupSupport) keys.push('alertTestStatus', 'ownerAlertDecisionSha256');
  if (scheduleWaived)
    keys.push(...Object.keys(SCHEDULE_MONITORING_STATUS), 'ownerProviderMonitoringWaiverSha256');
  if (
    receipt.status === 'SUCCESS' ||
    (receipt.status === 'RECONCILED' && receipt.reconciledStatus === 'SUCCESS')
  )
    keys.push(
      'installedBaselineSha256',
      'observationSha256',
      ...(ownerDirected
        ? [
            'ownerDecisionPolicy',
            'providerMonitoringStatus',
            'alertTestStatus',
            'restoreAdmissionPolicy',
            'repeatRestoreStatus',
            'ownerDecisionsSha256',
          ]
        : waived
          ? [
              'monitoringPolicy',
              'alertTestStatus',
              'nativeMonitoringAdmissionSha256',
              'ownerAlertWaiverSha256',
              'nativeMonitorReadbackSha256',
            ]
          : direct
            ? ['ownerObservationSha256', 'evidencePolicySha256']
            : scheduleWaived || stationDirect
              ? []
              : [
                  'providerReadbackSha256',
                  ...(!station && !cupSupport ? ['alertReadbackSha256'] : []),
                ]),
    );
  if (receipt.status === 'RECONCILED') keys.push('reconciledStatus');
  exact(receipt, keys);
  if (
    ![
      'PHUB_TIMEWEB_API_WEB_RECEIPT_V1',
      'PHUB_TIMEWEB_API_WEB_RECEIPT_V2',
      SCHEDULE_RECEIPT,
      APP_ONLY_RECEIPT,
      CUP_SUPPORT_RECEIPT,
      STATION_RECEIPT,
      CUTOVER_RECEIPT,
      ROSTER_CUTOVER_RECEIPT,
      WAIVER_RECEIPT,
      OWNER_RECEIPT,
      CANONICAL_RECEIPT,
    ].includes(receipt.schema) ||
    receipt.planSha256 !== planSha256 ||
    !HASH.test(planSha256) ||
    (cutover && !HASH.test(receipt[baselineField] ?? '')) ||
    (station &&
      (!HASH.test(receipt.databaseAdmissionSha256 ?? '') ||
        receipt.alertTestStatus !== STATION_ALERT_STATUS)) ||
    (stationDirect && receipt.providerMonitoringStatus !== STATION_PROVIDER_STATUS) ||
    (cupSupport &&
      (receipt.alertTestStatus !== CUP_SUPPORT_ALERT_STATUS ||
        !HASH.test(receipt.ownerAlertDecisionSha256 ?? ''))) ||
    !Number.isFinite(Date.parse(receipt.observedAt)) ||
    ![
      'PREPARING',
      'PREPARED',
      'API_INTENT',
      'API_ACTIVE',
      'WEB_INTENT',
      'OBSERVING',
      'SUCCESS',
      'ROLLBACK_INTENT',
      'ROLLED_BACK',
      'ROLLBACK_FAILED',
      'ABORTED',
      'RECONCILED',
      ...(schedule || cupSupport ? SCHEDULE_PHASES : []),
      ...(appOnly && !cupSupport ? ['BASELINE_INTENT'] : []),
      ...(roster || station
        ? [
            'WORKER_STOP_INTENT',
            'WORKER_STOPPED',
            'WORKER_INTENT',
            'WORKER_ACTIVE',
            'BASELINE_INTENT',
          ]
        : []),
    ].includes(receipt.status) ||
    (receipt.status === 'RECONCILED' &&
      !['SUCCESS', 'ROLLED_BACK', 'ABORTED'].includes(receipt.reconciledStatus)) ||
    (ownerDirected &&
      keys.includes('installedBaselineSha256') &&
      (receipt.ownerDecisionPolicy !==
        (receipt.schema === CANONICAL_RECEIPT ? CANONICAL_OWNER_POLICY : OWNER_POLICY) ||
        receipt.restoreAdmissionPolicy !==
          (receipt.schema === CANONICAL_RECEIPT
            ? CANONICAL_PRIOR_RESTORE_POLICY
            : PRIOR_RESTORE_POLICY) ||
        receipt.repeatRestoreStatus !== 'NOT_REPEATED_PRIOR_FULL_RESTORE_VERIFIED' ||
        receipt.providerMonitoringStatus !== PROVIDER_SKIPPED ||
        receipt.alertTestStatus !== WAIVER_STATUS)) ||
    (waived &&
      keys.includes('installedBaselineSha256') &&
      (receipt.monitoringPolicy !== WAIVER_POLICY || receipt.alertTestStatus !== WAIVER_STATUS)) ||
    (direct &&
      (receipt.evidencePolicy !== CALLBACK_DIRECT_POLICY ||
        receipt.providerEvidenceStatus !== 'NOT_COLLECTED_EXPLICIT_OVERRIDE')) ||
    (scheduleWaived &&
      (!HASH.test(receipt.ownerProviderMonitoringWaiverSha256 ?? '') ||
        Object.entries(SCHEDULE_MONITORING_STATUS).some(
          ([key, value]) => receipt[key] !== value,
        ))) ||
    (keys.includes('installedBaselineSha256') &&
      [
        'installedBaselineSha256',
        'observationSha256',
        ...(ownerDirected
          ? ['ownerDecisionsSha256']
          : waived
            ? [
                'nativeMonitoringAdmissionSha256',
                'ownerAlertWaiverSha256',
                'nativeMonitorReadbackSha256',
              ]
            : direct
              ? ['ownerObservationSha256', 'evidencePolicySha256']
              : scheduleWaived || stationDirect
                ? []
                : [
                    'providerReadbackSha256',
                    ...(!station && !cupSupport ? ['alertReadbackSha256'] : []),
                  ]),
      ].some((key) => !HASH.test(receipt[key] ?? '')))
  )
    fail('invalid_receipt');
  if (op || plan) {
    if (
      !op ||
      !plan ||
      isDirectOperation(op) !== direct ||
      isScheduleOperation(op) !== schedule ||
      isCupSupportOperation(op) !== cupSupport ||
      isAppOnlyOperation(op) !== appOnly ||
      isStationRollout(op) !== station ||
      isStationDirectOperation(op) !== stationDirect ||
      (station &&
        receipt.databaseAdmissionSha256 !== hash(JSON.stringify(plan.databaseAdmission))) ||
      (appOnly && plan.backup?.operationSha256 !== op.backupOperationSha256) ||
      (schedule && scheduleWaived !== Object.hasOwn(op, 'ownerProviderMonitoringWaiver')) ||
      isProductionCutover(op) !== cutover ||
      (cutover && receipt.schema !== cutoverReceiptSchema(op)) ||
      isRosterCutover(op) !== roster ||
      isWaivedRosterCutover(op) !== waived ||
      isOwnerDirectedCutover(op) !== ownerDirected ||
      !Buffer.isBuffer(planBytes) ||
      hash(planBytes) !== planSha256 ||
      !equal(JSON.parse(planBytes), plan) ||
      plan.controllerSha !== op.controllerSha ||
      plan.schema !==
        (cutover
          ? cutoverPlanSchema(op)
          : direct
            ? 'PHUB_TIMEWEB_API_WEB_PLAN_V2'
            : schedule
              ? SCHEDULE_PLAN
              : appOnly
                ? cupSupport
                  ? CUP_SUPPORT_PLAN
                  : APP_ONLY_PLAN
                : station
                  ? STATION_PLAN
                  : 'PHUB_TIMEWEB_API_WEB_PLAN_V1') ||
      (cutover &&
        (plan[baselineField] !== cutoverBaselineHash(op) ||
          receipt[baselineField] !== plan[baselineField]))
    )
      fail('receipt_context');
    if (station) validateStationRetainedAdmission(plan.databaseAdmission, op);
    if (cupSupport) {
      validateCupSupportAlertDecision(op);
      const decision = cupSupportAlertReceipt(op);
      if (
        plan.ownerAlertDecisionSha256 !== decision.ownerAlertDecisionSha256 ||
        Date.parse(plan.createdAt) < Date.parse(op.ownerAlertDecision.receivedAt) ||
        !Number.isFinite(Date.parse(plan.createdAt)) ||
        !Object.entries(decision).every(([key, value]) => receipt[key] === value)
      )
        fail('receipt_cup_support_alert_decision');
    }
    if (scheduleWaived) {
      validateScheduleMonitoringWaiver(op);
      const expected = scheduleMonitoringReceipt(op);
      if (
        plan.ownerProviderMonitoringWaiverSha256 !== expected.ownerProviderMonitoringWaiverSha256 ||
        !Number.isFinite(Date.parse(plan.createdAt)) ||
        Date.parse(plan.createdAt) < Date.parse(op.ownerProviderMonitoringWaiver.receivedAt) ||
        Object.entries(expected).some(([key, value]) => receipt[key] !== value)
      )
        fail('receipt_schedule_monitoring_waiver');
    }
    if (ownerDirected) {
      validateOwnerDirectedBinding(op, plan.monitoring, plan.operationSha256);
      if (
        keys.includes('installedBaselineSha256') &&
        Object.entries(ownerDirectedReceipt(plan.monitoring)).some(([k, v]) => receipt[k] !== v)
      )
        fail('receipt_owner_decision');
    }
    if (
      waived &&
      keys.includes('installedBaselineSha256') &&
      Object.entries(nativeAdmissionReceipt(plan.monitoring)).some(
        ([key, value]) => receipt[key] !== value,
      )
    )
      fail('receipt_native_admission');
    if (
      waived &&
      keys.includes('installedBaselineSha256') &&
      Date.parse(plan.monitoring.admittedAt) > Date.parse(receipt.observedAt)
    )
      fail('receipt_native_time');
    if (
      direct &&
      (plan.evidencePolicy !== receipt.evidencePolicy ||
        plan.evidencePolicySha256 !== policyHash(op))
    )
      fail('receipt_policy_context');
  }
  return receipt;
}
export function validateScheduleDirectObservation(value, op, plan, planSha256) {
  if (
    !isScheduleOperation(op) ||
    !op.ownerProviderMonitoringWaiver ||
    value?.schema !== SCHEDULE_DIRECT_OBSERVATION
  )
    fail('schedule_observation_identity');
  validateJoinObservation(
    { ...value, schema: 'PHUB_TIMEWEB_JOIN_DORMANT_OBSERVATION_V1' },
    op,
    plan,
    planSha256,
  );
  return value;
}
export function validateCupSupportDirectObservation(value, op, plan, planSha256) {
  if (!isCupSupportOperation(op) || value?.schema !== CUP_SUPPORT_DIRECT_OBSERVATION)
    fail('cup_support_observation_identity');
  validateCupSupportAlertDecision(op);
  validateJoinObservation(
    { ...value, schema: 'PHUB_TIMEWEB_JOIN_DORMANT_OBSERVATION_V1' },
    op,
    plan,
    planSha256,
  );
  return value;
}
function attestCupSupportDirectEvidence(transaction, op, plan, planSha256) {
  const observation = validateCupSupportDirectObservation(
    parseStrictJson(read(`${transaction}/observation.json`)),
    op,
    plan,
    planSha256,
  );
  attestCupSupportProviderBytes(
    read(`${transaction}/timeweb-monitor-readback.json`),
    op,
    observation.completedAt,
  );
}
export function validateDirectObservation(value, completedAt = undefined) {
  exact(value, [
    'schema',
    'evidencePolicy',
    'authorization',
    'startedAt',
    'completedAt',
    'elapsedSeconds',
    'samples',
    'providerEvidence',
    'candidateSha',
  ]);
  if (
    value.schema !== 'PHUB_TIMEWEB_API_WEB_DIRECT_OBSERVATION_V1' ||
    value.evidencePolicy !== CALLBACK_DIRECT_POLICY ||
    value.authorization !== 'NOT_COLLECTED_EXPLICIT_OVERRIDE' ||
    value.candidateSha !== CALLBACK_DIRECT_CANDIDATE.candidateSha ||
    value.providerEvidence !== 'NOT_COLLECTED_EXPLICIT_OVERRIDE' ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    !Number.isFinite(value.elapsedSeconds) ||
    value.elapsedSeconds < 900 ||
    (Date.parse(value.completedAt) - Date.parse(value.startedAt)) / 1000 !== value.elapsedSeconds ||
    Date.parse(value.completedAt) > Date.parse(CALLBACK_DIRECT_EXPIRY) ||
    (completedAt && value.completedAt !== completedAt) ||
    !value.samples ||
    Object.keys(value.samples).sort().join(',') !== 'api,web'
  )
    fail('direct_observation_identity');
  for (const service of ['api', 'web']) {
    const v = value.samples[service];
    exact(v, ['privateMs', 'publicMs', 'timestamps', 'p95PrivateMs', 'p95PublicMs']);
    if (
      ![v.privateMs, v.publicMs, v.timestamps].every(Array.isArray) ||
      v.privateMs.length !== 61 ||
      v.publicMs.length !== 61 ||
      v.timestamps.length !== 61 ||
      ![...v.privateMs, ...v.publicMs, v.p95PrivateMs, v.p95PublicMs].every(
        (n) => Number.isFinite(n) && n >= 0,
      ) ||
      v.timestamps.some(
        (t, i) =>
          !Number.isFinite(Date.parse(t)) ||
          Date.parse(t) < Date.parse(value.startedAt) ||
          Date.parse(t) > Date.parse(value.completedAt) ||
          (i && Date.parse(t) - Date.parse(v.timestamps[i - 1]) < 15000),
      ) ||
      (() => {
        const p = (xs) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1];
        return (
          v.p95PrivateMs !== p(v.privateMs) ||
          v.p95PublicMs !== p(v.publicMs) ||
          Math.max(
            v.privateMs.map((n, i) => Math.max(n, v.publicMs[i])).sort((a, b) => a - b)[
              Math.ceil(v.privateMs.length * 0.95) - 1
            ],
          ) > (service === 'api' ? 1500 : 1000)
        );
      })()
    )
      fail('direct_observation_samples');
  }
  return value;
}
// Validate historical V2 custody from exact bytes. Current time is intentionally irrelevant;
// the measured observation must still have completed inside the original authorization window.
export function validateDirectInstalledEvidence(
  receipt,
  planBytes,
  operationBytes,
  ownerBytes,
  observationBytes,
  releaseId,
  installedImages,
) {
  const op = validateDirectApiWebOperation(JSON.parse(operationBytes));
  const plan = JSON.parse(planBytes);
  validateUpgradeReceipt(receipt, hash(planBytes), op, plan, planBytes);
  const ownerHash = hash(ownerBytes);
  if (
    plan.operationSha256 !== hash(operationBytes) ||
    plan.ownerObservationSha256 !== ownerHash ||
    receipt.ownerObservationSha256 !== ownerHash ||
    receipt.evidencePolicySha256 !== policyHash(op) ||
    receipt.observationSha256 !== hash(observationBytes) ||
    releaseId !== `${op.candidateSha}-${op.publicationRunId}-1` ||
    plan.manifestSha256 !== op.manifestSha256 ||
    plan.artifactDigest !== op.artifactDigest ||
    !(
      receipt.status === 'SUCCESS' ||
      (receipt.status === 'RECONCILED' && receipt.reconciledStatus === 'SUCCESS')
    )
  )
    fail('installed_direct_evidence_drift');
  for (const service of ['api', 'web']) {
    const expected = op[service === 'api' ? 'expectedApi' : 'expectedWeb'];
    if (
      !plan.candidate?.[service] ||
      plan.candidate[service].releaseId !== releaseId ||
      plan.candidate[service].image !== installedImages[service] ||
      !plan.previous?.[service] ||
      ['id', 'image', 'releaseId'].some((key) => plan.previous[service][key] !== expected[key])
    )
      fail('installed_direct_component_drift');
  }
  if (!ownerBytes.equals(directOwnerBytes(op, hash(operationBytes))))
    fail('installed_direct_owner_drift');
  validateDirectOwnerObservation(JSON.parse(ownerBytes), op, hash(operationBytes));
  validateDirectObservation(JSON.parse(observationBytes));
}
// Installed Worker gate is a retained runtime dependency across API/Web-only releases.
export function buildApiWebInstalledDescriptor(values, plan, id, journalPath) {
  // The installed descriptor is the running API/Web pair only: always the canonical API_WEB kind,
  // never the one-shot adoption metadata of the baseline it replaces. Rollback targets the exact
  // baseline this rollout replaces, in the renderer's canonical vocabulary.
  const previousReleaseId = ID.test(values.PHUB_RELEASE_ID ?? '') ? values.PHUB_RELEASE_ID : null;
  const next = {
    ...values,
    PHUB_TIMEWEB_RELEASE_ENV_SCHEMA: 'PHUB_TIMEWEB_INSTALLED_COMPONENT_ENV_V1',
    PHUB_COMPONENT_ROLLOUT_KIND:
      plan.schema === CANONICAL_PLAN
        ? CANONICAL_KIND
        : plan.schema === OWNER_PLAN
          ? OWNER_KIND
          : plan.schema === WAIVER_PLAN
            ? WAIVER_KIND
            : plan.schema === STATION_PLAN
              ? STATION_KIND
              : plan.candidate.worker
                ? ROSTER_CUTOVER_KIND
                : plan.schema === SCHEDULE_PLAN
                  ? SCHEDULE_INSTALLED_KIND
                  : 'API_WEB',
    PHUB_RELEASE_ID: id,
    PHUB_RUNTIME_SECRET_SET_RELEASE_ID: [SCHEDULE_PLAN, CUP_SUPPORT_PLAN].includes(plan.schema)
      ? plan.candidateSecrets.releaseId
      : plan.secretSetReleaseId,
    PHUB_COMPONENT_ROLLOUT_RECEIPT: journalPath,
    PHUB_ROLLBACK_MODE: previousReleaseId
      ? 'previous-release-only'
      : 'stop-candidate-no-previous-release',
    PHUB_ROLLBACK_PREVIOUS_RELEASE_ID: previousReleaseId ?? 'NONE',
    API_IMAGE_DIGEST: plan.candidate.api.image.split('@')[1],
    WEB_IMAGE_DIGEST: plan.candidate.web.image.split('@')[1],
    ...(plan.candidate.worker
      ? { WORKER_IMAGE_DIGEST: plan.candidate.worker.image.split('@')[1] }
      : {}),
  };
  if (values.PHUB_WORKER_DELIVERY_GATE_RECEIPT) {
    if (
      plan.unchangedServiceImages.worker !==
      `ghcr.io/z6v6e6r/phub-worker@${values.WORKER_IMAGE_DIGEST}`
    )
      fail('installed_worker_gate_component_change');
  }
  for (const service of ['worker', 'realtime'])
    if (plan.unchangedServiceImages[service])
      next[`${service.toUpperCase()}_IMAGE_DIGEST`] =
        plan.unchangedServiceImages[service].split('@')[1];
  // This is an installed-component descriptor, never a new/mixed canonical manifest.
  for (const key of Object.keys(next))
    if (
      key.startsWith('PHUB_CANONICAL_') ||
      key.startsWith('PHUB_PUBLICATION_') ||
      key.startsWith('PHUB_ADOPTION_') ||
      key.startsWith('PHUB_LEGACY_') ||
      key.endsWith('_RUNTIME_DIGEST') ||
      key === 'PHUB_RELEASE_SOURCE_SHA' ||
      key === 'PHUB_RELEASE_SOURCE_TREE'
    )
      delete next[key];
  if (plan.legacyBaselineSha256) {
    next.PHUB_ROLLBACK_MODE = 'attested-previous-runtime';
    next.PHUB_ROLLBACK_PREVIOUS_RELEASE_ID = 'NONE';
    next.PHUB_LEGACY_PREDECESSOR_SHA256 = plan.legacyBaselineSha256;
    next.PHUB_LEGACY_PREDECESSOR_RELEASE_ID = plan.previous.api.releaseId;
    next.PHUB_LEGACY_PREDECESSOR_RECEIPT = `${dirname(journalPath)}/legacy-predecessor-attestation.json`;
  }
  if (plan.canonicalBaselineSha256) {
    next.PHUB_CANONICAL_PREDECESSOR_SHA256 = plan.canonicalBaselineSha256;
    next.PHUB_CANONICAL_PREDECESSOR_RELEASE_ID = plan.previous.api.releaseId;
    next.PHUB_CANONICAL_PREDECESSOR_ATTESTATION = `${dirname(journalPath)}/canonical-predecessor-attestation.json`;
  }
  return Buffer.from(
    Object.entries(next)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n',
  );
}
export function validateInstalledCutoverKind(kind, receiptSchema) {
  if (kind === STATION_KIND || receiptSchema === STATION_RECEIPT) {
    if (kind !== STATION_KIND || receiptSchema !== STATION_RECEIPT) fail('installed_station_kind');
    return;
  }
  if ([APP_ONLY_RECEIPT, CUP_SUPPORT_RECEIPT].includes(receiptSchema)) {
    if (kind !== 'API_WEB') fail('installed_app_only_kind');
    return;
  }
  if (kind === SCHEDULE_INSTALLED_KIND || receiptSchema === SCHEDULE_RECEIPT) {
    if (kind !== SCHEDULE_INSTALLED_KIND || receiptSchema !== SCHEDULE_RECEIPT)
      fail('installed_schedule_kind');
    return;
  }
  if (kind === CANONICAL_KIND || receiptSchema === CANONICAL_RECEIPT) {
    if (kind !== CANONICAL_KIND || receiptSchema !== CANONICAL_RECEIPT)
      fail('installed_cutover_kind');
    return;
  }
  if (kind === OWNER_KIND || receiptSchema === OWNER_RECEIPT) {
    if (kind !== OWNER_KIND || receiptSchema !== OWNER_RECEIPT) fail('installed_cutover_kind');
    return;
  }
  if (kind === WAIVER_KIND || receiptSchema === WAIVER_RECEIPT) {
    if (kind !== WAIVER_KIND || receiptSchema !== WAIVER_RECEIPT) fail('installed_cutover_kind');
    return;
  }
  if ((kind === ROSTER_CUTOVER_KIND) !== (receiptSchema === ROSTER_CUTOVER_RECEIPT))
    fail('installed_cutover_kind');
}
export function readInstalledWorkerGate(receiptPath, installedWorkerImage) {
  const match =
    /^\/opt\/phub\/timeweb-beta\/backups\/([a-f0-9]{40}-[1-9][0-9]*-1)-api-worker\/rollout-receipt\.json$/.exec(
      receiptPath,
    );
  if (!match) fail('installed_worker_gate_path');
  const release = match[1],
    tx = dirname(receiptPath),
    opBytes = read(`${tx}/operation.json`),
    op = parseStrictJson(opBytes),
    planBytes = read(`${tx}/plan.json`);
  if (!isPreservedNotificationRollout(op) && !isR1ApiWorker119(op))
    fail('installed_worker_gate_profile');
  const descriptor = read(`${ROOT}/releases/${release}/installed-components.env`),
    values = parseEnv(descriptor);
  validateInstalledApiWorkerEvidence({
    releaseId: release,
    values,
    bytes: descriptor,
    receipt: parseStrictJson(read(receiptPath)),
    planBytes,
    operationBytes: opBytes,
    evidence: Object.fromEntries(
      [
        'observation.json',
        ...(isR1ApiWorker119(op)
          ? ['runtime-grant-intent.json', 'runtime-grant-terminal.json']
          : []),
        'fcm-drain.json',
        'fcm-delivery-gate/held.json',
        'fcm-delivery-gate/released.json',
      ].map((name) => [
        name,
        read(`${tx}/${name}`, name.startsWith('fcm-delivery-gate/') ? 0o644 : 0o600),
      ]),
    ),
  });
  const binding = fcmGateBinding(op, hash(opBytes), hash(planBytes)),
    directory = `${tx}/fcm-delivery-gate`,
    override = `${tx}/candidate-worker-gate.compose.json`;
  if (
    installedWorkerImage !== op.workerImage ||
    readFcmDeliveryGate(directory, binding) !== 'RELEASED' ||
    !read(override).equals(Buffer.from(fcmGateComposeOverride(directory, binding)))
  )
    fail('installed_worker_gate_drift');
  const identity = inspect('worker'),
    actual = parseStrictJson(docker(['inspect', identity.id]))[0];
  const saved = parseStrictJson(read(`${tx}/candidate-worker.identity.json`));
  const configHash = read(`${tx}/candidate-worker.config-hash`).toString().trim();
  if (
    !HASH.test(configHash) ||
    actual.Config.Labels?.['com.docker.compose.config-hash'] !== configHash ||
    identity.image !== op.workerImage ||
    identity.imageId !== saved.imageId ||
    identity.revision !== op.candidateSha ||
    identity.releaseId !== null
  )
    fail('installed_worker_gate_runtime');
  validateFcmGateRuntime(
    { mounts: actual.Mounts, environment: actual.Config.Env ?? [] },
    directory,
    binding,
  );
  return { receiptPath, directory, override, binding, configHash };
}
export function readLegacyPredecessor(op, recovering = false) {
  const legacy = op.legacyBaseline;
  validateProductionCutover(op);
  const transaction = `${ROOT}/backups/${op.candidateSha}-${op.publicationRunId}-1-api-web`;
  if (recovering) {
    if (
      hash(read(`${transaction}/legacy-predecessor-attestation.json`)) !==
      legacyBaselineHash(legacy)
    )
      fail('legacy_attestation_drift');
  } else {
    const current = read(`${ROOT}/beta-lane/current`);
    const history = read(`${ROOT}/beta-lane/history`);
    if (
      current.toString() !== `${legacy.sourceSha}\n` ||
      hash(current) !== legacy.laneCurrentSha256 ||
      hash(history) !== legacy.laneHistorySha256 ||
      history.toString().trimEnd().split('\n').at(-1)?.split(' ')[1] !== legacy.sourceSha ||
      git(['rev-parse', `${legacy.sourceSha}^{tree}`]) !== legacy.sourceTree
    )
      fail('legacy_lane_drift');
  }
  const path = recovering ? `${transaction}/legacy-release.env` : legacyReleaseEnvPath(legacy),
    bytes = read(path);
  const identity = parseStrictJson(read(`${RUNTIME}/.release-identity.json`));
  const values = legacyEnvironment(legacy, bytes, identity);
  const secrets = secretHashes();
  if (!SECRET_NAMES.every((name) => secrets[name] === legacy.secretHashes[name]))
    fail('legacy_secret_drift');
  for (const record of recovering ? [] : legacy.buildRecords)
    if (
      `sha256:${hash(read(legacyBuildArchivePath(legacy, record.component)))}` !==
      record.archiveDigest
    )
      fail('legacy_build_record_drift');
  return { path, bytes, values, secretSetReleaseId: legacy.secretSetReleaseId };
}
/** The V4 stager retains the original ZIP, never an extracted manifest file. */
export function validateCanonicalPredecessorArchive(baseline, operationBytes, archiveBytes) {
  const b = validateCanonicalBaseline(baseline);
  const op = validateProductionCutover(parseStrictJson(operationBytes));
  if (
    hash(operationBytes) !== b.operationSha256 ||
    ![
      'PHUB_TIMEWEB_API_WORKER_WEB_OWNER_DIRECTED_CUTOVER_V4',
      'PHUB_TIMEWEB_API_WORKER_WEB_CANONICAL_UPGRADE_V5',
    ].includes(op.schema) ||
    op.candidateSha !== b.sourceSha ||
    op.candidateTree !== b.sourceTree ||
    op.sourceCiRunId !== b.sourceCiRunId ||
    op.publicationRunId !== b.publicationRunId ||
    op.artifactId !== b.artifactId ||
    op.manifestSha256 !== b.manifestSha256 ||
    `sha256:${hash(archiveBytes)}` !== op.artifactDigest
  )
    fail('canonical_predecessor_archive_binding');
  const pair = extractCanonicalPredecessorArtifactPair(archiveBytes);
  const bytes = pair.get('release-manifest.json'),
    checksum = pair.get('release-manifest.sha256');
  if (
    hash(bytes) !== b.manifestSha256 ||
    !checksum.equals(Buffer.from(`${b.manifestSha256}  release-manifest.json\n`))
  )
    fail('canonical_predecessor_archive_checksum');
  const manifest = parseStrictJson(bytes);
  validateCanonicalManifest(manifest, {
    expectedPublication: {
      workflowSha: b.sourceSha,
      runId: b.publicationRunId,
      runAttempt: '1',
    },
    expectedBaseLockPath: `${SOURCE}/deploy/timeweb/base-images.lock.json`,
  });
  if (manifest.gitCommit !== b.sourceSha || manifest.gitTree !== b.sourceTree)
    fail('canonical_predecessor_archive_source');
  return bytes;
}
export function readCanonicalPredecessorManifest(baseline) {
  const b = validateCanonicalBaseline(baseline),
    directory = `${ROOT}/releases/${b.installedReleaseId}`;
  secure(directory, 0o700);
  secure(`${directory}/artifact`, 0o700);
  if (
    !equal(readdirSync(directory).sort(), ['artifact', 'installed-components.env']) ||
    !equal(readdirSync(`${directory}/artifact`).sort(), ['canonical-artifact.zip'])
  )
    fail('canonical_predecessor_release_inventory');
  const path = `${directory}/artifact/canonical-artifact.zip`;
  // Reject links directly: this historical reader must never normalize or write old custody.
  const before = secure(path, 0o600);
  const archive = read(path, 0o600, 4 * 1024 * 1024, false),
    operation = read(
      `${ROOT}/backups/${b.installedReleaseId}-api-web/operation.json`,
      0o600,
      4 * 1024 * 1024,
      false,
    );
  const bytes = validateCanonicalPredecessorArchive(b, operation, archive);
  const after = secure(path, 0o600);
  if (
    ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some((k) => before[k] !== after[k]) ||
    !archive.equals(read(path, 0o600, 4 * 1024 * 1024, false))
  )
    fail('canonical_predecessor_archive_race');
  return bytes;
}
/** Forward-only live admission. A retained historical predecessor never calls this function. */
export function deriveInstalledCanonicalBaseline(template) {
  const api = inspect('api');
  const id = api.releaseId;
  if (typeof id !== 'string' || !/^[0-9a-f]{40}-[1-9][0-9]*-1$/u.test(id))
    fail('installed_release_identity');
  const descriptor = readInstalledApiBaseline(id, { checkRuntimeSecrets: true });
  const transaction = ROOT + '/backups/' + id + '-api-web';
  const operationBytes = read(transaction + '/operation.json');
  const operation = parseStrictJson(operationBytes);
  if (operation.candidateSha !== id.slice(0, 40)) fail('installed_release_operation');
  return {
    schema: 'PHUB_TIMEWEB_INSTALLED_CANONICAL_ROSTER_RUNTIME_V1',
    capturedAt: new Date().toISOString(),
    installedReleaseId: id,
    sourceSha: id.slice(0, 40),
    sourceTree: operation.candidateTree,
    sourceCiRunId: String(operation.sourceCiRunId),
    publicationRunId: String(operation.publicationRunId),
    artifactId: String(operation.artifactId),
    manifestSha256: operation.manifestSha256,
    installedDescriptorSha256: hash(descriptor.bytes),
    operationSha256: hash(operationBytes),
    planSha256: hash(read(transaction + '/plan.json')),
    receiptSha256: hash(read(transaction + '/rollout-receipt.json')),
    observationSha256: hash(read(transaction + '/observation.json')),
    backupOperationSha256: hash(read(transaction + '/backup-operation.json')),
    backupReceiptSha256: hash(read(transaction + '/database-backup-receipt.json')),
    secretSetReleaseId: descriptor.secretSetReleaseId,
    secretHashes: secretHashes(),
    containers: {
      api,
      web: inspect('web'),
      worker: inspect('worker'),
      realtime: inspect('realtime'),
    },
    excludedSha256: hash(JSON.stringify(excluded(['api', 'worker', 'web']))),
    databaseTarget: template.databaseTarget,
    ledgerSha256: template.ledgerSha256,
  };
}

export function attestCanonicalBaseline(baseline) {
  const b = validateCanonicalBaseline(baseline);
  const installed = readInstalledApiBaseline(b.installedReleaseId, { checkRuntimeSecrets: true });
  const currentSecrets = secretHashes();
  const transaction = `${ROOT}/backups/${b.installedReleaseId}-api-web`;
  const files = {
    operationSha256: 'operation.json',
    planSha256: 'plan.json',
    receiptSha256: 'rollout-receipt.json',
    observationSha256: 'observation.json',
    backupOperationSha256: 'backup-operation.json',
    backupReceiptSha256: 'database-backup-receipt.json',
  };
  if (
    hash(installed.bytes) !== b.installedDescriptorSha256 ||
    installed.secretSetReleaseId !== b.secretSetReleaseId ||
    ![OWNER_KIND, CANONICAL_KIND].includes(installed.values.PHUB_COMPONENT_ROLLOUT_KIND) ||
    hash(readCanonicalPredecessorManifest(b)) !== b.manifestSha256 ||
    git(['rev-parse', `${b.sourceSha}^{tree}`]) !== b.sourceTree ||
    Object.entries(files).some(([k, name]) => hash(read(`${transaction}/${name}`)) !== b[k]) ||
    hash(JSON.stringify(excluded(['api', 'worker', 'web']))) !== b.excludedSha256 ||
    SECRET_NAMES.some((name) => currentSecrets[name] !== b.secretHashes[name])
  )
    fail('canonical_predecessor_custody');
  const priorReceipt = parseStrictJson(read(`${transaction}/rollout-receipt.json`));
  if (
    ![OWNER_RECEIPT, CANONICAL_RECEIPT].includes(priorReceipt.schema) ||
    priorReceipt.status !== 'RECONCILED' ||
    priorReceipt.reconciledStatus !== 'SUCCESS'
  )
    fail('canonical_predecessor_terminal');
  for (const service of ['api', 'worker', 'web', 'realtime']) {
    const actual = inspect(service),
      expected = b.containers[service];
    if (Object.keys(expected).some((k) => actual[k] !== expected[k]))
      fail('canonical_predecessor_runtime');
    if (installed.values[`${service.toUpperCase()}_IMAGE_DIGEST`] !== expected.image.split('@')[1])
      fail('canonical_predecessor_descriptor');
  }
  return installed;
}
export function attestCanonicalBackupOperation(op) {
  if (
    op.schema !== CANONICAL_FRESH_OPERATION ||
    op.controllerSha !== op.candidateSha ||
    op.toolCommit !== op.controllerSha ||
    git(['rev-parse', 'HEAD']) !== op.controllerSha ||
    git(['rev-parse', 'HEAD^{tree}']) !== op.controllerTree ||
    git(['status', '--porcelain', '--untracked-files=all']) !== ''
  )
    fail('canonical_backup_source');
  const config = parseStrictJson(read(CONFIG));
  if (
    config.schema !== 1 ||
    config.enabled !== true ||
    config.controllerSha !== op.controllerSha ||
    hash(read(CONFIG)) !== op.controllerConfigSha256
  )
    fail('canonical_backup_controller');
  for (const path of git(['ls-files', '-z']).split('\0').filter(Boolean))
    secure(`${SOURCE}/${path}`);
  const installed = attestCanonicalBaseline(op.canonicalBaseline);
  return {
    schema: 'PHUB_TIMEWEB_CANONICAL_BACKUP_ADMISSION_V1',
    canonicalBaselineSha256: cutoverBaselineHash({
      schema: 'PHUB_TIMEWEB_API_WORKER_WEB_CANONICAL_UPGRADE_V5',
      canonicalBaseline: op.canonicalBaseline,
    }),
    installedDescriptorSha256: hash(installed.bytes),
    runtimeSecretsChecked: true,
  };
}
/** Offline validation of the exact retained V4 outer files; never consults active 4b8 runtime. */
export function validateCanonicalHistoricalArtifacts(baseline, files) {
  const b = validateCanonicalBaseline(baseline);
  const names = [
    'FRESH_DUMP_INTEGRITY_VERIFIED.json',
    'backup-operation.json',
    'backup.complete',
    'candidate.env',
    'database-backup-receipt.json',
    'legacy-predecessor-attestation.json',
    'legacy-release.env',
    'observation.json',
    'operation.json',
    'owner-restore-decision.json',
    'plan.json',
    'previous-api.env',
    'previous-web.env',
    'previous-worker.env',
    'prior-full-restore-reference.json',
    'rollout-receipt.json',
    'snapshot-witness.json',
    'installed-components.env',
    'release-manifest.json',
    'canonical-artifact.zip',
  ];
  exact(files, names);
  if (
    names.some(
      (n) => !Buffer.isBuffer(files[n]) || files[n].length < 1 || files[n].length > 4 * 1024 * 1024,
    )
  )
    fail('canonical_history_size');
  if (
    !validateCanonicalPredecessorArchive(
      b,
      files['operation.json'],
      files['canonical-artifact.zip'],
    ).equals(files['release-manifest.json'])
  )
    fail('canonical_history_derived_manifest');
  const opBytes = files['operation.json'],
    planBytes = files['plan.json'],
    descriptor = files['installed-components.env'];
  const op = validateProductionCutover(parseStrictJson(opBytes)),
    plan = parseStrictJson(planBytes),
    values = parseEnv(descriptor);
  const receipt = validateUpgradeReceipt(
    parseStrictJson(files['rollout-receipt.json']),
    hash(planBytes),
    op,
    plan,
    planBytes,
  );
  if (
    op.schema !== 'PHUB_TIMEWEB_API_WORKER_WEB_OWNER_DIRECTED_CUTOVER_V4' ||
    op.candidateSha !== b.sourceSha ||
    op.candidateTree !== b.sourceTree ||
    op.sourceCiRunId !== b.sourceCiRunId ||
    op.publicationRunId !== b.publicationRunId ||
    op.artifactId !== b.artifactId ||
    op.manifestSha256 !== b.manifestSha256 ||
    receipt.status !== 'RECONCILED' ||
    receipt.reconciledStatus !== 'SUCCESS' ||
    receipt.installedBaselineSha256 !== hash(descriptor) ||
    ![OWNER_KIND, CANONICAL_KIND].includes(values.PHUB_COMPONENT_ROLLOUT_KIND) ||
    values.PHUB_RELEASE_ID !== b.installedReleaseId
  )
    fail('canonical_history_identity');
  const tx = `${ROOT}/backups/${b.installedReleaseId}-api-web`;
  validateCutoverLineage(receipt, plan, op, values, opBytes);
  validateCutoverPlanProofs(op, plan, tx);
  validateRosterCutoverObservation(parseStrictJson(files['observation.json']), receipt.observedAt);
  for (const [name, key] of [
    ['operation.json', 'operationSha256'],
    ['plan.json', 'planSha256'],
    ['rollout-receipt.json', 'receiptSha256'],
    ['observation.json', 'observationSha256'],
    ['backup-operation.json', 'backupOperationSha256'],
    ['database-backup-receipt.json', 'backupReceiptSha256'],
    ['installed-components.env', 'installedDescriptorSha256'],
    ['release-manifest.json', 'manifestSha256'],
  ])
    if (hash(files[name]) !== b[key]) fail('canonical_history_hash');
  if (
    receipt.observationSha256 !== hash(files['observation.json']) ||
    !files['backup.complete'].equals(Buffer.from(hash(planBytes) + '\n')) ||
    !files['legacy-predecessor-attestation.json'].equals(
      Buffer.from(JSON.stringify(op.legacyBaseline)),
    )
  )
    fail('canonical_history_lineage');
  for (const name of ['candidate', 'previous-api', 'previous-worker', 'previous-web'])
    assertOverlayBytes(plan, name, files[name + '.env']);
  // This identity is derived from the two immutable historical records, not a live secret read.
  if (
    values.PHUB_RUNTIME_SECRET_SET_RELEASE_ID !== op.legacyBaseline.secretSetReleaseId ||
    values.PHUB_RUNTIME_SECRET_SET_RELEASE_ID !== b.secretSetReleaseId
  )
    fail('canonical_history_secret_identity');
  const original = legacyEnvironment(op.legacyBaseline, files['legacy-release.env'], {
    schema: 'PHUB_TIMEWEB_SECRET_SET_V1',
    releaseId: values.PHUB_RUNTIME_SECRET_SET_RELEASE_ID,
  });
  if (
    !descriptor.equals(
      buildApiWebInstalledDescriptor(
        original,
        plan,
        b.installedReleaseId,
        `${tx}/rollout-receipt.json`,
      ),
    )
  )
    fail('canonical_history_descriptor');
  return {
    schema: 'PHUB_TIMEWEB_CANONICAL_HISTORY_OUTER_VALIDATION_V1',
    rolloutReceiptSha256: b.receiptSha256,
    runtimeConsulted: false,
  };
}
export function readCanonicalPredecessor(op, recovering = false) {
  const b = validateCanonicalBaseline(op.canonicalBaseline);
  if (!recovering) return attestCanonicalBaseline(b);
  const transaction = `${ROOT}/backups/${op.candidateSha}-${op.publicationRunId}-1-api-web`;
  if (
    !read(`${transaction}/canonical-predecessor-attestation.json`).equals(
      Buffer.from(JSON.stringify(b)),
    )
  )
    fail('canonical_attestation_drift');
  const path = `${transaction}/canonical-predecessor.env`,
    bytes = read(path),
    values = parseEnv(bytes);
  if (
    hash(bytes) !== b.installedDescriptorSha256 ||
    values.PHUB_RELEASE_ID !== b.installedReleaseId ||
    ![OWNER_KIND, CANONICAL_KIND].includes(values.PHUB_COMPONENT_ROLLOUT_KIND) ||
    values.PHUB_RUNTIME_SECRET_SET_RELEASE_ID !== b.secretSetReleaseId ||
    values.TIMEWEB_RUNTIME_ENV_ROOT !== RUNTIME ||
    values.PHUB_MIGRATOR_ENABLED !== 'false'
  )
    fail('canonical_retained_descriptor');
  for (const service of ['api', 'worker', 'web', 'realtime'])
    if (
      values[`${service.toUpperCase()}_IMAGE_DIGEST`] !== b.containers[service].image.split('@')[1]
    )
      fail('canonical_retained_descriptor');
  return { path, bytes, values, secretSetReleaseId: b.secretSetReleaseId };
}
async function verifyLegacyAuthority(op) {
  const legacy = op.legacyBaseline;
  await verifyCi(legacy.sourceCiRunId, legacy.sourceSha);
  const run = await githubPublic(`actions/runs/${legacy.testStandRunId}`);
  validateLegacyRun(run, legacy);
  const list = await githubPublic(`actions/runs/${legacy.testStandRunId}/artifacts?per_page=100`);
  if (list.total_count !== list.artifacts?.length) fail('truncated_legacy_artifacts');
  for (const component of COMPONENTS) {
    const record = legacy.buildRecords.find((v) => v.component === component);
    const matches = list.artifacts.filter((v) => String(v.id) === record.artifactId);
    if (matches.length !== 1) fail('legacy_artifact_missing');
    validateLegacyArtifact(matches[0], record, legacy);
    const archive = legacyBuildArchivePath(legacy, component);
    validateLegacyBuildRecord(
      legacy,
      component,
      read(archive),
      command('/usr/bin/tar', ['-xOzf', archive, 'index.json'], { encoding: null }),
      (digest) =>
        command('/usr/bin/tar', ['-xOzf', archive, `blobs/sha256/${digest.slice(7)}`], {
          encoding: null,
        }),
    );
  }
}

export function readInstalledApiBaseline(releaseId, { checkRuntimeSecrets = true } = {}) {
  if (!ID.test(releaseId)) fail('baseline_release_id');
  const directory = `${ROOT}/releases/${releaseId}`;
  const installed = `${directory}/installed-components.env`;
  const path = existsSync(installed) ? installed : `${directory}/release.env`;
  const bytes = read(path);
  const values = parseEnv(bytes);
  if (values.PHUB_RELEASE_ID !== releaseId) fail('baseline_release_id');
  if (existsSync(installed)) {
    if (
      [
        'API_WORKER',
        'API_WORKER_NOTIFICATION_0105',
        'API_WORKER_NOTIFICATION_0105_PRESERVED_ANDROID',
        R1_API_WORKER119_INSTALLED,
      ].includes(values.PHUB_COMPONENT_ROLLOUT_KIND)
    ) {
      const transaction = `${ROOT}/backups/${releaseId}-api-worker`;
      if (
        values.PHUB_TIMEWEB_RELEASE_ENV_SCHEMA !== 'PHUB_TIMEWEB_INSTALLED_COMPONENT_ENV_V1' ||
        values.PHUB_COMPONENT_ROLLOUT_RECEIPT !== `${transaction}/rollout-receipt.json`
      )
        fail('installed_baseline_identity');
      validateInstalledApiWorkerEvidence({
        releaseId,
        values,
        bytes,
        receipt: JSON.parse(read(`${transaction}/rollout-receipt.json`)),
        planBytes: read(`${transaction}/plan.json`),
        operationBytes: read(`${transaction}/operation.json`),
        evidence: Object.fromEntries(
          ([
            'API_WORKER_NOTIFICATION_0105',
            'API_WORKER_NOTIFICATION_0105_PRESERVED_ANDROID',
            R1_API_WORKER119_INSTALLED,
          ].includes(values.PHUB_COMPONENT_ROLLOUT_KIND)
            ? [
                'observation.json',
                ...(values.PHUB_COMPONENT_ROLLOUT_KIND === R1_API_WORKER119_INSTALLED
                  ? ['runtime-grant-intent.json', 'runtime-grant-terminal.json']
                  : []),
                ...([
                  'API_WORKER_NOTIFICATION_0105_PRESERVED_ANDROID',
                  R1_API_WORKER119_INSTALLED,
                ].includes(values.PHUB_COMPONENT_ROLLOUT_KIND)
                  ? [
                      'fcm-drain.json',
                      'fcm-delivery-gate/held.json',
                      'fcm-delivery-gate/released.json',
                    ]
                  : []),
              ]
            : ['observation.json', 'timeweb-monitor-readback.json', 'alert-test-readback.json']
          ).map((name) => [
            name,
            read(`${transaction}/${name}`, name.startsWith('fcm-delivery-gate/') ? 0o644 : 0o600),
          ]),
        ),
      });
    } else if (values.PHUB_COMPONENT_ROLLOUT_KIND === JOIN_INSTALLED_KIND) {
      const transaction = `${ROOT}/backups/${releaseId}-api-web`;
      if (
        values.PHUB_TIMEWEB_RELEASE_ENV_SCHEMA !== 'PHUB_TIMEWEB_INSTALLED_COMPONENT_ENV_V1' ||
        values.PHUB_COMPONENT_ROLLOUT_RECEIPT !== `${transaction}/rollout-receipt.json`
      )
        fail('installed_baseline_identity');
      const planBytes = read(`${transaction}/plan.json`),
        plan = parseStrictJson(planBytes);
      const opBytes = read(`${transaction}/operation.json`),
        op = validateJoinOperation(parseStrictJson(opBytes));
      const receipt = validateJoinReceipt(
        parseStrictJson(read(values.PHUB_COMPONENT_ROLLOUT_RECEIPT)),
        hash(planBytes),
        op,
        plan,
        planBytes,
      );
      if (
        plan.baselinePath !==
          `${ROOT}/releases/${op.expectedApi.releaseId}/installed-components.env` ||
        hash(read(plan.baselinePath)) !== plan.baselineSha256 ||
        (checkRuntimeSecrets &&
          !equal(describeTimewebRuntimeSecretSet(RUNTIME), plan.candidateSecrets))
      )
        fail('installed_join_lineage');
      validateJoinObservation(
        parseStrictJson(read(`${transaction}/observation.json`)),
        op,
        plan,
        hash(planBytes),
      );
      if (
        receipt.status !== 'RECONCILED' ||
        receipt.reconciledStatus !== 'SUCCESS' ||
        plan.operationSha256 !== hash(opBytes) ||
        receipt.installedBaselineSha256 !== hash(bytes) ||
        !bytes.equals(
          buildJoinInstalledDescriptor(
            parseEnv(read(plan.baselinePath)),
            plan,
            releaseId,
            values.PHUB_COMPONENT_ROLLOUT_RECEIPT,
          ),
        )
      )
        fail('installed_baseline_receipt');
      for (const [file, key] of [
        ['observation.json', 'observationSha256'],
        ['timeweb-monitor-readback.json', 'providerReadbackSha256'],
        ['alert-test-readback.json', 'alertReadbackSha256'],
      ])
        if (hash(read(`${transaction}/${file}`)) !== receipt[key]) fail('installed_evidence_drift');
    } else if (values.PHUB_COMPONENT_ROLLOUT_KIND === ADOPTED_MANUAL_FULL_KIND) {
      // A manual compose promotion adopted once as the installed baseline. It has no canonical
      // rollout receipt; its own adoption receipt and request are verified instead.
      validateAdoptedBaseline(values, bytes, directory, releaseId);
    } else {
      if (
        values.PHUB_COMPONENT_ROLLOUT_KIND !== undefined &&
        ![
          'API_WEB',
          SCHEDULE_INSTALLED_KIND,
          ROSTER_CUTOVER_KIND,
          STATION_KIND,
          WAIVER_KIND,
          OWNER_KIND,
          CANONICAL_KIND,
        ].includes(values.PHUB_COMPONENT_ROLLOUT_KIND)
      )
        fail('installed_baseline_kind');
      if (
        values.PHUB_TIMEWEB_RELEASE_ENV_SCHEMA !== 'PHUB_TIMEWEB_INSTALLED_COMPONENT_ENV_V1' ||
        values.PHUB_COMPONENT_ROLLOUT_RECEIPT !==
          `${ROOT}/backups/${releaseId}-api-web/rollout-receipt.json`
      )
        fail('installed_baseline_identity');
      const receipt = JSON.parse(read(values.PHUB_COMPONENT_ROLLOUT_RECEIPT));
      validateInstalledCutoverKind(values.PHUB_COMPONENT_ROLLOUT_KIND, receipt.schema);
      const planBytes = read(`${ROOT}/backups/${releaseId}-api-web/plan.json`);
      const plan = JSON.parse(planBytes);
      validateUpgradeReceipt(receipt, hash(planBytes));
      const transaction = `${ROOT}/backups/${releaseId}-api-web`;
      const direct = receipt.schema === 'PHUB_TIMEWEB_API_WEB_RECEIPT_V2';
      if ([APP_ONLY_RECEIPT, CUP_SUPPORT_RECEIPT].includes(receipt.schema)) {
        const opBytes = read(`${transaction}/operation.json`);
        const op = validateApiWebOperation(parseStrictJson(opBytes));
        validateUpgradeReceipt(receipt, hash(planBytes), op, plan, planBytes);
        if (
          !isAppOnlyOperation(op) ||
          plan.operationSha256 !== hash(opBytes) ||
          `${op.candidateSha}-${op.publicationRunId}-1` !== releaseId ||
          receipt.status !== 'RECONCILED' ||
          receipt.reconciledStatus !== 'SUCCESS'
        )
          fail('installed_app_only_lineage');
        validateBoundBackupPlan(plan.backup, op, transaction);
        attestBoundBackupFiles(plan.backup);
        if (isCupSupportOperation(op))
          validateCupSupportDirectObservation(
            parseStrictJson(read(`${transaction}/observation.json`)),
            op,
            plan,
            hash(planBytes),
          );
        if (
          isCupSupportOperation(op) &&
          (plan.candidateSecrets.releaseId !== releaseId ||
            values.PHUB_RUNTIME_SECRET_SET_RELEASE_ID !== releaseId ||
            !equal(plan.candidateSecrets.files, op.candidateSecretHashes) ||
            (checkRuntimeSecrets &&
              !equal(describeTimewebRuntimeSecretSet(RUNTIME), plan.candidateSecrets)))
        )
          fail('installed_cup_support_secret_lineage');
      }
      if (receipt.schema === STATION_RECEIPT) {
        const opBytes = read(`${transaction}/operation.json`);
        const op = validateApiWebOperation(parseStrictJson(opBytes));
        validateUpgradeReceipt(receipt, hash(planBytes), op, plan, planBytes);
        const worker = inspect('worker');
        if (
          plan.operationSha256 !== hash(opBytes) ||
          `${op.candidateSha}-${op.publicationRunId}-1` !== releaseId ||
          receipt.status !== 'RECONCILED' ||
          receipt.reconciledStatus !== 'SUCCESS' ||
          plan.secretSetReleaseId !== values.PHUB_RUNTIME_SECRET_SET_RELEASE_ID ||
          ['api', 'worker', 'web'].some(
            (service) =>
              plan.candidate[service].image !==
              `ghcr.io/z6v6e6r/phub-${service}@${values[service.toUpperCase() + '_IMAGE_DIGEST']}`,
          ) ||
          worker.image !== plan.candidate.worker.image ||
          worker.revision !== op.candidateSha ||
          worker.releaseId !== null ||
          worker.restarts !== 0
        )
          fail('installed_station_lineage');
        validateStationObservation(
          parseStrictJson(read(`${transaction}/observation.json`)),
          validateRosterCutoverObservation,
          receipt.observedAt,
          stationObservationIdentity(op, plan, receipt.planSha256),
        );
        attestStationAuthorization(transaction, op);
        attestStationArchive(null, true);
      }
      if (receipt.schema === SCHEDULE_RECEIPT) {
        const operationBytes = read(`${transaction}/operation.json`);
        const operation = validateApiWebOperation(parseStrictJson(operationBytes));
        validateUpgradeReceipt(receipt, hash(planBytes), operation, plan, planBytes);
        if (
          receipt.status !== 'RECONCILED' ||
          receipt.reconciledStatus !== 'SUCCESS' ||
          plan.operationSha256 !== hash(operationBytes) ||
          plan.candidateSecrets.releaseId !== releaseId ||
          values.PHUB_RUNTIME_SECRET_SET_RELEASE_ID !== releaseId ||
          !equal(plan.candidateSecrets.files, operation.candidateSecretHashes) ||
          (checkRuntimeSecrets &&
            !equal(describeTimewebRuntimeSecretSet(RUNTIME), plan.candidateSecrets))
        )
          fail('installed_schedule_lineage');
        if (operation.ownerProviderMonitoringWaiver)
          validateScheduleDirectObservation(
            parseStrictJson(read(`${transaction}/observation.json`)),
            operation,
            plan,
            hash(planBytes),
          );
      }
      if (
        [
          CUTOVER_RECEIPT,
          ROSTER_CUTOVER_RECEIPT,
          WAIVER_RECEIPT,
          OWNER_RECEIPT,
          CANONICAL_RECEIPT,
        ].includes(receipt.schema)
      ) {
        const operationBytes = read(`${transaction}/operation.json`);
        const operation = validateProductionCutover(parseStrictJson(operationBytes));
        validateUpgradeReceipt(receipt, hash(planBytes), operation, plan, planBytes);
        validateCutoverLineage(receipt, plan, operation, values, operationBytes);
        if (values.PHUB_COMPONENT_ROLLOUT_KIND !== cutoverInstalledKind(operation))
          fail('installed_cutover_kind');
        if (isRosterCutover(operation)) {
          validateRosterCutoverObservation(
            parseStrictJson(read(`${transaction}/observation.json`)),
            receipt.observedAt,
          );
          if (
            values.WORKER_IMAGE_DIGEST !== plan.candidate.worker.image.split('@')[1] ||
            plan.candidate.worker.releaseId !== null ||
            plan.candidate.worker.revision !== operation.candidateSha
          )
            fail('installed_cutover_worker');
          const actual = inspect('worker');
          if (
            actual.image !== plan.candidate.worker.image ||
            actual.revision !== operation.candidateSha ||
            actual.releaseId !== null ||
            actual.restarts !== 0
          )
            fail('installed_cutover_worker_runtime');
        }
        validateCutoverPlanProofs(operation, plan, transaction);
        if (isOwnerDirectedCutover(operation))
          assertCutoverBackupFiles(operation, plan, transaction, read, hashBackupFile);
        if (isWaivedRosterCutover(operation)) {
          if (!(
            receipt.status === 'SUCCESS' ||
            (receipt.status === 'RECONCILED' && receipt.reconciledStatus === 'SUCCESS')
          ))
            fail('installed_native_terminal');
          if (
            Date.parse(parseStrictJson(read(`${transaction}/observation.json`)).startedAt) <
            Date.parse(plan.monitoring.admittedAt)
          )
            fail('installed_native_observation_time');
          validateRetainedNativeAdmission(
            operation,
            plan.monitoring,
            hash(operationBytes),
            readRetainedNativeEvidence(transaction),
          );
        }
        if (
          hash(read(plan.backup.operationPath)) !== operation.backupOperationSha256 ||
          hash(read(plan.backup.receiptPath)) !== plan.backup.receiptSha256
        )
          fail('installed_cutover_backup_drift');
        const predecessorPointer = isCanonicalOwnerDirectedUpgrade(operation)
          ? values.PHUB_CANONICAL_PREDECESSOR_ATTESTATION
          : values.PHUB_LEGACY_PREDECESSOR_RECEIPT;
        if (
          predecessorPointer !==
            `${transaction}/${isCanonicalOwnerDirectedUpgrade(operation) ? 'canonical' : 'legacy'}-predecessor-attestation.json` ||
          hash(read(predecessorPointer)) !== plan[cutoverBaselineField(operation)]
        )
          fail('installed_legacy_attestation_drift');
      }
      for (const [file, key] of (receipt.schema === SCHEDULE_RECEIPT &&
        receipt.ownerProviderMonitoringWaiverSha256) ||
      [WAIVER_RECEIPT, OWNER_RECEIPT, CANONICAL_RECEIPT].includes(receipt.schema) ||
      (receipt.schema === STATION_RECEIPT &&
        receipt.providerMonitoringStatus === STATION_PROVIDER_STATUS)
        ? [['observation.json', 'observationSha256']]
        : direct
          ? [
              ['observation.json', 'observationSha256'],
              ['release-owner-observation.json', 'ownerObservationSha256'],
            ]
          : [
              ['observation.json', 'observationSha256'],
              ['timeweb-monitor-readback.json', 'providerReadbackSha256'],
              ...([STATION_RECEIPT, CUP_SUPPORT_RECEIPT].includes(receipt.schema)
                ? []
                : [['alert-test-readback.json', 'alertReadbackSha256']]),
            ])
        if (hash(read(`${transaction}/${file}`)) !== receipt[key]) fail('installed_evidence_drift');
      if (direct)
        validateDirectInstalledEvidence(
          receipt,
          planBytes,
          read(`${transaction}/operation.json`),
          read(`${transaction}/release-owner-observation.json`),
          read(`${transaction}/observation.json`),
          releaseId,
          {
            api: `ghcr.io/z6v6e6r/phub-api@${values.API_IMAGE_DIGEST}`,
            web: `ghcr.io/z6v6e6r/phub-web@${values.WEB_IMAGE_DIGEST}`,
          },
        );
      if (
        ![
          'PHUB_TIMEWEB_API_WEB_RECEIPT_V1',
          'PHUB_TIMEWEB_API_WEB_RECEIPT_V2',
          SCHEDULE_RECEIPT,
          APP_ONLY_RECEIPT,
          CUP_SUPPORT_RECEIPT,
          STATION_RECEIPT,
          CUTOVER_RECEIPT,
          ROSTER_CUTOVER_RECEIPT,
          WAIVER_RECEIPT,
          OWNER_RECEIPT,
          CANONICAL_RECEIPT,
        ].includes(receipt.schema) ||
        !(
          receipt.status === 'SUCCESS' ||
          (receipt.status === 'RECONCILED' && receipt.reconciledStatus === 'SUCCESS')
        ) ||
        receipt.installedBaselineSha256 !== hash(bytes)
      )
        fail('installed_baseline_receipt');
    }
    if (checkRuntimeSecrets)
      validateTimewebRuntimeSecretPaths(RUNTIME, values.PHUB_RUNTIME_SECRET_SET_RELEASE_ID);
  }
  const workerGate = values.PHUB_WORKER_DELIVERY_GATE_RECEIPT
    ? readInstalledWorkerGate(
        values.PHUB_WORKER_DELIVERY_GATE_RECEIPT,
        `ghcr.io/z6v6e6r/phub-worker@${values.WORKER_IMAGE_DIGEST}`,
      )
    : undefined;
  return {
    path,
    bytes,
    values,
    ...(workerGate ? { workerGate } : {}),
    secretSetReleaseId: values.PHUB_RUNTIME_SECRET_SET_RELEASE_ID ?? releaseId,
  };
}
export async function runManualApiWebUpgrade(mode, requestPath) {
  if (
    !['deploy', 'recover', 'reconcile'].includes(mode) ||
    requestPath !== REQUEST ||
    process.getuid?.() !== 0
  )
    fail('manual_entry');
  secure(SOURCE);
  secure(`${SOURCE}/.git`);
  const config = JSON.parse(read(CONFIG));
  let recoveredTransaction;
  let terminalWithoutLock = false;
  if (mode === 'reconcile' && !existsSync(LOCK)) {
    const terminalInput = parseStrictJson(read(REQUEST));
    const terminalOp =
      isCanonicalOwnerDirectedUpgrade(terminalInput) ||
      isScheduleOperation(terminalInput) ||
      isAppOnlyOperation(terminalInput) ||
      isStationRollout(terminalInput)
        ? validateApiWebOperation(terminalInput)
        : validateJoinOperation(terminalInput);
    recoveredTransaction = `${ROOT}/backups/${terminalOp.candidateSha}-${terminalOp.publicationRunId}-1-api-web`;
    if (!read(`${recoveredTransaction}/operation.json`).equals(read(REQUEST)))
      fail('terminal_operation_drift');
    terminalWithoutLock = true;
  }
  if (mode !== 'deploy' && !terminalWithoutLock) {
    const pointer = read(LOCK).toString();
    if (
      !/^\/opt\/phub\/timeweb-beta\/backups\/[a-f0-9]{40}-[1-9][0-9]*-1-api-web\/plan\.json\n$/.test(
        pointer,
      )
    )
      fail('lock_pointer');
    recoveredTransaction = dirname(pointer.trim());
  }
  const opBytes = read(recoveredTransaction ? `${recoveredTransaction}/operation.json` : REQUEST);
  const parsedOperation = JSON.parse(opBytes);
  const op = validateApiWebOperation(
    isJoinOperation(parsedOperation) ||
      isProductionCutover(parsedOperation) ||
      isScheduleOperation(parsedOperation) ||
      isAppOnlyOperation(parsedOperation) ||
      isStationRollout(parsedOperation)
      ? parseStrictJson(opBytes)
      : parsedOperation,
  );
  const options = { mode, op, opBytes, config, terminalWithoutLock };
  if (!isStationRollout(op)) return runApiWebOperation(options);
  const { acquireApiWorkerExecutor } = await import('./timeweb-api-worker-upgrade.js');
  secure(`${ROOT}/standard`);
  const owner = acquireApiWorkerExecutor(`${ROOT}/standard/api-worker-executor.lock`);
  try {
    return await runApiWebOperation({ ...options, assertOwned: owner.assertOwned });
  } finally {
    owner.close();
  }
}
async function runApiWebOperation({ mode, op, opBytes, config, terminalWithoutLock, assertOwned }) {
  const join = isJoinOperation(op);
  const schedule = isScheduleOperation(op);
  const cupSupport = isCupSupportOperation(op);
  const cupAlert = cupSupport ? cupSupportAlertReceipt(op) : undefined;
  const appOnly = isAppOnlyOperation(op);
  const scheduleWaiver =
    schedule && op.ownerProviderMonitoringWaiver ? scheduleMonitoringReceipt(op) : null;
  const swapsSecrets = join || schedule || cupSupport;
  const cutover = isProductionCutover(op);
  const station = isStationRollout(op);
  const stationDirect = isStationDirectOperation(op);
  const stationProviderDecision = stationDirect
    ? { providerMonitoringStatus: STATION_PROVIDER_STATUS }
    : {};
  const roster = isRosterCutover(op) || station;
  const admissionMarker = station ? 'admission.complete' : 'backup.complete';
  const consumed = `${ROOT}/standard/station-702-admission-consumed.json`;
  const opSha256 = hash(opBytes);
  const stationReservation =
    () => `${JSON.stringify({ schema: STATION_OPERATION, operationSha256: opSha256 })}
`;
  if (mode === 'deploy' && station) validateStationWindow(op, Date.now(), 25 * 60_000);
  const direct = isDirectOperation(op);
  const planSchema = cutover
    ? cutoverPlanSchema(op)
    : join
      ? JOIN_PLAN
      : schedule
        ? SCHEDULE_PLAN
        : direct
          ? 'PHUB_TIMEWEB_API_WEB_PLAN_V2'
          : appOnly
            ? cupSupport
              ? CUP_SUPPORT_PLAN
              : APP_ONLY_PLAN
            : station
              ? STATION_PLAN
              : 'PHUB_TIMEWEB_API_WEB_PLAN_V1';
  const receiptSchema = cutover
    ? cutoverReceiptSchema(op)
    : join
      ? JOIN_RECEIPT
      : schedule
        ? SCHEDULE_RECEIPT
        : direct
          ? 'PHUB_TIMEWEB_API_WEB_RECEIPT_V2'
          : appOnly
            ? cupSupport
              ? CUP_SUPPORT_RECEIPT
              : APP_ONLY_RECEIPT
            : station
              ? STATION_RECEIPT
              : 'PHUB_TIMEWEB_API_WEB_RECEIPT_V1';
  const targets = roster ? ['api', 'worker', 'web'] : ['api', 'web'];
  const overlays = ['candidate', ...targets.map((service) => `previous-${service}`)];
  const excludedTargets = () => excluded(targets);
  if (mode === 'deploy' && cutover) validateProductionCutover(op, true);
  const profile = join ? 'production' : (op.profile ?? 'beta');
  if (mode === 'deploy' && (schedule || appOnly)) validateScheduleExpiry(op.expiresAt, 20 * 60_000);
  if (
    mode === 'deploy' &&
    cupSupport &&
    (Date.parse(op.ownerAlertDecision.receivedAt) > Date.now() ||
      hash(read(`${ROOT}/operator/cup-support-alert-waiver.txt`)) !== CUP_SUPPORT_ALERT_MESSAGE)
  )
    fail('cup_support_alert_authorization');
  if (
    mode === 'deploy' &&
    scheduleWaiver &&
    Date.parse(op.ownerProviderMonitoringWaiver.receivedAt) > Date.now()
  )
    fail('schedule_monitoring_waiver_time');
  if (mode === 'deploy' && join) validateJoinOperation(op, true);
  if (mode === 'deploy' && isDirectOperation(op)) validateDirectApiWebOperation(op, true);
  if (
    config.schema !== 1 ||
    config.enabled !== true ||
    config.controllerSha !== op.controllerSha ||
    git(['rev-parse', 'HEAD']) !== op.controllerSha ||
    git(['status', '--porcelain', '--untracked-files=no']) !== ''
  )
    fail('controller_identity');
  for (const path of git(['ls-files', '-z']).split('\0').filter(Boolean))
    secure(`${SOURCE}/${path}`);
  try {
    git(['merge-base', '--is-ancestor', op.candidateSha, op.controllerSha]);
  } catch {
    fail('candidate_controller_ancestry');
  }
  if (git(['rev-parse', `${op.candidateSha}^{tree}`]) !== op.candidateTree) fail('candidate_tree');
  const delta = (from, to) => {
    const parts = git(['diff', '--no-renames', '--name-status', '-z', from, to])
      .split('\0')
      .filter(Boolean);
    if (parts.length % 2) fail('invalid_controller_delta');
    return Array.from({ length: parts.length / 2 }, (_, i) => ({
      status: parts[i * 2],
      path: parts[i * 2 + 1],
    }));
  };
  const runtimeDelta = inspectRuntimeDelta;
  if (station) {
    git(['merge-base', '--is-ancestor', STATION_APPLICATION, op.candidateSha]);
    if (git(['rev-parse', `${STATION_APPLICATION}^{tree}`]) !== STATION_TREE)
      fail('station_rollout_application');
    validateStationSourceTail(runtimeDelta(STATION_APPLICATION, op.candidateSha));
    if (stationDirect)
      validateStationDirectControllerTail(runtimeDelta(op.candidateSha, op.controllerSha));
  }
  if (join && op.candidateSha !== op.controllerSha) {
    validateJoinRuntimeTail(
      parseRuntimeDelta(
        git([
          'diff',
          '--raw',
          '--no-abbrev',
          '--no-renames',
          '-z',
          op.candidateSha,
          op.controllerSha,
        ]),
      ).map((v) => ({
        ...v,
        oldType: v.oldOid === '0'.repeat(40) ? null : git(['cat-file', '-t', v.oldOid]),
        newType: v.newOid === '0'.repeat(40) ? null : git(['cat-file', '-t', v.newOid]),
      })),
    );
  }
  if (!join && !stationDirect && op.candidateSha !== op.controllerSha) {
    const entries = delta(op.candidateSha, op.controllerSha);
    if (entries.every((v) => CONTROLLER_FILES.has(v.path))) validateControllerDelta(entries);
    else {
      git(['merge-base', '--is-ancestor', INERT_CONTROLLER_BRIDGE.sha, op.controllerSha]);
      const bridgeEntries = delta(op.candidateSha, INERT_CONTROLLER_BRIDGE.sha).map((v) => {
        const line = git(['ls-tree', INERT_CONTROLLER_BRIDGE.sha, '--', v.path]);
        const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})\t/.exec(line);
        if (!match) fail('inert_controller_bridge');
        return { ...v, mode: match[1], type: match[2], oid: match[3] };
      });
      validateControllerBridge(op.candidateSha, INERT_CONTROLLER_BRIDGE.sha, bridgeEntries);
      validateControllerDelta(delta(INERT_CONTROLLER_BRIDGE.sha, op.controllerSha));
    }
  }
  const id = `${op.candidateSha}-${op.publicationRunId}-1`;
  const directory = `${ROOT}/releases/${id}`;
  const transaction = `${ROOT}/backups/${id}-api-web`;
  secure(directory, 0o700);
  secure(transaction, 0o700);
  const journalPath = `${transaction}/rollout-receipt.json`;
  const planPath = `${transaction}/plan.json`;
  const previousApi = op.expectedApi,
    previousWeb = op.expectedWeb;
  const previousBaseline = cutover
    ? isCanonicalOwnerDirectedUpgrade(op)
      ? readCanonicalPredecessor(op, mode !== 'deploy')
      : readLegacyPredecessor(op, mode !== 'deploy')
    : readInstalledApiBaseline(previousApi.releaseId, {
        checkRuntimeSecrets: !swapsSecrets || mode === 'deploy',
      });
  const predecessorSource = (previous) =>
    cutover
      ? cutoverBaseline(op).sourceSha
      : station
        ? previous.revision
        : previous.releaseId.slice(0, 40);
  const {
    path: predecessorPath,
    bytes: baselineBytes,
    values,
    secretSetReleaseId,
  } = previousBaseline;
  const baseline = cutover
    ? `${transaction}/${isCanonicalOwnerDirectedUpgrade(op) ? 'canonical-predecessor.env' : 'legacy-release.env'}`
    : predecessorPath;
  if (
    values.PHUB_RELEASE_ID !== previousApi.releaseId ||
    values.TIMEWEB_RUNTIME_ENV_ROOT !== RUNTIME ||
    previousApi.image !== `ghcr.io/z6v6e6r/phub-api@${values.API_IMAGE_DIGEST}` ||
    values.PHUB_MIGRATOR_ENABLED !== 'false'
  )
    fail('baseline_identity');
  if (station && values.PHUB_WORKER_DELIVERY_GATE_RECEIPT)
    fail('station_rollout_existing_worker_gate');
  if (!swapsSecrets || mode === 'deploy')
    validateTimewebRuntimeSecretPaths(RUNTIME, secretSetReleaseId);
  const candidateDir = `/etc/phub/timeweb-beta-candidates/${id}/timeweb-beta`;
  const backupDir = `/etc/phub/timeweb-beta-backups/${secretSetReleaseId}--replaced-by--${id}`;
  const provisionLock = '/etc/phub/.timeweb-beta.provision.lock';
  let plan;
  let stationArchive;
  if (mode !== 'deploy') {
    if (!terminalWithoutLock) secure(LOCK, 0o600);
    if (
      !existsSync(planPath) ||
      !existsSync(journalPath) ||
      !existsSync(`${transaction}/${admissionMarker}`)
    ) {
      if (swapsSecrets) fail('secret_swap_incomplete_preparation_preserved');
      if (mode !== 'recover' || !read(LOCK).equals(Buffer.from(`${planPath}\n`)))
        fail('incomplete_preparation');
      if (existsSync(journalPath)) {
        const phase = JSON.parse(read(journalPath)).status;
        if (!['PREPARING', 'PREPARED'].includes(phase)) fail('incomplete_active_transaction');
      }
      if (existsSync(planPath) && JSON.parse(read(planPath)).operationSha256 !== hash(opBytes))
        fail('incomplete_plan_identity');
      for (const [service, expected] of [
        ['api', previousApi],
        ['web', previousWeb],
        ...(roster ? [['worker', op.expectedWorker]] : []),
      ]) {
        const actual = inspect(service);
        if (
          actual.id !== expected.id ||
          actual.image !== expected.image ||
          actual.releaseId !== expected.releaseId ||
          actual.restarts !== 0
        )
          fail('incomplete_abort_baseline_changed');
      }
      excluded(); // Includes the no-migrator guard; no Docker mutation has been issued.
      for (const file of [
        'plan.json',
        'candidate.env',
        'previous-api.env',
        'previous-web.env',
        ...(roster ? ['previous-worker.env'] : []),
        'release-owner-observation.json',
        admissionMarker,
        'rollout-receipt.json',
      ]) {
        const path = `${transaction}/${file}`;
        if (existsSync(path)) {
          read(path);
          unlinkSync(path);
        }
      }
      durable(
        `${transaction}/preparation-aborted.json`,
        `${JSON.stringify({ schema: 'PHUB_TIMEWEB_API_WEB_PREPARATION_ABORT_V1', operationSha256: hash(opBytes), observedAt: new Date().toISOString(), runtimeMutated: false })}\n`,
      );
      unlinkSync(LOCK);
      const fd = openSync(dirname(LOCK), 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return {
        status: 'ABORTED',
        candidate: id,
        receipt: `${transaction}/preparation-aborted.json`,
      };
    }
    if (station && !read(consumed).equals(Buffer.from(stationReservation())))
      fail('station_rollout_reservation_drift');
    plan = JSON.parse(read(planPath));
    const receipt = validateUpgradeReceipt(
      JSON.parse(read(journalPath)),
      hash(read(planPath)),
      op,
      plan,
      read(planPath),
    );
    if (
      plan.operationSha256 !== hash(opBytes) ||
      receipt.planSha256 !== hash(read(planPath)) ||
      receipt.schema !== receiptSchema ||
      ![
        'PREPARING',
        'PREPARED',
        'API_INTENT',
        'API_ACTIVE',
        'WEB_INTENT',
        'OBSERVING',
        'SUCCESS',
        'ROLLBACK_INTENT',
        'ROLLED_BACK',
        'ROLLBACK_FAILED',
        'ABORTED',
        'RECONCILED',
        ...(swapsSecrets ? SCHEDULE_PHASES : []),
        ...(appOnly ? ['BASELINE_INTENT'] : []),
        ...(roster
          ? [
              'WORKER_STOP_INTENT',
              'WORKER_STOPPED',
              'WORKER_INTENT',
              'WORKER_ACTIVE',
              'BASELINE_INTENT',
            ]
          : []),
      ].includes(receipt.status) ||
      (!terminalWithoutLock && !read(LOCK).equals(Buffer.from(`${planPath}\n`))) ||
      (terminalWithoutLock &&
        ((!swapsSecrets && !appOnly && !station && !isCanonicalOwnerDirectedUpgrade(op)) ||
          receipt.status !== 'RECONCILED' ||
          existsSync(provisionLock)))
    )
      fail('recovery_identity');
  } else {
    if (station && (existsSync(consumed) || existsSync(`${transaction}/preparation-aborted.json`)))
      fail('station_rollout_already_consumed');
    if (
      (isWaivedRosterCutover(op) || isOwnerDirectedCutover(op)) &&
      existsSync(`${transaction}/preparation-aborted.json`)
    )
      fail('native_aborted_operation_not_replayable');
    if (existsSync(LOCK) || existsSync(planPath) || existsSync(journalPath))
      fail('unreconciled_transaction');
    if (station) attestStationAuthorization(transaction, op);
    await verifyCi(op.sourceCiRunId, op.candidateSha);
    if (stationDirect) {
      await verifyCi(op.controllerSourceCiRunId, op.controllerSha);
      const parents = git(['show', '-s', '--format=%P', op.controllerSha]).split(' ');
      if (parents.length !== 2 || parents[0] !== op.candidateSha)
        fail('station_rollout_direct_controller_review');
      const [pullRequest, prRun, prJobs] = await Promise.all([
        githubPublic(`pulls/${op.controllerPullRequestNumber}`),
        githubPublic(`actions/runs/${op.controllerPrCiRunId}`),
        githubPublic(`actions/runs/${op.controllerPrCiRunId}/attempts/1/jobs?per_page=100`),
      ]);
      validateStationDirectControllerReview(op, {
        pullRequest,
        prRun,
        prJobs,
        parents,
        headTree: git(['rev-parse', `${parents[1]}^{tree}`]),
        controllerTree: git(['rev-parse', `${op.controllerSha}^{tree}`]),
      });
    }
    if (isLegacyProductionCutover(op)) {
      await verifyLegacyAuthority(op);
      validateLegacyRuntime(
        op.legacyBaseline,
        Object.fromEntries(
          ['api', 'web', 'worker', 'realtime'].map((service) => [service, inspect(service)]),
        ),
        excluded(),
        secretHashes(),
      );
    }
    for (const previous of [previousApi, previousWeb]) {
      const previousSource = station
        ? previous.releaseId.slice(0, 40)
        : predecessorSource(previous);
      git(['merge-base', '--is-ancestor', previousSource, op.candidateSha]);
      if (station) continue; // Exact live predecessor and anchored application tree replace the generic delta.
      const entries = runtimeDelta(previousSource, op.candidateSha);
      if (schedule) {
        git(['merge-base', '--is-ancestor', SCHEDULE_APPLICATION, op.candidateSha]);
        validateScheduleRuntimeBridge(
          {
            previousSha: predecessorSource(previous),
            applicationSha: SCHEDULE_APPLICATION,
            applicationTree: git(['rev-parse', `${SCHEDULE_APPLICATION}^{tree}`]),
          },
          entries,
          runtimeDelta(SCHEDULE_APPLICATION, op.candidateSha),
        );
      } else if (cupSupport) {
        attestCupSupportSource(previousSource, op.candidateSha);
      } else if (appOnly) {
        validateAppOnlyRuntimeDelta(entries);
      } else if (!join) {
        let wholeCourtTail;
        if (
          isCanonicalOwnerDirectedUpgrade(op) &&
          predecessorSource(previous) === WHOLE_COURT_PREDECESSOR &&
          op.candidateSha === op.controllerSha &&
          entries.some(({ path }) => path === 'contracts/openapi/user/v1/games.yaml')
        ) {
          git(['merge-base', '--is-ancestor', WHOLE_COURT_APPLICATION, op.candidateSha]);
          if (
            git(['rev-parse', `${WHOLE_COURT_APPLICATION}^{tree}`]) !== WHOLE_COURT_APPLICATION_TREE
          )
            fail('whole_court_runtime_bridge');
          wholeCourtTail = delta(WHOLE_COURT_APPLICATION, op.candidateSha);
        }
        validateRuntimeUpgrade(
          {
            previousSha: predecessorSource(previous),
            candidateSha: op.candidateSha,
            candidateTree: op.candidateTree,
          },
          entries,
          wholeCourtTail,
        );
      }
    }
    if (join) {
      for (const sha of [op.candidateSha, previousApi.releaseId.slice(0, 40)]) {
        git(['merge-base', '--is-ancestor', JOIN_RUNTIME_ANCHOR, sha]);
        validateJoinRuntimeTail(
          parseRuntimeDelta(
            git(['diff', '--raw', '--no-abbrev', '--no-renames', '-z', JOIN_RUNTIME_ANCHOR, sha]),
          ).map((v) => ({
            ...v,
            oldType: v.oldOid === '0'.repeat(40) ? null : git(['cat-file', '-t', v.oldOid]),
            newType: v.newOid === '0'.repeat(40) ? null : git(['cat-file', '-t', v.newOid]),
          })),
          {
            fromSha: JOIN_RUNTIME_ANCHOR,
            toSha: sha,
            toTree: git(['rev-parse', `${sha}^{tree}`]),
          },
        );
      }
      readJoinNotificationBaseline(op);
      if (secretSetReleaseId !== op.expectedCurrentSecretSetReleaseId || existsSync(provisionLock))
        fail('join_secret_preimage');
      validateTimewebDormantJoinSecretDelta(RUNTIME, candidateDir, op.verifierPublicKeySha256);
    }
    if (schedule) {
      if (secretSetReleaseId !== op.expectedCurrentSecretSetReleaseId || existsSync(provisionLock))
        fail('schedule_secret_preimage');
      attestScheduleSidecarArchive(op, describeTimewebRuntimeSecretSet(RUNTIME).files);
      validateTimewebScheduleSecretDelta(RUNTIME, candidateDir);
    }
    if (cupSupport) {
      if (secretSetReleaseId !== op.expectedCurrentSecretSetReleaseId || existsSync(provisionLock))
        fail('cup_support_secret_preimage');
      validateTimewebCupSupportHandoffSecretDelta(RUNTIME, candidateDir);
    }
    const manifest = await candidateAuthority(op, directory);
    const api = inspect('api'),
      web = inspect('web');
    for (const [actual, expected] of [
      [api, previousApi],
      [web, previousWeb],
    ]) {
      if (
        actual.id !== expected.id ||
        actual.image !== expected.image ||
        actual.releaseId !== expected.releaseId ||
        actual.restarts !== 0
      )
        fail('baseline_drift');
    }
    const worker = roster ? inspect('worker') : null;
    if (station) {
      attestStationPrevious(api, previousApi);
      attestStationPrevious(web, previousWeb);
      attestStationPrevious(worker, op.expectedWorker);
      attestStationDatabase();
      stationArchive = attestStationArchive(null, true);
      git(['merge-base', '--is-ancestor', worker.revision, op.candidateSha]);
    }
    const backup = station
      ? null
      : join
        ? readJoinPost105Backup(op, git(['rev-parse', 'HEAD^{tree}']))
        : schedule || appOnly
          ? validateBoundApiWebBackupProof(transaction, id, op, api)
          : validateBackupProof(transaction, previousApi, profile, cutover ? op : undefined);
    let ownerBytes;
    const monitoring =
      !direct && !scheduleWaiver && !stationDirect
        ? isOwnerDirectedCutover(op)
          ? createOwnerDirectedBinding(op, hash(opBytes))
          : isWaivedRosterCutover(op)
            ? null
            : cupSupport
              ? readCupSupportProviderEvidence(op)
              : validateMonitoring(transaction, profile, {
                  fresh: cutover || schedule || appOnly,
                  station,
                })
        : null;
    if (direct) {
      ownerBytes = directOwnerBytes(op, hash(opBytes));
    }
    plan = {
      schema: planSchema,
      operationSha256: hash(opBytes),
      ...(cutover ? { [cutoverBaselineField(op)]: cutoverBaselineHash(op) } : {}),
      controllerSha: op.controllerSha,
      manifestSha256: op.manifestSha256,
      artifactDigest: op.artifactDigest,
      composeSha256: hash(read(COMPOSE, 0o644)),
      previous: { api, web, ...(roster ? { worker } : {}) },
      candidate: Object.fromEntries(
        targets.map((service) => [
          service,
          {
            image: `ghcr.io/z6v6e6r/phub-${service}@${manifest.images.find((v) => v.component === service).digest}`,
            releaseId: service === 'worker' ? null : id,
            ...(service === 'worker' ? { revision: op.candidateSha } : {}),
          },
        ]),
      ),
      excluded: excludedTargets(),
      unchangedServiceImages: Object.fromEntries(
        (roster ? ['realtime'] : ['worker', 'realtime']).map((service) => [
          service,
          join
            ? `ghcr.io/z6v6e6r/phub-${service}@${values[service.toUpperCase() + '_IMAGE_DIGEST']}`
            : (inspect(service, 'phub-timeweb-beta', true)?.image ?? null),
        ]),
      ),
      secretSetReleaseId,
      baselineSha256: hash(baselineBytes),
      secretHashes: secretHashes(),
      ...(station
        ? {
            databaseAdmission: {
              ...STATION_BACKUP,
              ownerScopeSha256: op.ownerDecision.scopeSha256,
              ...(stationDirect
                ? stationProviderDecision
                : { providerSha256: monitoring.providerSha256 }),
              alertTestStatus: STATION_ALERT_STATUS,
            },
          }
        : { backup }),
      createdAt: new Date().toISOString(),
      ...(cutover
        ? {
            monitoring:
              isWaivedRosterCutover(op) || isOwnerDirectedCutover(op)
                ? monitoring
                : {
                    providerSha256: monitoring.providerSha256,
                    alertSha256: monitoring.alertSha256,
                  },
          }
        : {}),
      ...(swapsSecrets
        ? {
            baselinePath: baseline,
            previousSecrets: describeTimewebRuntimeSecretSet(RUNTIME),
            candidateSecrets: describeTimewebRuntimeSecretSet(candidateDir),
          }
        : {}),
      ...(join
        ? {
            verifierPublicKeySha256: op.verifierPublicKeySha256,
            notificationBundleSha256: op.notificationBundleSha256,
          }
        : {}),
      ...(scheduleWaiver
        ? {
            ownerProviderMonitoringWaiverSha256: scheduleWaiver.ownerProviderMonitoringWaiverSha256,
          }
        : {}),
      ...(cupAlert ? { ownerAlertDecisionSha256: cupAlert.ownerAlertDecisionSha256 } : {}),
      ...(direct
        ? {
            evidencePolicy: op.evidencePolicy,
            evidencePolicySha256: policyHash(op),
            ownerObservationSha256: hash(ownerBytes),
          }
        : {}),
    };
    validateUnchangedImages(plan.unchangedServiceImages, roster);
    if (
      swapsSecrets &&
      (plan.candidateSecrets.releaseId !== id ||
        plan.previousSecrets.releaseId !== secretSetReleaseId ||
        !equal(plan.candidateSecrets.files, op.candidateSecretHashes) ||
        (join && hash(JSON.stringify(plan.excluded)) !== op.expectedExcludedSha256))
    )
      fail('secret_swap_snapshot_identity');
    for (const service of targets)
      if (
        (service !== 'worker' &&
          plan.candidate[service].releaseId === plan.previous[service].releaseId) ||
        plan.candidate[service].image === plan.previous[service].image
      )
        fail('no_op_upgrade');
    const operationCopy = `${transaction}/operation.json`;
    if (existsSync(operationCopy)) {
      if (!read(operationCopy).equals(opBytes)) fail('operation_copy_drift');
    } else durable(operationCopy, opBytes, true);
    if (cutover)
      retainLegacyAttestation(
        `${transaction}/${isCanonicalOwnerDirectedUpgrade(op) ? 'canonical' : 'legacy'}-predecessor-attestation.json`,
        Buffer.from(JSON.stringify(cutoverBaseline(op))),
        read,
        durable,
      );
    if (cutover) retainLegacyAttestation(baseline, baselineBytes, read, durable);
    if (station) {
      assertOwned();
      if (!read(REQUEST).equals(opBytes)) fail('station_rollout_request_drift');
    }
    durable(LOCK, `${planPath}\n`, true);
    if (station) durable(consumed, stationReservation(), true);
    if (isWaivedRosterCutover(op))
      plan.monitoring = await admitNativeWaiverMonitoring(op, transaction, hash(opBytes));
    if (direct) durable(`${transaction}/release-owner-observation.json`, ownerBytes, true);
    durable(planPath, `${JSON.stringify(plan)}\n`, true);
    for (const name of overlays)
      durable(`${transaction}/${name}.env`, overlayBytes(plan, name), true);
    durable(`${transaction}/${admissionMarker}`, `${hash(read(planPath))}\n`, true);
    durable(
      journalPath,
      `${JSON.stringify({ schema: receiptSchema, status: 'PREPARING', planSha256: hash(read(planPath)), ...(station ? { databaseAdmissionSha256: hash(JSON.stringify(plan.databaseAdmission)), alertTestStatus: STATION_ALERT_STATUS, ...stationProviderDecision } : {}), ...(cutover ? { [cutoverBaselineField(op)]: plan[cutoverBaselineField(op)] } : {}), ...(direct ? { evidencePolicy: CALLBACK_DIRECT_POLICY, providerEvidenceStatus: 'NOT_COLLECTED_EXPLICIT_OVERRIDE' } : {}), ...scheduleWaiver, ...cupAlert, observedAt: new Date().toISOString() })}\n`,
      true,
    );
  }
  if (
    plan.schema !== planSchema ||
    plan.controllerSha !== op.controllerSha ||
    !equal(plan.previous.api.image, previousApi.image) ||
    plan.previous.api.releaseId !== previousApi.releaseId ||
    plan.previous.web.image !== previousWeb.image ||
    plan.previous.web.releaseId !== previousWeb.releaseId
  )
    fail('plan_identity');
  exact(plan, [
    'schema',
    'operationSha256',
    'controllerSha',
    'manifestSha256',
    'artifactDigest',
    'composeSha256',
    'previous',
    'candidate',
    'excluded',
    'unchangedServiceImages',
    'secretSetReleaseId',
    'baselineSha256',
    'secretHashes',
    station ? 'databaseAdmission' : 'backup',
    'createdAt',
    ...(cutover ? [cutoverBaselineField(op), 'monitoring'] : []),
    ...(swapsSecrets ? ['baselinePath', 'previousSecrets', 'candidateSecrets'] : []),
    ...(join ? ['verifierPublicKeySha256', 'notificationBundleSha256'] : []),
    ...(scheduleWaiver ? ['ownerProviderMonitoringWaiverSha256'] : []),
    ...(cupAlert ? ['ownerAlertDecisionSha256'] : []),
    ...(isDirectOperation(op)
      ? ['evidencePolicy', 'evidencePolicySha256', 'ownerObservationSha256']
      : []),
  ]);
  exact(plan.previous, targets);
  exact(plan.candidate, targets);
  if (
    roster &&
    !station &&
    (!equal(plan.previous.worker, cutoverBaseline(op).containers.worker) ||
      op.expectedWorker.id !== plan.previous.worker.id)
  )
    fail('plan_worker_preimage');
  for (const service of targets) {
    exact(plan.candidate[service], [
      'image',
      'releaseId',
      ...(service === 'worker' ? ['revision'] : []),
    ]);
    if (
      plan.candidate[service].releaseId !== (service === 'worker' ? null : id) ||
      (service === 'worker' && plan.candidate.worker.revision !== op.candidateSha) ||
      !new RegExp(`^ghcr.io/z6v6e6r/phub-${service}@sha256:[a-f0-9]{64}$`).test(
        plan.candidate[service].image,
      )
    )
      fail('plan_candidate_identity');
  }
  if (
    plan.secretSetReleaseId !== secretSetReleaseId ||
    plan.manifestSha256 !== op.manifestSha256 ||
    plan.artifactDigest !== op.artifactDigest
  )
    fail('plan_identity');
  if (
    isDirectOperation(op) &&
    (plan.evidencePolicy !== CALLBACK_DIRECT_POLICY ||
      plan.evidencePolicySha256 !== policyHash(op) ||
      plan.ownerObservationSha256 !== hash(directOwnerBytes(op, hash(opBytes))))
  )
    fail('direct_plan_identity');
  validateUnchangedImages(plan.unchangedServiceImages, roster);
  for (const service of targets)
    if (
      (service !== 'worker' &&
        plan.candidate[service].releaseId === plan.previous[service].releaseId) ||
      plan.candidate[service].image === plan.previous[service].image
    )
      fail('no_op_upgrade');
  if (station)
    for (const service of targets)
      attestStationPrevious(
        plan.previous[service],
        op[`expected${service[0].toUpperCase()}${service.slice(1)}`],
      );
  const planSha256 = hash(read(planPath));
  if (cutover) validateCutoverPlanProofs(op, plan, transaction);
  if (!read(`${transaction}/${admissionMarker}`).equals(Buffer.from(`${planSha256}\n`)))
    fail('backup_incomplete');
  const expectedDescriptor = join
    ? buildJoinInstalledDescriptor(values, plan, id, journalPath)
    : roster || schedule || appOnly
      ? buildApiWebInstalledDescriptor(values, plan, id, journalPath)
      : null;
  if (
    (schedule || cupSupport) &&
    (plan.baselinePath !== baseline ||
      plan.previousSecrets.releaseId !== op.expectedCurrentSecretSetReleaseId ||
      plan.previousSecrets.releaseId !== secretSetReleaseId ||
      plan.candidateSecrets.releaseId !== id ||
      SECRET_NAMES.some((name) => plan.previousSecrets.files[name] !== plan.secretHashes[name]) ||
      !equal(plan.candidateSecrets.files, op.candidateSecretHashes))
  )
    fail(cupSupport ? 'cup_support_plan_identity' : 'schedule_plan_identity');
  if (schedule || appOnly) validateBoundBackupPlan(plan.backup, op, transaction);
  if (
    join &&
    (plan.baselinePath !== baseline ||
      plan.baselinePath !== `${ROOT}/releases/${previousApi.releaseId}/installed-components.env` ||
      plan.previousSecrets.releaseId !== secretSetReleaseId ||
      plan.candidateSecrets.releaseId !== id ||
      SECRET_NAMES.some((name) => plan.previousSecrets.files[name] !== plan.secretHashes[name]) ||
      ['worker', 'realtime'].some(
        (service) =>
          plan.unchangedServiceImages[service] !==
          `ghcr.io/z6v6e6r/phub-${service}@${values[service.toUpperCase() + '_IMAGE_DIGEST']}`,
      ) ||
      !equal(plan.candidateSecrets.files, op.candidateSecretHashes) ||
      plan.verifierPublicKeySha256 !== op.verifierPublicKeySha256 ||
      plan.notificationBundleSha256 !== op.notificationBundleSha256 ||
      hash(JSON.stringify(plan.excluded)) !== op.expectedExcludedSha256)
  )
    fail('join_plan_identity');
  let expectedSecrets = swapsSecrets && mode === 'deploy' ? plan.previousSecrets : null;
  const provisionBytes = swapsSecrets
    ? Buffer.from(
        `${JSON.stringify({ schema: 'PHUB_TIMEWEB_RUNTIME_SWAP_LOCK_V1', planSha256, targetDir: RUNTIME, candidateDir, backupDir, previous: plan.previousSecrets, candidate: plan.candidateSecrets })}\n`,
      )
    : null;
  const secretAttest = () =>
    swapsSecrets
      ? expectedSecrets !== null && equal(describeTimewebRuntimeSecretSet(RUNTIME), expectedSecrets)
      : equal(secretHashes(), plan.secretHashes);
  const ensureProvisionLock = () => {
    if (!read(LOCK).equals(Buffer.from(`${planPath}\n`))) fail('lock_drift');
    if (existsSync(provisionLock)) {
      if (!read(provisionLock).equals(provisionBytes)) fail('join_provision_lock_drift');
    } else durable(provisionLock, provisionBytes, true);
  };
  if (swapsSecrets && mode === 'deploy') ensureProvisionLock();
  const compose = (name, action, service) => {
    const path = `${transaction}/${name}.env`;
    assertOverlayBytes(plan, name, read(path));
    if (
      hash(read(COMPOSE, 0o644)) !== plan.composeSha256 ||
      hash(read(baseline)) !== plan.baselineSha256 ||
      !secretAttest()
    )
      fail('compose_input_drift');
    return docker(apiWebComposeArgs(baseline, path, action, service, roster));
  };
  const active = {};
  let stoppedWorkerId = null;
  const attestStationForward = ({ full = false, database = false, minimumMs = 0 } = {}) => {
    if (!station) return;
    assertOwned();
    if (mode === 'deploy') {
      validateStationWindow(op, Date.now(), minimumMs);
      if (!stationDirect) validateMonitoring(transaction, profile, { station: true });
    }
    stationArchive = attestStationArchive(stationArchive, full);
    if (database) attestStationDatabase();
    if (mode === 'deploy' && (full || database)) validateStationWindow(op, Date.now(), minimumMs);
  };
  const attest = (recovering = false) => {
    if (station) assertOwned();
    if (!recovering) attestStationForward();
    if ((schedule || appOnly) && !recovering) {
      if (schedule) attestScheduleSidecarArchive(op, plan.previousSecrets.files);
      if (appOnly && mode === 'deploy') validateScheduleExpiry(op.expiresAt);
      attestBoundBackupFiles(plan.backup);
    }
    if (roster && !recovering && stoppedWorkerId && !active.worker) {
      const stopped = JSON.parse(docker(['inspect', stoppedWorkerId]))[0];
      if (
        stopped.Id !== stoppedWorkerId ||
        stopped.State.Running !== false ||
        !['exited', 'created'].includes(stopped.State.Status)
      )
        fail('worker_resumed_during_cutover');
    }
    if (cutover) {
      if (isCanonicalOwnerDirectedUpgrade(op)) readCanonicalPredecessor(op, true);
      else readLegacyPredecessor(op, recovering);
      if (
        plan[cutoverBaselineField(op)] !== cutoverBaselineHash(op) ||
        hash(
          read(
            `${transaction}/${isCanonicalOwnerDirectedUpgrade(op) ? 'canonical' : 'legacy'}-predecessor-attestation.json`,
          ),
        ) !== plan[cutoverBaselineField(op)]
      )
        fail('legacy_attestation_drift');
      // Forward admission requires the sealed backup and monitoring inputs. Image-only
      // recovery still restores the predecessor if these inputs disappear or rotate.
      if (!recovering) {
        assertCutoverBackupFiles(op, plan, transaction, read, hashBackupFile);
        if (isOwnerDirectedCutover(op))
          validateOwnerDirectedBinding(op, plan.monitoring, hash(opBytes));
        else if (isWaivedRosterCutover(op)) attestSealedNativeMonitoring(op, plan, transaction);
        else {
          const monitoring = validateMonitoring(transaction, profile);
          if (
            monitoring.providerSha256 !== plan.monitoring.providerSha256 ||
            monitoring.alertSha256 !== plan.monitoring.alertSha256
          )
            fail('cutover_monitoring_drift');
        }
      }
    }
    if (
      hash(read(COMPOSE, 0o644)) !== plan.composeSha256 ||
      !equal(excludedTargets(), plan.excluded) ||
      hash(read(baseline)) !== plan.baselineSha256 ||
      !secretAttest() ||
      !overlays.every((name) =>
        read(`${transaction}/${name}.env`).equals(Buffer.from(overlayBytes(plan, name))),
      )
    )
      fail('excluded_or_configuration_drift');
  };
  const attestRunningEnv = (restored = false) => {
    if (!swapsSecrets && !station) return;
    const parseDockerEnv = (values) => {
      const entries = values.map((v) => [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)]);
      if (new Set(entries.map(([key]) => key)).size !== entries.length)
        fail('running_env_duplicates');
      return Object.fromEntries(entries);
    };
    if (station) {
      const name = restored ? 'previous-api' : 'candidate';
      const rendered = JSON.parse(compose(name, 'config', 'api'));
      for (const service of ['api', 'worker']) {
        const ids = docker([
          'ps',
          '-q',
          '--filter',
          'label=com.docker.compose.project=phub-timeweb-beta',
          '--filter',
          `label=com.docker.compose.service=${service}`,
        ]).trim();
        // Worker is deliberately stopped between containment and worker activation.
        if (service === 'worker' && stoppedWorkerId && !active.worker && !restored && !ids)
          continue;
        const actual = inspect(service);
        const running = JSON.parse(docker(['inspect', actual.id]))[0].Config.Env;
        const defaults = JSON.parse(docker(['image', 'inspect', actual.image]))[0].Config.Env;
        validateStationRuntimeEnvironment(
          running,
          defaults,
          rendered.services[service].environment,
        );
      }
      return;
    }
    const api = inspect('api');
    const running = parseDockerEnv(JSON.parse(docker(['inspect', api.id]))[0].Config.Env);
    const parse =
      schedule || cupSupport
        ? parseTimewebScheduleRuntimeEnvironment
        : parseTimewebSecretEnvironment;
    const file = parse(read(`${RUNTIME}/api.env`));
    if (join) validateJoinRunningEnvironment(running, file);
    if (schedule) {
      const defaults = JSON.parse(
        docker(['image', 'inspect', '--format={{json .Config.Env}}', api.image]),
      );
      validateTimewebScheduleRunningEnvironment(
        running,
        expectedSecrets === plan.candidateSecrets,
        { ...parseDockerEnv(defaults ?? []), ...file },
      );
    }
    if (cupSupport) {
      const defaults = JSON.parse(
        docker(['image', 'inspect', '--format={{json .Config.Env}}', api.image]),
      );
      const expected = { ...parseDockerEnv(defaults ?? []), ...file };
      if (
        validateTimewebCupSupportHandoffEnvironment(running) !==
          (expectedSecrets === plan.candidateSecrets) ||
        Object.keys(running).length !== Object.keys(expected).length ||
        Object.entries(expected).some(([key, value]) => running[key] !== value)
      )
        fail('cup_support_running_environment');
    }
  };
  let installedBaselineSha256;
  const journal = async (status) =>
    durable(
      journalPath,
      `${JSON.stringify({
        schema: receiptSchema,
        status,
        planSha256,
        ...(station
          ? {
              databaseAdmissionSha256: hash(JSON.stringify(plan.databaseAdmission)),
              alertTestStatus: STATION_ALERT_STATUS,
              ...stationProviderDecision,
            }
          : {}),
        ...(cutover ? { [cutoverBaselineField(op)]: plan[cutoverBaselineField(op)] } : {}),
        ...(isDirectOperation(op)
          ? {
              evidencePolicy: CALLBACK_DIRECT_POLICY,
              providerEvidenceStatus: 'NOT_COLLECTED_EXPLICIT_OVERRIDE',
            }
          : {}),
        ...scheduleWaiver,
        ...cupAlert,
        ...(status === 'SUCCESS'
          ? {
              installedBaselineSha256,
              observationSha256: hash(read(`${transaction}/observation.json`)),
              ...(isOwnerDirectedCutover(op)
                ? ownerDirectedReceipt(plan.monitoring)
                : isWaivedRosterCutover(op)
                  ? nativeAdmissionReceipt(plan.monitoring)
                  : isDirectOperation(op)
                    ? {
                        ownerObservationSha256: plan.ownerObservationSha256,
                        evidencePolicySha256: plan.evidencePolicySha256,
                      }
                    : scheduleWaiver || stationDirect
                      ? {}
                      : {
                          providerReadbackSha256: hash(
                            read(`${transaction}/timeweb-monitor-readback.json`),
                          ),
                          ...(!station && !cupSupport
                            ? {
                                alertReadbackSha256: hash(
                                  read(`${transaction}/alert-test-readback.json`),
                                ),
                              }
                            : {}),
                        }),
            }
          : {}),
        observedAt: new Date().toISOString(),
      })}\n`,
    );
  const releaseLock = () => {
    if (!read(LOCK).equals(Buffer.from(`${planPath}\n`))) fail('lock_drift');
    unlinkSync(LOCK);
    const fd = openSync(dirname(LOCK), 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  const attestJoinBackup = () => {
    if (
      join &&
      !equal(
        readJoinPost105Backup(op, git(['rev-parse', 'HEAD^{tree}']), { fresh: false }),
        plan.backup,
      )
    )
      fail('join_backup_drift');
  };
  const ops = {
    journal,
    ...(appOnly
      ? {
          backupMode: 'app-only',
          removeCandidateBaseline: async () => {
            const path = `${directory}/installed-components.env`;
            if (!existsSync(path)) return;
            if (!read(path).equals(expectedDescriptor)) fail('foreign_candidate_descriptor');
            unlinkSync(path);
            const fd = openSync(directory, 'r');
            try {
              fsyncSync(fd);
            } finally {
              closeSync(fd);
            }
          },
        }
      : {}),
    ...(roster
      ? {
          workerMode: 'legacy-roster-cutover',
          containWorker: async (recovering = true) => {
            if (!recovering && (isWaivedRosterCutover(op) || isOwnerDirectedCutover(op)))
              validateProductionCutover(op, true);
            attest(recovering);
            if (station && !recovering) {
              attestStationForward({ database: true, minimumMs: 20 * 60_000 });
              attestStationPrevious(inspect('worker'), op.expectedWorker);
            }
            stoppedWorkerId = containRosterCutoverWorker(plan);
            delete active.worker;
            attest(recovering);
          },
          removeCandidateBaseline: async () => {
            const path = `${directory}/installed-components.env`;
            if (existsSync(path)) {
              if (!read(path).equals(expectedDescriptor)) fail('foreign_candidate_descriptor');
              unlinkSync(path);
              const fd = openSync(directory, 'r');
              try {
                fsyncSync(fd);
              } finally {
                closeSync(fd);
              }
            }
          },
        }
      : {}),
    ...(swapsSecrets
      ? {
          secretMode: join ? 'join-dormant' : cupSupport ? 'cup-support-staging' : 'schedule-read',
          installSecrets: async () => {
            attest();
            ensureProvisionLock();
            if (join) {
              validateJoinOperation(op, true);
              validateTimewebDormantJoinSecretDelta(
                RUNTIME,
                candidateDir,
                op.verifierPublicKeySha256,
              );
            } else if (cupSupport) {
              validateScheduleExpiry(op.expiresAt, 16 * 60_000);
              readCupSupportProviderEvidence(op);
              validateTimewebCupSupportHandoffSecretDelta(RUNTIME, candidateDir);
            } else {
              validateScheduleExpiry(op.expiresAt, 16 * 60_000);
              validateTimewebScheduleSecretDelta(RUNTIME, candidateDir);
            }
            transitionPreparedTimewebRuntimeSecrets({
              direction: 'install',
              targetDir: RUNTIME,
              candidateDir,
              backupDir,
              previous: plan.previousSecrets,
              candidate: plan.candidateSecrets,
              planSha256,
            });
            expectedSecrets = plan.candidateSecrets;
            attest();
          },
          restoreSecrets: async () => {
            // The sealed plan and exact three-layout swap classify an ambiguous rename.
            // Do not run old-marker checks or consult GitHub before restoring custody.
            ensureProvisionLock();
            transitionPreparedTimewebRuntimeSecrets({
              direction: 'restore',
              targetDir: RUNTIME,
              candidateDir,
              backupDir,
              previous: plan.previousSecrets,
              candidate: plan.candidateSecrets,
              planSha256,
            });
            expectedSecrets = plan.previousSecrets;
            attest(true);
          },
          removeCandidateBaseline: async () => {
            const path = `${directory}/installed-components.env`;
            if (existsSync(path)) {
              if (!read(path).equals(expectedDescriptor)) fail('foreign_candidate_descriptor');
              unlinkSync(path);
              const fd = openSync(directory, 'r');
              try {
                fsyncSync(fd);
              } finally {
                closeSync(fd);
              }
            }
          },
        }
      : {}),
    attestRestored: async () => {
      await attestApiWebTerminal('ROLLED_BACK', attest);
      attestRunningEnv(true);
      if (roster) for (const service of targets) await wait(service, plan.previous[service]);
    },
    abort: async () => {
      if (swapsSecrets) expectedSecrets = plan.previousSecrets;
      await attestApiWebTerminal('ABORTED', attest);
      for (const service of targets)
        if (!equal(inspect(service), plan.previous[service])) fail('abort_baseline_changed');
    },
    installBaseline: async () => {
      attestStationForward({ full: true, database: true });
      if (schedule) validateScheduleExpiry(op.expiresAt);
      if (appOnly) {
        attest();
        attestAppOnlyDatabase(plan.backup);
        attest();
      }
      if (swapsSecrets) {
        attest();
        attestJoinBackup();
        durable(`${directory}/installed-components.env`, expectedDescriptor, true);
        installedBaselineSha256 = hash(expectedDescriptor);
        return;
      }
      const bytes = buildApiWebInstalledDescriptor(values, plan, id, journalPath);
      durable(`${directory}/installed-components.env`, bytes, true);
      installedBaselineSha256 = hash(bytes);
    },
    attest: async () => {
      attest();
      attestRunningEnv();
      if (cupSupport) attestCupSupportDirectEvidence(transaction, op, plan, planSha256);
      for (const service of Object.keys(active))
        if (!equal(inspect(service), active[service])) fail('candidate_changed_before_success');
    },
    preflight: async () => {
      attestStationForward({ database: true });
      attest();
      attestJoinBackup();
      if (appOnly) attestAppOnlyDatabase(plan.backup);
      for (const s of targets) {
        if (!equal(inspect(s), plan.previous[s])) fail('baseline_drift');
        imagePresent(
          plan.previous[s].image,
          predecessorSource(plan.previous[s]),
          isLegacyProductionCutover(op) ? plan.previous[s].imageId : undefined,
        );
        const rendered = JSON.parse(compose('candidate', 'config', s));
        for (const component of ['api', 'web', 'realtime', 'worker', 'migrator']) {
          const expected = targets.includes(component)
            ? plan.candidate[component].image
            : `ghcr.io/z6v6e6r/phub-${component}@${values[`${component.toUpperCase()}_IMAGE_DIGEST`]}`;
          if (rendered.services[component].image !== expected) fail('compose_image_identity');
        }
        await probe(s);
        if (s !== 'worker') await probe(s, true);
      }
      attestRunningEnv(station);
    },
    pullAndSmoke: async () => {
      for (const s of targets) {
        compose('candidate', 'pull', s);
        imagePresent(plan.candidate[s].image, op.candidateSha);
        docker(apiWebArtifactSmokeArgs(s, plan.candidate[s].image, roster));
      }
      attest();
    },
    activate: async (s) => {
      if (join) validateJoinOperation(op, true);
      if (schedule) validateScheduleExpiry(op.expiresAt);
      if (cupSupport) readCupSupportProviderEvidence(op);
      if (
        schedule &&
        s === 'api' &&
        hashBackupFile(plan.backup.dumpPath) !== plan.backup.dumpSha256
      )
        fail('schedule_backup_drift');
      if (cutover) validateProductionCutover(op, true);
      if (isDirectOperation(op)) validateDirectApiWebOperation(op, true);
      attest();
      if (s === 'worker') attestStationForward({ database: true });
      compose('candidate', 'up', s);
      active[s] = await wait(s, plan.candidate[s]);
      if (s === 'api' || (station && s === 'worker')) attestRunningEnv();
      attest();
      if (s === 'api' && !equal(inspect('web'), plan.previous.web))
        fail('web_changed_before_activation');
      if (s === 'web' && !equal(inspect('api'), active.api)) fail('api_changed_during_activation');
      if (roster && s !== 'api' && !equal(inspect('api'), active.api))
        fail('api_changed_during_activation');
      if (roster && s === 'web' && !equal(inspect('worker'), active.worker))
        fail('worker_changed_during_activation');
    },
    observe: async () => {
      if (station) {
        validateStationWindow(op, Date.now(), 17 * 60_000);
        const observation = await observeStationRollout({
          inspectService: (service) => {
            if (!equal(inspect(service), active[service])) fail('candidate_restarted');
          },
          probeService: probe,
          identity: stationObservationIdentity(op, plan, planSha256),
          attest: () => {
            attest();
            attestRunningEnv();
          },
        });
        if (!stationDirect) {
          const finalMonitoring = validateMonitoring(transaction, profile, { station: true });
          durable(`${transaction}/timeweb-monitor-readback.json`, finalMonitoring.provider, true);
        }
        durable(`${transaction}/observation.json`, `${JSON.stringify(observation)}\n`, true);
        return;
      }
      if (schedule || appOnly) validateScheduleExpiry(op.expiresAt, 900_000);
      if (isDirectOperation(op)) {
        await callbackProbe();
        const direct = await observeDirectApiWeb({
          inspectService: (service) => {
            if (!equal(inspect(service), active[service])) fail('candidate_restarted');
          },
          probeService: probe,
          attest: async () => {
            validateDirectApiWebOperation(op, true);
            const owner = read(`${transaction}/release-owner-observation.json`);
            if (
              !owner.equals(directOwnerBytes(op, hash(opBytes))) ||
              hash(owner) !== plan.ownerObservationSha256
            )
              fail('direct_owner_observation_drift');
            attest();
          },
        });
        durable(`${transaction}/observation.json`, `${JSON.stringify(direct)}\n`, true);
        return;
      }
      const startedAt = new Date().toISOString();
      const detailedObservation = join || scheduleWaiver || cupSupport;
      const samples = {
        api: { privateMs: [], publicMs: [], timestamps: [] },
        web: { privateMs: [], publicMs: [], timestamps: [] },
      };
      const times = { api: [], web: [] };
      if (roster) times.worker = [];
      for (let round = 0; round <= 60; round++) {
        for (const s of targets) {
          if (!equal(inspect(s), active[s])) fail('candidate_restarted');
          const privateMs = await probe(s),
            publicMs = s === 'worker' ? null : await probe(s, true);
          times[s].push(privateMs);
          if (detailedObservation) {
            samples[s].privateMs.push(privateMs);
            samples[s].publicMs.push(publicMs);
            samples[s].timestamps.push(new Date().toISOString());
          }
        }
        if (join) validateJoinOperation(op, true);
        attest();
        attestRunningEnv();
        if (scheduleWaiver) {
          validateScheduleExpiry(op.expiresAt);
        } else if (cupSupport) readCupSupportProviderEvidence(op);
        else if (!isWaivedRosterCutover(op) && !isOwnerDirectedCutover(op))
          validateMonitoring(transaction, profile, { fresh: appOnly });
        if (round < 60) await delay(15000);
      }
      for (const s of ['api', 'web']) {
        const sorted = times[s].sort((a, b) => a - b);
        const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1],
          limit = s === 'api' ? 1500 : 1000;
        if (join ? p95 >= limit : p95 > limit) fail('latency_threshold');
      }
      let completedAt;
      if (isOwnerDirectedCutover(op))
        validateOwnerDirectedBinding(op, plan.monitoring, hash(opBytes));
      else if (isWaivedRosterCutover(op)) attestSealedNativeMonitoring(op, plan, transaction);
      else if (cupSupport) {
        const finalMonitoring = readCupSupportProviderEvidence(op);
        completedAt = finalMonitoring.observedAt;
        durable(`${transaction}/timeweb-monitor-readback.json`, finalMonitoring.provider, true);
      } else if (!scheduleWaiver) {
        const finalMonitoring = validateMonitoring(transaction, profile, {
          fresh: schedule || appOnly,
        });
        durable(`${transaction}/timeweb-monitor-readback.json`, finalMonitoring.provider, true);
        durable(`${transaction}/alert-test-readback.json`, finalMonitoring.alerts, true);
      }
      completedAt ??= new Date().toISOString();
      for (const service of ['api', 'web'])
        for (const [key, source] of [
          ['p95PrivateMs', 'privateMs'],
          ['p95PublicMs', 'publicMs'],
        ])
          samples[service][key] = [...samples[service][source]].sort((a, b) => a - b)[57];
      const observation = detailedObservation
        ? (join
            ? validateJoinObservation
            : cupSupport
              ? validateCupSupportDirectObservation
              : validateScheduleDirectObservation)(
            {
              schema: join
                ? 'PHUB_TIMEWEB_JOIN_DORMANT_OBSERVATION_V1'
                : cupSupport
                  ? CUP_SUPPORT_DIRECT_OBSERVATION
                  : SCHEDULE_DIRECT_OBSERVATION,
              operationSha256: plan.operationSha256,
              planSha256,
              candidateSha: op.candidateSha,
              startedAt,
              completedAt,
              elapsedSeconds: (Date.parse(completedAt) - Date.parse(startedAt)) / 1000,
              samples,
              serverErrors: 0,
            },
            op,
            plan,
            planSha256,
          )
        : {
            windowSeconds: 900,
            samplesPerService: 61,
            latencyMs: times,
            serverErrors: 0,
            completedAt,
            ...(roster
              ? {
                  startedAt,
                  elapsedSeconds: (Date.parse(completedAt) - Date.parse(startedAt)) / 1000,
                }
              : {}),
          };
      if (roster) validateRosterCutoverObservation(observation);
      durable(`${transaction}/observation.json`, `${JSON.stringify(observation)}\n`, true);
    },
    restore: async (s) => {
      // Only exact recorded candidate/previous images may be replaced by recovery.
      const ids = docker([
        'ps',
        '-aq',
        '--filter',
        'label=com.docker.compose.project=phub-timeweb-beta',
        '--filter',
        `label=com.docker.compose.service=${s}`,
      ])
        .trim()
        .split('\n')
        .filter(Boolean);
      if (ids.length !== 1) fail('recovery_service_count');
      const actual = JSON.parse(docker(['inspect', ids[0]]))[0];
      if (
        ![plan.previous[s], plan.candidate[s]].some(
          (v) =>
            v.image === actual.Config.Image &&
            v.releaseId === (actual.Config.Labels['phub.release-id'] ?? null) &&
            (!Object.hasOwn(v, 'revision') ||
              v.revision === (actual.Config.Labels['org.opencontainers.image.revision'] ?? null)),
        )
      )
        fail('foreign_recovery_image');
      imagePresent(
        plan.previous[s].image,
        predecessorSource(plan.previous[s]),
        isLegacyProductionCutover(op) ? plan.previous[s].imageId : undefined,
      );
      compose(`previous-${s}`, 'up', s);
      await wait(s, plan.previous[s]);
      delete active[s];
      if (s === 'worker') stoppedWorkerId = null;
    },
  };
  const receipt = validateUpgradeReceipt(
    JSON.parse(read(journalPath)),
    planSha256,
    op,
    plan,
    read(planPath),
  );
  if (mode === 'reconcile') {
    await reconcileApiWebPhase(receipt, {
      attestTerminal: async (terminal) => {
        if (
          (roster || swapsSecrets || appOnly) &&
          terminal !== 'SUCCESS' &&
          existsSync(`${directory}/installed-components.env`)
        )
          fail('non_success_candidate_descriptor');
        attestJoinBackup();
        if (swapsSecrets)
          expectedSecrets = terminal === 'SUCCESS' ? plan.candidateSecrets : plan.previousSecrets;
        await attestApiWebTerminal(terminal, attest);
        for (const service of targets)
          await wait(
            service,
            terminal === 'SUCCESS' ? plan.candidate[service] : plan.previous[service],
          );
        attestRunningEnv(terminal !== 'SUCCESS');
        if (terminal === 'SUCCESS' && swapsSecrets) {
          if (join)
            validateJoinObservation(
              parseStrictJson(read(`${transaction}/observation.json`)),
              op,
              plan,
              planSha256,
            );
          if (scheduleWaiver)
            validateScheduleDirectObservation(
              parseStrictJson(read(`${transaction}/observation.json`)),
              op,
              plan,
              planSha256,
            );
          if (cupSupport) attestCupSupportDirectEvidence(transaction, op, plan, planSha256);
          if (
            !read(`${directory}/installed-components.env`).equals(expectedDescriptor) ||
            hash(expectedDescriptor) !== receipt.installedBaselineSha256
          )
            fail('installed_baseline_drift');
          for (const [file, key] of [
            ['observation.json', 'observationSha256'],
            ...(scheduleWaiver
              ? []
              : [
                  ['timeweb-monitor-readback.json', 'providerReadbackSha256'],
                  ...(!cupSupport ? [['alert-test-readback.json', 'alertReadbackSha256']] : []),
                ]),
          ])
            if (hash(read(`${transaction}/${file}`)) !== receipt[key])
              fail('installed_evidence_drift');
        }
        if (terminal === 'SUCCESS' && !swapsSecrets) {
          // App-only installation is admitted by the installed reader after this reconciliation.
          const bytes =
            appOnly || station
              ? read(`${directory}/installed-components.env`)
              : readInstalledApiBaseline(id).bytes;
          if (
            hash(bytes) !== receipt.installedBaselineSha256 ||
            ((appOnly || station) && !bytes.equals(expectedDescriptor))
          )
            fail('installed_baseline_drift');
          if (appOnly || station) {
            if (station) {
              attestStationForward({ full: true, database: true });
              validateStationObservation(
                parseStrictJson(read(`${transaction}/observation.json`)),
                validateRosterCutoverObservation,
                receipt.observedAt,
                stationObservationIdentity(op, plan, planSha256),
              );
            }
            for (const [file, key] of [
              ['observation.json', 'observationSha256'],
              ...(!stationDirect
                ? [['timeweb-monitor-readback.json', 'providerReadbackSha256']]
                : []),
              ...(!station ? [['alert-test-readback.json', 'alertReadbackSha256']] : []),
            ])
              if (hash(read(`${transaction}/${file}`)) !== receipt[key])
                fail('installed_app_only_evidence');
          }
        }
      },
      journalReconciled: async (terminal) => {
        if (
          (swapsSecrets || appOnly || station || isCanonicalOwnerDirectedUpgrade(op)) &&
          receipt.status === 'RECONCILED'
        )
          return;
        durable(
          journalPath,
          `${JSON.stringify({ ...receipt, status: 'RECONCILED', reconciledStatus: terminal, observedAt: new Date().toISOString() })}\n`,
        );
      },
      releaseLock: async () => {
        if (terminalWithoutLock) return;
        if (swapsSecrets && existsSync(provisionLock)) {
          if (!read(provisionLock).equals(provisionBytes)) fail('join_provision_lock_drift');
          unlinkSync(provisionLock);
          const fd = openSync(dirname(provisionLock), 'r');
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        }
        releaseLock();
      },
    });
    return { status: 'RECONCILED', candidate: id, receipt: journalPath };
  }
  let recoveredStatus;
  if (mode === 'recover') {
    if (['SUCCESS', 'ROLLED_BACK', 'ABORTED', 'RECONCILED'].includes(receipt.status))
      fail('use_terminal_reconciliation');
    recoveredStatus = await recoverApiWebPhase(receipt.status, ops);
  } else {
    try {
      await runApiWebTransition(ops);
    } catch (error) {
      if (
        !swapsSecrets &&
        !roster &&
        !appOnly &&
        JSON.parse(read(journalPath)).status === 'ABORTED'
      )
        releaseLock();
      throw error;
    }
    if (!swapsSecrets && !roster && !appOnly) releaseLock();
  }
  return {
    status: mode === 'recover' ? recoveredStatus : 'SUCCESS',
    candidate: id,
    receipt: journalPath,
  };
}

// Shared trusted primitives only; the critical Web route never calls the API/Web executor.
export {
  secure as secureUpgradePath,
  read as readUpgradeFile,
  git as upgradeGit,
  docker as upgradeDocker,
  inspect as inspectUpgradeService,
  excluded as inspectUpgradeExcluded,
  secretHashes as upgradeSecretHashes,
  candidateAuthority as validateUpgradeCandidateAuthority,
  imagePresent as assertUpgradeImagePresent,
  probe as probeUpgradeService,
  validateBackupProof as validateUpgradeBackup,
  validateMonitoring as readUpgradeMonitoring,
  wait as waitUpgradeService,
};
