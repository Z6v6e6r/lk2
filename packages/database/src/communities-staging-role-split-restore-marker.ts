import { createHash } from 'node:crypto';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  failCommunitiesStagingRoleSplit,
} from './communities-staging-role-split.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_VERSION =
  'PHUB_COMMUNITIES_ROLE_SPLIT_CLONE_MARKER_V1';
export const COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_PREFIX =
  'phub-communities-role-split-clone-v1:';
export const COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_REQUEST_VERSION =
  'PHUB_COMMUNITIES_ROLE_SPLIT_CLONE_MARKER_REQUEST_V1';

export interface CommunitiesStagingRoleSplitRestoreMarkerRequest {
  readonly restoreDatabase: string;
  readonly expectedCloneDatabaseOwner: string;
  readonly expectedCloneDatabaseOwnerOid: string;
  readonly sourceDatabase: string;
  readonly sourceDatabaseOid: string;
  readonly sourceDatabaseOwner: string;
  readonly sourceDatabaseOwnerOid: string;
  readonly systemIdentifier: string;
  readonly backupBasename: string;
  readonly backupSha256: string;
  readonly backupBytes: string;
  readonly backupEvidenceBasename: string;
  readonly backupEvidenceSha256: string;
  readonly archiveTocSha256: string;
  readonly sourceLedgerSha256: string;
  readonly sourceLedgerCount: string;
  readonly activeRelease: string;
  readonly restoreRunId: string;
  readonly restoreRunAttempt: string;
  readonly postgresMajor: '16';
  readonly objectManifestSha256: string;
  readonly restoreHelperSha256: string;
  readonly markerWriterSha256: string;
}

export interface CommunitiesStagingRoleSplitRestoreMarkerPayload {
  readonly requestSha256: string;
  readonly restoreDatabase: string;
  readonly cloneDatabaseOid: string;
  readonly cloneDatabaseOwner: string;
  readonly cloneDatabaseOwnerOid: string;
  readonly sourceDatabase: string;
  readonly sourceDatabaseOid: string;
  readonly sourceDatabaseOwner: string;
  readonly sourceDatabaseOwnerOid: string;
  readonly systemIdentifier: string;
  readonly backupSha256: string;
  readonly backupBytes: string;
  readonly backupEvidenceSha256: string;
  readonly archiveTocSha256: string;
  readonly sourceLedgerSha256: string;
  readonly sourceLedgerCount: string;
  readonly activeRelease: string;
  readonly restoreRunId: string;
  readonly restoreRunAttempt: string;
  readonly postgresMajor: '16';
  readonly objectManifestSha256: string;
  readonly restoreHelperSha256: string;
  readonly markerWriterSha256: string;
}

export interface CommunitiesStagingRoleSplitRestoreMarkerEvidence {
  readonly schemaVersion: 'communities-role-split-clone-marker-evidence-v1';
  readonly status: 'MARKED';
  readonly requestSha256: string;
  readonly markerPayloadSha256: string;
  readonly markerValueSha256: string;
  readonly backupSha256: string;
  readonly sourceLedgerSha256: string;
  readonly sourceLedgerCount: string;
  readonly cloneDatabaseOid: string;
  readonly cloneBindingSha256: string;
  readonly sourceBindingSha256: string;
  readonly restoreRunId: string;
  readonly restoreRunAttempt: string;
  readonly restoreHelperSha256: string;
  readonly markerWriterSha256: string;
  readonly bindings: {
    readonly request: true;
    readonly backup: true;
    readonly archiveOwnershipAcl: true;
    readonly sourceStable: true;
    readonly restoredLedger: true;
    readonly cloneIdentity: true;
    readonly markerReadback: true;
  };
  readonly authorizes: {
    readonly roleCreation: false;
    readonly roleSplit: false;
    readonly sharedDatabaseMutation: false;
    readonly migration: false;
    readonly deploy: false;
    readonly import: false;
    readonly activation: false;
  };
}

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const positiveDecimal = /^[1-9][0-9]*$/;
const sha256 = /^[a-f0-9]{64}$/;
const release = /^[a-f0-9]{40}$/;
const rehearsalBackupBasename =
  /^postgres-communities-rehearsal-[0-9]{8}T[0-9]{6}Z-[1-9][0-9]*\.dump$/;

const payloadKeys = [
  'requestSha256',
  'restoreDatabase',
  'cloneDatabaseOid',
  'cloneDatabaseOwner',
  'cloneDatabaseOwnerOid',
  'sourceDatabase',
  'sourceDatabaseOid',
  'sourceDatabaseOwner',
  'sourceDatabaseOwnerOid',
  'systemIdentifier',
  'backupSha256',
  'backupBytes',
  'backupEvidenceSha256',
  'archiveTocSha256',
  'sourceLedgerSha256',
  'sourceLedgerCount',
  'activeRelease',
  'restoreRunId',
  'restoreRunAttempt',
  'postgresMajor',
  'objectManifestSha256',
  'restoreHelperSha256',
  'markerWriterSha256',
] as const;
const requestKeys = [
  'restoreDatabase',
  'expectedCloneDatabaseOwner',
  'expectedCloneDatabaseOwnerOid',
  'sourceDatabase',
  'sourceDatabaseOid',
  'sourceDatabaseOwner',
  'sourceDatabaseOwnerOid',
  'systemIdentifier',
  'backupBasename',
  'backupSha256',
  'backupBytes',
  'backupEvidenceBasename',
  'backupEvidenceSha256',
  'archiveTocSha256',
  'sourceLedgerSha256',
  'sourceLedgerCount',
  'activeRelease',
  'restoreRunId',
  'restoreRunAttempt',
  'postgresMajor',
  'objectManifestSha256',
  'restoreHelperSha256',
  'markerWriterSha256',
] as const;
const evidenceKeys = [
  'schemaVersion',
  'status',
  'requestSha256',
  'markerPayloadSha256',
  'markerValueSha256',
  'backupSha256',
  'sourceLedgerSha256',
  'sourceLedgerCount',
  'cloneDatabaseOid',
  'cloneBindingSha256',
  'sourceBindingSha256',
  'restoreRunId',
  'restoreRunAttempt',
  'restoreHelperSha256',
  'markerWriterSha256',
  'bindings',
  'authorizes',
] as const;
const bindingKeys = [
  'request',
  'backup',
  'archiveOwnershipAcl',
  'sourceStable',
  'restoredLedger',
  'cloneIdentity',
  'markerReadback',
] as const;
const authorityKeys = [
  'roleCreation',
  'roleSplit',
  'sharedDatabaseMutation',
  'migration',
  'deploy',
  'import',
  'activation',
] as const;

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const payloadLines = (
  input: CommunitiesStagingRoleSplitRestoreMarkerPayload,
): readonly string[] => [
  `requestSha256=${input.requestSha256}`,
  `restoreDatabase=${input.restoreDatabase}`,
  `cloneDatabaseOid=${input.cloneDatabaseOid}`,
  `cloneDatabaseOwner=${input.cloneDatabaseOwner}`,
  `cloneDatabaseOwnerOid=${input.cloneDatabaseOwnerOid}`,
  `sourceDatabase=${input.sourceDatabase}`,
  `sourceDatabaseOid=${input.sourceDatabaseOid}`,
  `sourceDatabaseOwner=${input.sourceDatabaseOwner}`,
  `sourceDatabaseOwnerOid=${input.sourceDatabaseOwnerOid}`,
  `systemIdentifier=${input.systemIdentifier}`,
  `backupSha256=${input.backupSha256}`,
  `backupBytes=${input.backupBytes}`,
  `backupEvidenceSha256=${input.backupEvidenceSha256}`,
  `archiveTocSha256=${input.archiveTocSha256}`,
  `sourceLedgerSha256=${input.sourceLedgerSha256}`,
  `sourceLedgerCount=${input.sourceLedgerCount}`,
  `activeRelease=${input.activeRelease}`,
  `restoreRunId=${input.restoreRunId}`,
  `restoreRunAttempt=${input.restoreRunAttempt}`,
  `postgresMajor=${input.postgresMajor}`,
  `objectManifestSha256=${input.objectManifestSha256}`,
  `restoreHelperSha256=${input.restoreHelperSha256}`,
  `markerWriterSha256=${input.markerWriterSha256}`,
];

function requestLines(input: CommunitiesStagingRoleSplitRestoreMarkerRequest): readonly string[] {
  return requestKeys.map((key) => `${key}=${input[key]}`);
}

export function assertCommunitiesStagingRoleSplitRestoreMarkerRequest(
  input: CommunitiesStagingRoleSplitRestoreMarkerRequest,
): void {
  if (!hasExactKeys(input, requestKeys))
    failCommunitiesStagingRoleSplit('RESTORE_MARKER_REQUEST_SHAPE_INVALID');
  if (
    !/^phub_restore_[0-9]+_[0-9]+$/.test(input.restoreDatabase) ||
    input.restoreDatabase !== `phub_restore_${input.restoreRunId}_${input.restoreRunAttempt}` ||
    ![input.expectedCloneDatabaseOwner, input.sourceDatabase, input.sourceDatabaseOwner].every(
      (value) => identifier.test(value),
    ) ||
    input.sourceDatabase === input.restoreDatabase ||
    ![
      input.expectedCloneDatabaseOwnerOid,
      input.sourceDatabaseOid,
      input.sourceDatabaseOwnerOid,
      input.systemIdentifier,
      input.backupBytes,
      input.sourceLedgerCount,
      input.restoreRunId,
      input.restoreRunAttempt,
    ].every((value) => positiveDecimal.test(value)) ||
    !rehearsalBackupBasename.test(input.backupBasename) ||
    input.backupEvidenceBasename !== `${input.backupBasename}.evidence` ||
    ![
      input.backupSha256,
      input.backupEvidenceSha256,
      input.archiveTocSha256,
      input.sourceLedgerSha256,
      input.objectManifestSha256,
      input.restoreHelperSha256,
      input.markerWriterSha256,
    ].every((value) => sha256.test(value)) ||
    !release.test(input.activeRelease) ||
    input.postgresMajor !== '16' ||
    input.objectManifestSha256 !== COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256
  )
    failCommunitiesStagingRoleSplit('RESTORE_MARKER_REQUEST_BINDING_INVALID');
}

export function canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest(
  input: CommunitiesStagingRoleSplitRestoreMarkerRequest,
): string {
  assertCommunitiesStagingRoleSplitRestoreMarkerRequest(input);
  return `${COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_REQUEST_VERSION}\n${requestLines(input).join('\n')}\n`;
}

export function communitiesStagingRoleSplitRestoreMarkerRequestSha256(
  input: CommunitiesStagingRoleSplitRestoreMarkerRequest,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest(input), 'utf8')
    .digest('hex');
}

export function assertCommunitiesStagingRoleSplitRestoreMarkerPayload(
  input: CommunitiesStagingRoleSplitRestoreMarkerPayload,
): void {
  if (!hasExactKeys(input, payloadKeys))
    failCommunitiesStagingRoleSplit('RESTORE_MARKER_PAYLOAD_SHAPE_INVALID');
  if (
    !/^phub_restore_[0-9]+_[0-9]+$/.test(input.restoreDatabase) ||
    input.restoreDatabase !== `phub_restore_${input.restoreRunId}_${input.restoreRunAttempt}`
  )
    failCommunitiesStagingRoleSplit('RESTORE_MARKER_DATABASE_INVALID');
  if (
    !identifier.test(input.cloneDatabaseOwner) ||
    !identifier.test(input.sourceDatabase) ||
    !identifier.test(input.sourceDatabaseOwner) ||
    input.sourceDatabase === input.restoreDatabase
  )
    failCommunitiesStagingRoleSplit('RESTORE_MARKER_IDENTIFIER_INVALID');
  if (
    ![
      input.cloneDatabaseOid,
      input.cloneDatabaseOwnerOid,
      input.sourceDatabaseOid,
      input.sourceDatabaseOwnerOid,
      input.systemIdentifier,
      input.backupBytes,
      input.restoreRunId,
      input.restoreRunAttempt,
      input.sourceLedgerCount,
    ].every((value) => positiveDecimal.test(value)) ||
    input.cloneDatabaseOid === input.sourceDatabaseOid
  )
    failCommunitiesStagingRoleSplit('RESTORE_MARKER_NUMERIC_BINDING_INVALID');
  if (
    ![
      input.requestSha256,
      input.backupSha256,
      input.backupEvidenceSha256,
      input.archiveTocSha256,
      input.sourceLedgerSha256,
      input.objectManifestSha256,
      input.restoreHelperSha256,
      input.markerWriterSha256,
    ].every((value) => sha256.test(value))
  )
    failCommunitiesStagingRoleSplit('RESTORE_MARKER_SHA256_BINDING_INVALID');
  if (!release.test(input.activeRelease) || input.postgresMajor !== '16')
    failCommunitiesStagingRoleSplit('RESTORE_MARKER_RELEASE_BINDING_INVALID');
  if (input.objectManifestSha256 !== COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256)
    failCommunitiesStagingRoleSplit('RESTORE_MARKER_MANIFEST_BINDING_INVALID');
}

export function canonicalCommunitiesStagingRoleSplitRestoreMarkerPayload(
  input: CommunitiesStagingRoleSplitRestoreMarkerPayload,
): string {
  assertCommunitiesStagingRoleSplitRestoreMarkerPayload(input);
  return `${COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_VERSION}\n${payloadLines(input).join('\n')}\n`;
}

export function communitiesStagingRoleSplitRestoreMarkerPayloadSha256(
  input: CommunitiesStagingRoleSplitRestoreMarkerPayload,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitRestoreMarkerPayload(input), 'utf8')
    .digest('hex');
}

export function communitiesStagingRoleSplitRestoreMarker(
  input: CommunitiesStagingRoleSplitRestoreMarkerPayload,
): string {
  return `${COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_PREFIX}${communitiesStagingRoleSplitRestoreMarkerPayloadSha256(input)}`;
}

export function assertCommunitiesStagingRoleSplitRestoreMarker(
  input: CommunitiesStagingRoleSplitRestoreMarkerPayload,
  marker: string,
): void {
  if (marker !== communitiesStagingRoleSplitRestoreMarker(input))
    failCommunitiesStagingRoleSplit('RESTORE_MARKER_BINDING_INVALID');
}

export function assertCommunitiesStagingRoleSplitRestoreMarkerEvidence(
  payload: CommunitiesStagingRoleSplitRestoreMarkerPayload,
  marker: string,
  evidence: CommunitiesStagingRoleSplitRestoreMarkerEvidence,
): void {
  if (
    !hasExactKeys(evidence, evidenceKeys) ||
    !isRecord(evidence.bindings) ||
    !isRecord(evidence.authorizes) ||
    !hasExactKeys(evidence.bindings, bindingKeys) ||
    !hasExactKeys(evidence.authorizes, authorityKeys)
  )
    failCommunitiesStagingRoleSplit('RESTORE_MARKER_EVIDENCE_INVALID');
  if (
    evidence.schemaVersion !== 'communities-role-split-clone-marker-evidence-v1' ||
    evidence.status !== 'MARKED'
  )
    failCommunitiesStagingRoleSplit('RESTORE_MARKER_EVIDENCE_VERSION_INVALID');
  if (
    ![
      evidence.requestSha256,
      evidence.markerPayloadSha256,
      evidence.markerValueSha256,
      evidence.backupSha256,
      evidence.sourceLedgerSha256,
      evidence.cloneBindingSha256,
      evidence.sourceBindingSha256,
      evidence.restoreHelperSha256,
      evidence.markerWriterSha256,
    ].every((value) => sha256.test(value)) ||
    !positiveDecimal.test(evidence.cloneDatabaseOid) ||
    !positiveDecimal.test(evidence.sourceLedgerCount) ||
    !positiveDecimal.test(evidence.restoreRunId) ||
    !positiveDecimal.test(evidence.restoreRunAttempt) ||
    Object.values(evidence.bindings).some((value) => value !== true) ||
    Object.values(evidence.authorizes).some((value) => value !== false)
  )
    failCommunitiesStagingRoleSplit('RESTORE_MARKER_EVIDENCE_INVALID');
  assertCommunitiesStagingRoleSplitRestoreMarker(payload, marker);
  const markerValueSha256 = createHash('sha256').update(marker, 'utf8').digest('hex');
  const cloneBindingSha256 = createHash('sha256')
    .update(`${payload.restoreDatabase}\0${payload.cloneDatabaseOid}`, 'utf8')
    .digest('hex');
  const sourceBindingSha256 = createHash('sha256')
    .update(
      `${payload.sourceDatabase}\0${payload.sourceDatabaseOid}\0${payload.systemIdentifier}`,
      'utf8',
    )
    .digest('hex');
  if (
    evidence.requestSha256 !== payload.requestSha256 ||
    evidence.markerPayloadSha256 !==
      communitiesStagingRoleSplitRestoreMarkerPayloadSha256(payload) ||
    evidence.markerValueSha256 !== markerValueSha256 ||
    evidence.backupSha256 !== payload.backupSha256 ||
    evidence.sourceLedgerSha256 !== payload.sourceLedgerSha256 ||
    evidence.sourceLedgerCount !== payload.sourceLedgerCount ||
    evidence.cloneDatabaseOid !== payload.cloneDatabaseOid ||
    evidence.cloneBindingSha256 !== cloneBindingSha256 ||
    evidence.sourceBindingSha256 !== sourceBindingSha256 ||
    evidence.restoreRunId !== payload.restoreRunId ||
    evidence.restoreRunAttempt !== payload.restoreRunAttempt ||
    evidence.restoreHelperSha256 !== payload.restoreHelperSha256 ||
    evidence.markerWriterSha256 !== payload.markerWriterSha256
  )
    failCommunitiesStagingRoleSplit('RESTORE_MARKER_EVIDENCE_BINDING_INVALID');
}

export interface CommunitiesStagingRoleSplitLedgerEntry {
  readonly filename: string;
  readonly checksum: string;
}

export function canonicalCommunitiesStagingRoleSplitLedger(
  entries: readonly CommunitiesStagingRoleSplitLedgerEntry[],
): string {
  const sorted = [...entries].sort((left, right) =>
    left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0,
  );
  if (
    sorted.length === 0 ||
    sorted.some(
      (entry, index) =>
        !/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(entry.filename) ||
        !sha256.test(entry.checksum) ||
        (index > 0 && sorted[index - 1]?.filename === entry.filename),
    )
  )
    failCommunitiesStagingRoleSplit('RESTORE_MARKER_LEDGER_INVALID');
  return `${sorted.map((entry) => `${entry.filename}|${entry.checksum}`).join('\n')}\n`;
}

export function communitiesStagingRoleSplitLedgerSha256(
  entries: readonly CommunitiesStagingRoleSplitLedgerEntry[],
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitLedger(entries), 'utf8')
    .digest('hex');
}
