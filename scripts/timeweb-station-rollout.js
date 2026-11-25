import { createHash } from 'node:crypto';
import { parseStrictJson } from './strict-json.js';
import { CUP_0119 } from './timeweb-cup-0119-migration.js';

export const STATION_OPERATION = 'PHUB_TIMEWEB_STATION_ROLLOUT_OPERATION_V1';
export const STATION_PLAN = 'PHUB_TIMEWEB_STATION_ROLLOUT_PLAN_V1';
export const STATION_RECEIPT = 'PHUB_TIMEWEB_STATION_ROLLOUT_RECEIPT_V1';
export const STATION_KIND = 'API_WORKER_WEB_STATION_ROLLOUT';
export const STATION_APPLICATION = '3c7373a543d8a47717baa3b051568a6d34806f24';
export const STATION_TREE = '28886d7929a080e34e153ebea7e713d0e40dabd0';
export const STATION_WAIVER_SHA256 =
  '80bbed794dd6c16f2d5a122f3652f494a9ade234ebeed9814d307925e23f9799';
const ownerSchema = 'PHUB_TIMEWEB_STATION_OWNER_DECISION_V1';
const ownerAuthority = 'ROOT_OPERATOR_ATTESTED_OWNER_MESSAGE_V1';
const timewebTarget = Object.freeze({ serverId: 8886471, projectId: 262717 });
export const STATION_ROOT = '/opt/phub/timeweb-beta';
export const STATION_SNAPSHOT = STATION_ROOT + '/backups/manual-snapshot-20261125T092203Z';
export const STATION_CUP_RECEIPT =
  STATION_ROOT + '/operator/cup-0119-96227dc8-fe36-46ed-b4e2-aba4a0a4df9e/receipt.json';
export const STATION_POSTGRES = Object.freeze({
  id: 'fe614a3312e446e8036243be3781590bfe90b5da037b83580abd410d4514e84c',
  startedAt: '2026-08-28T16:49:17.916395698Z',
  image:
    'docker.io/library/postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685',
});
const predecessor = '43d4bd64e5ae2e1d2c64b30b7df48a5fdc67ec34-45551585649-1';
const workerRevision = '0a4d640965e921e6d06eeb22de6cc6dcae07f0b1';
export const STATION_PREVIOUS = Object.freeze({
  api: Object.freeze({
    id: 'c0f30282b455f63ca89d5a04fc5e9462ea62526f147d0959b5ba8099a01f8513',
    image:
      'ghcr.io/z6v6e6r/phub-api@sha256:54e37829cb00a766d00a3729e246fa0569a9d3b304553431a3c71fa45f611a7d',
    releaseId: predecessor,
  }),
  web: Object.freeze({
    id: '184514863aa89c554190b6a3591ce05076aeca45ae69f47d8a418aa060da0de6',
    image:
      'ghcr.io/z6v6e6r/phub-web@sha256:a604e32649f6efed21d58859e3a79a9a9aafd64601eced99df0118a4fec292fb',
    releaseId: predecessor,
  }),
  worker: Object.freeze({
    id: 'c6ad01e8769907996e3609a9af7c9a732ad60d7b3b0378f626e5a5f31be167d1',
    image:
      'ghcr.io/z6v6e6r/phub-worker@sha256:270e3f30aa50e2c8d2300d1456f643053ef601e3a4f70ec15af34acc83ab4ac0',
    releaseId: null,
    revision: workerRevision,
  }),
});
export const STATION_BACKUP = Object.freeze({
  policy: 'DUMP_INTEGRITY_ONLY_OWNER_ACCEPTED',
  restoreVerified: false,
  snapshotCatalogVerified: false,
  dumpPath: STATION_SNAPSHOT + '/database.pgcustom',
  dumpBytes: 1207034429,
  dumpSha256: '62d843c12d48798c91ce8ffedd9f4400f71508b377c1ca369f4f0230a6058041',
  receiptSha256: 'a65d7fbd41aa048d833717008c7a44f0d30db8a00250d7e00d00d843b6637b55',
  tocSha256: '8ef6ccb4304d29d84f5fdf91669bbbc1867db8a9695cead94f0ddd2c6fcd4a8e',
  completedAt: '2026-11-25T09:33:03.301Z',
  cupReceiptSha256: '4369a9c3f945754e3adfb028fbf066915c5a93d31de3368dd51ce3335a66c3fa',
  cupRequestSha256: 'd0804ea89a3085c688191863d0f3f0200f9b6c06708a55f7ab933f46ac1ab1c8',
  cupCatalogSha256: '7d8f1b8bd4a6a4c9f12cad2a604e15bae7305914b770f93144a5137623a8ee3a',
});
// This pinned incident snapshot expires after one day. It is never a reusable restore policy.
const snapshotTime = Date.parse(STATION_BACKUP.completedAt);
const maxSnapshotAgeSeconds = 86_400;
const admissionEnds = snapshotTime + maxSnapshotAgeSeconds * 1000;
const suffix = '_ONE_OFF_STATION_MANUAL_DUMP';
const hex = /^[a-f0-9]{64}$/;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const stop = (reason) => {
  throw new Error(`station_rollout_${reason}`);
};
const sameFields = (actual, expected) =>
  actual &&
  Object.keys(actual).length === Object.keys(expected).length &&
  Object.entries(expected).every(
    ([key, value]) => Object.hasOwn(actual, key) && actual[key] === value,
  );

export const isStationRollout = (value) => value?.schema === STATION_OPERATION;

export function stationScopeHash(value) {
  // Fixed field order, independent of the JSON transport or order of nested object keys.
  return sha256(
    JSON.stringify([
      STATION_OPERATION,
      timewebTarget,
      STATION_APPLICATION,
      STATION_TREE,
      value.target,
      value.candidateSha,
      value.candidateTree,
      value.controllerSha,
      value.sourceCiRunId,
      value.publicationRunId,
      value.artifactId,
      value.artifactDigest,
      value.manifestSha256,
      STATION_PREVIOUS,
      STATION_POSTGRES,
      STATION_BACKUP,
      value.expiresAt,
      STATION_WAIVER_SHA256,
      value.ownerDecision.releaseAuthorizationSha256,
      value.ownerDecision.receivedAt,
      value.ownerDecision.acceptedSnapshotAgeSeconds,
    ]),
  );
}

export function validateStationOperation(value, validateBase) {
  const { expiresAt, expectedWorker, ownerDecision, ...base } = value;
  const expiry = Date.parse(expiresAt);
  if (
    base.profile !== 'production' ||
    base.controllerSha !== base.candidateSha ||
    !sameFields(base.expectedApi, STATION_PREVIOUS.api) ||
    !sameFields(base.expectedWeb, STATION_PREVIOUS.web) ||
    !sameFields(expectedWorker, STATION_PREVIOUS.worker) ||
    typeof expiresAt !== 'string' ||
    !Number.isFinite(expiry) ||
    new Date(expiry).toISOString() !== expiresAt ||
    expiry > admissionEnds ||
    expiry <= snapshotTime ||
    typeof base.confirmation !== 'string' ||
    !base.confirmation.endsWith(suffix) ||
    !ownerDecision ||
    typeof ownerDecision.releaseAuthorizationSha256 !== 'string' ||
    !hex.test(ownerDecision.releaseAuthorizationSha256) ||
    typeof ownerDecision.receivedAt !== 'string' ||
    !Number.isFinite(Date.parse(ownerDecision.receivedAt)) ||
    new Date(ownerDecision.receivedAt).toISOString() !== ownerDecision.receivedAt ||
    Date.parse(ownerDecision.receivedAt) < snapshotTime ||
    Date.parse(ownerDecision.receivedAt) >= expiry ||
    !Number.isSafeInteger(ownerDecision.acceptedSnapshotAgeSeconds) ||
    ownerDecision.acceptedSnapshotAgeSeconds < Math.ceil((expiry - snapshotTime) / 1000) ||
    ownerDecision.acceptedSnapshotAgeSeconds > maxSnapshotAgeSeconds
  )
    stop('operation');
  validateBase({
    ...base,
    schema: 'PHUB_TIMEWEB_API_WEB_OPERATION_V1',
    confirmation: base.confirmation.slice(0, -suffix.length),
  });
  if (
    !sameFields(ownerDecision, {
      schema: ownerSchema,
      authority: ownerAuthority,
      decision: STATION_BACKUP.policy,
      waiverMessageSha256: STATION_WAIVER_SHA256,
      waiverReference: `codex-user-message-sha256:${STATION_WAIVER_SHA256}`,
      releaseAuthorizationSha256: ownerDecision.releaseAuthorizationSha256,
      receivedAt: ownerDecision.receivedAt,
      acceptedSnapshotAgeSeconds: ownerDecision.acceptedSnapshotAgeSeconds,
      scopeSha256: stationScopeHash(value),
    })
  )
    stop('owner_scope');
  return value;
}

export function validateStationWindow(op, now = Date.now(), minimumMs = 0) {
  const remaining = Date.parse(op.expiresAt) - now;
  if (
    now < snapshotTime ||
    !Number.isFinite(remaining) ||
    remaining <= minimumMs ||
    remaining > 3_600_000 ||
    Date.parse(op.expiresAt) > admissionEnds ||
    (op.ownerDecision && now < Date.parse(op.ownerDecision.receivedAt))
  )
    stop('expired');
}

const controllerTail = new Map([
  ['scripts/timeweb-api-web-upgrade.js', 'M'],
  ['scripts/timeweb-station-rollout.js', 'A'],
  ['scripts/timeweb-station-rollout.d.ts', 'A'],
  ['scripts/timeweb-station-rollout.test.ts', 'A'],
  ['docs/runbooks/timeweb-standard-delivery.md', 'M'],
]);

export function validateStationSourceTail(entries) {
  if (
    entries.length !== controllerTail.size ||
    new Set(entries.map(({ path }) => path)).size !== entries.length
  )
    stop('source_tail');
  for (const { path, status, oldMode, newMode, oldType, newType } of entries) {
    if (
      !controllerTail.has(path) ||
      status !== controllerTail.get(path) ||
      newType !== 'blob' ||
      newMode !== '100644' ||
      (status === 'A'
        ? oldMode !== '000000' || oldType !== null
        : oldMode !== '100644' || oldType !== 'blob')
    )
      stop('source_tail');
  }
}

export function validateStationBackupMetadata(receiptBytes, tocBytes, cupBytes, cupRequestBytes) {
  if (
    sha256(receiptBytes) !== STATION_BACKUP.receiptSha256 ||
    sha256(tocBytes) !== STATION_BACKUP.tocSha256 ||
    sha256(cupBytes) !== STATION_BACKUP.cupReceiptSha256 ||
    sha256(cupRequestBytes) !== STATION_BACKUP.cupRequestSha256
  )
    stop('backup_metadata');
  const receipt = parseStrictJson(receiptBytes);
  const cup = parseStrictJson(cupBytes);
  if (
    receipt.recordType !== 'manual-postgresql-backup' ||
    receipt.releaseAdmission !== false ||
    receipt.freshDumpRestored !== false ||
    receipt.archiveToc !== 'PG16_TOC_PARSE_VERIFIED' ||
    receipt.archiveBytes !== STATION_BACKUP.dumpBytes ||
    receipt.archiveSha256 !== STATION_BACKUP.dumpSha256 ||
    receipt.tocSha256 !== STATION_BACKUP.tocSha256 ||
    Date.parse(receipt.completedAt) !== Date.parse(STATION_BACKUP.completedAt) ||
    receipt.lastMigration !== CUP_0119.filename ||
    receipt.migrationCount !== 123 ||
    cup.schema !== 'PHUB_TIMEWEB_CUP_0119_RECEIPT_V1' ||
    cup.attemptId !== '96227dc8-fe36-46ed-b4e2-aba4a0a4df9e' ||
    cup.requestSha256 !== STATION_BACKUP.cupRequestSha256 ||
    cup.state !== 'COMMITTED' ||
    cup.migrationSha256 !== CUP_0119.checksum ||
    cup.catalogSha256 !== STATION_BACKUP.cupCatalogSha256
  )
    stop('backup_metadata');
}

export function validateStationDatabaseReadback(value) {
  if (!sameFields(value, { state: 'COMMITTED', catalogSha256: STATION_BACKUP.cupCatalogSha256 }))
    stop('database');
}

export function validateStationRetainedAdmission(admission, op) {
  if (
    !sameFields(admission, {
      ...STATION_BACKUP,
      ownerScopeSha256: op.ownerDecision.scopeSha256,
      providerSha256: admission?.providerSha256,
      alertSha256: admission?.alertSha256,
    }) ||
    !hex.test(admission.providerSha256 ?? '') ||
    !hex.test(admission.alertSha256 ?? '')
  )
    stop('retained_admission');
}

export function validateStationRuntimeEnvironment(running, imageDefaults, rendered) {
  const parse = (rows) => {
    const vars = Object.create(null);
    for (const row of rows) {
      const split = row.indexOf('=');
      const key = row.slice(0, split);
      if (split < 1 || Object.hasOwn(vars, key)) stop('runtime_environment');
      vars[key] = row.slice(split + 1);
    }
    return vars;
  };
  const expected = parse(imageDefaults ?? []);
  for (const [key, value] of Object.entries(rendered)) {
    if (value === null) delete expected[key];
    else expected[key] = String(value);
  }
  if (!sameFields(parse(running), expected)) stop('runtime_environment');
}

export function validateStationObservation(value, validateRoster, receiptAt) {
  const { publicLatencyMs, ...roster } = value;
  validateRoster(roster, receiptAt);
  if (!publicLatencyMs || Object.keys(publicLatencyMs).length !== 2) stop('public_latency');
  for (const [service, limit] of [
    ['api', 1500],
    ['web', 1000],
  ]) {
    const samples = publicLatencyMs[service];
    if (
      !Array.isArray(samples) ||
      samples.length !== 61 ||
      samples.some((ms) => !Number.isFinite(ms) || ms < 0 || ms > 10_000) ||
      [...samples].sort((a, b) => a - b)[57] > limit
    )
      stop('public_latency');
  }
}
