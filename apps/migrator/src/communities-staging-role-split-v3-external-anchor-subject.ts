import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXTERNAL_PHASE_ANCHOR_VERSION,
  CommunitiesStagingRoleSplitV3FileExternalPhaseAnchor,
} from './communities-staging-role-split-v3-external-phase-anchor.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXTERNAL_ANCHOR_SUBJECT_VERSION =
  'communities-staging-role-split-v3-external-anchor-subject-v1';

export interface CommunitiesStagingRoleSplitV3ExternalAnchorSubject {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXTERNAL_ANCHOR_SUBJECT_VERSION;
  readonly candidateCommit: string;
  readonly purpose: 'PRODUCTION' | 'REHEARSAL';
  readonly providerVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXTERNAL_PHASE_ANCHOR_VERSION;
  readonly processOwner: string;
  readonly processUid: number;
  readonly processGid: number;
  readonly anchorDirectory: string;
  readonly stateDirectory: string;
  readonly backupDirectory: string;
  readonly anchorParentUid: number;
  readonly anchorParentGid: number;
  readonly anchorParentMode: 448 | 493;
  readonly anchorDirectoryMode: 448;
  readonly stateDirectoryMode: 448;
  readonly backupDirectoryUid: number;
  readonly backupDirectoryGid: number;
  readonly backupDirectoryMode: 448 | 488;
  readonly targetFilesystem: 'LINUX_LOCAL';
  readonly crashDomain: 'SUPERVISED_WORKER_PROCESS';
  readonly authorizesLeaseRemoval: false;
  readonly authorizesCeremony: false;
  readonly authorizesDatabaseMutation: false;
  readonly authorizesProductionActivation: false;
}

const sha1 = /^[a-f0-9]{40}$/u;
const exactKeys = [
  'schemaVersion',
  'candidateCommit',
  'purpose',
  'providerVersion',
  'processOwner',
  'processUid',
  'processGid',
  'anchorDirectory',
  'stateDirectory',
  'backupDirectory',
  'anchorParentUid',
  'anchorParentGid',
  'anchorParentMode',
  'anchorDirectoryMode',
  'stateDirectoryMode',
  'backupDirectoryUid',
  'backupDirectoryGid',
  'backupDirectoryMode',
  'targetFilesystem',
  'crashDomain',
  'authorizesLeaseRemoval',
  'authorizesCeremony',
  'authorizesDatabaseMutation',
  'authorizesProductionActivation',
] as const;

export class CommunitiesStagingRoleSplitV3ExternalAnchorSubjectError extends Error {
  constructor(
    readonly code:
      | 'SHAPE_INVALID'
      | 'PATH_INVALID'
      | 'CANONICAL_ENCODING_INVALID'
      | 'DIGEST_MISMATCH'
      | 'RUNTIME_CUSTODY_INVALID',
  ) {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXTERNAL_ANCHOR_SUBJECT_${code}`);
    this.name = 'CommunitiesStagingRoleSplitV3ExternalAnchorSubjectError';
  }
}

function fail(code: CommunitiesStagingRoleSplitV3ExternalAnchorSubjectError['code']): never {
  throw new CommunitiesStagingRoleSplitV3ExternalAnchorSubjectError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathsOverlap(left: string, right: string): boolean {
  const within = (parent: string, child: string): boolean => {
    const value = relative(parent, child);
    return value === '' || (!value.startsWith('..') && !isAbsolute(value));
  };
  return within(left, right) || within(right, left);
}

export function assertCommunitiesStagingRoleSplitV3ExternalAnchorSubject(
  value: CommunitiesStagingRoleSplitV3ExternalAnchorSubject,
): void {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== exactKeys.length ||
    !exactKeys.every((key) => Object.hasOwn(value, key)) ||
    value.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXTERNAL_ANCHOR_SUBJECT_VERSION ||
    !sha1.test(value.candidateCommit) ||
    !['PRODUCTION', 'REHEARSAL'].includes(value.purpose) ||
    value.providerVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXTERNAL_PHASE_ANCHOR_VERSION ||
    !/^[a-z_][a-z0-9_-]{0,31}$/u.test(value.processOwner) ||
    !Number.isSafeInteger(value.processUid) ||
    value.processUid < 0 ||
    !Number.isSafeInteger(value.processGid) ||
    value.processGid < 0 ||
    !Number.isSafeInteger(value.anchorParentUid) ||
    value.anchorParentUid < 0 ||
    !Number.isSafeInteger(value.anchorParentGid) ||
    value.anchorParentGid < 0 ||
    ![0o700, 0o755].includes(value.anchorParentMode) ||
    value.anchorDirectoryMode !== 0o700 ||
    value.stateDirectoryMode !== 0o700 ||
    !Number.isSafeInteger(value.backupDirectoryUid) ||
    value.backupDirectoryUid < 0 ||
    !Number.isSafeInteger(value.backupDirectoryGid) ||
    value.backupDirectoryGid < 0 ||
    ![0o700, 0o750].includes(value.backupDirectoryMode) ||
    value.targetFilesystem !== 'LINUX_LOCAL' ||
    value.crashDomain !== 'SUPERVISED_WORKER_PROCESS' ||
    value.authorizesLeaseRemoval !== false ||
    value.authorizesCeremony !== false ||
    value.authorizesDatabaseMutation !== false ||
    value.authorizesProductionActivation !== false
  )
    fail('SHAPE_INVALID');

  const paths = [value.anchorDirectory, value.stateDirectory, value.backupDirectory];
  if (
    !paths.every((path) => isAbsolute(path) && resolve(path) === path) ||
    pathsOverlap(value.anchorDirectory, value.stateDirectory) ||
    pathsOverlap(value.anchorDirectory, value.backupDirectory) ||
    pathsOverlap(value.stateDirectory, value.backupDirectory)
  )
    fail('PATH_INVALID');
}

export function canonicalCommunitiesStagingRoleSplitV3ExternalAnchorSubject(
  value: CommunitiesStagingRoleSplitV3ExternalAnchorSubject,
): string {
  assertCommunitiesStagingRoleSplitV3ExternalAnchorSubject(value);
  return `${JSON.stringify({
    schemaVersion: value.schemaVersion,
    candidateCommit: value.candidateCommit,
    purpose: value.purpose,
    providerVersion: value.providerVersion,
    processOwner: value.processOwner,
    processUid: value.processUid,
    processGid: value.processGid,
    anchorDirectory: value.anchorDirectory,
    stateDirectory: value.stateDirectory,
    backupDirectory: value.backupDirectory,
    anchorParentUid: value.anchorParentUid,
    anchorParentGid: value.anchorParentGid,
    anchorParentMode: value.anchorParentMode,
    anchorDirectoryMode: value.anchorDirectoryMode,
    stateDirectoryMode: value.stateDirectoryMode,
    backupDirectoryUid: value.backupDirectoryUid,
    backupDirectoryGid: value.backupDirectoryGid,
    backupDirectoryMode: value.backupDirectoryMode,
    targetFilesystem: value.targetFilesystem,
    crashDomain: value.crashDomain,
    authorizesLeaseRemoval: value.authorizesLeaseRemoval,
    authorizesCeremony: value.authorizesCeremony,
    authorizesDatabaseMutation: value.authorizesDatabaseMutation,
    authorizesProductionActivation: value.authorizesProductionActivation,
  })}\n`;
}

export function communitiesStagingRoleSplitV3ExternalAnchorSubjectSha256(
  value: CommunitiesStagingRoleSplitV3ExternalAnchorSubject,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitV3ExternalAnchorSubject(value), 'utf8')
    .digest('hex');
}

export function parseCommunitiesStagingRoleSplitV3ExternalAnchorSubject(
  bytes: string,
  expectedSha256: string,
): CommunitiesStagingRoleSplitV3ExternalAnchorSubject {
  let value: CommunitiesStagingRoleSplitV3ExternalAnchorSubject;
  try {
    value = JSON.parse(bytes) as CommunitiesStagingRoleSplitV3ExternalAnchorSubject;
    assertCommunitiesStagingRoleSplitV3ExternalAnchorSubject(value);
  } catch (error) {
    if (error instanceof CommunitiesStagingRoleSplitV3ExternalAnchorSubjectError) throw error;
    fail('SHAPE_INVALID');
  }
  if (canonicalCommunitiesStagingRoleSplitV3ExternalAnchorSubject(value) !== bytes)
    fail('CANONICAL_ENCODING_INVALID');
  if (communitiesStagingRoleSplitV3ExternalAnchorSubjectSha256(value) !== expectedSha256)
    fail('DIGEST_MISMATCH');
  return Object.freeze(value);
}

export async function assertCommunitiesStagingRoleSplitV3ExternalAnchorRuntimeCustody(
  value: CommunitiesStagingRoleSplitV3ExternalAnchorSubject,
): Promise<void> {
  assertCommunitiesStagingRoleSplitV3ExternalAnchorSubject(value);
  if (process.getuid?.() !== value.processUid || process.getgid?.() !== value.processGid)
    fail('RUNTIME_CUSTODY_INVALID');
  try {
    const [anchor, state, backup, parent, anchorReal, stateReal, backupReal] = await Promise.all([
      lstat(value.anchorDirectory),
      lstat(value.stateDirectory),
      lstat(value.backupDirectory),
      lstat(dirname(value.anchorDirectory)),
      realpath(value.anchorDirectory),
      realpath(value.stateDirectory),
      realpath(value.backupDirectory),
    ]);
    const privateDirectory = (
      stat: Awaited<ReturnType<typeof lstat>>,
      uid: number,
      gid: number,
      mode: number,
    ): boolean =>
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === uid &&
      stat.gid === gid &&
      (Number(stat.mode) & 0o777) === mode;
    if (
      !privateDirectory(anchor, value.processUid, value.processGid, value.anchorDirectoryMode) ||
      !privateDirectory(state, value.processUid, value.processGid, value.stateDirectoryMode) ||
      !privateDirectory(
        backup,
        value.backupDirectoryUid,
        value.backupDirectoryGid,
        value.backupDirectoryMode,
      ) ||
      !privateDirectory(
        parent,
        value.anchorParentUid,
        value.anchorParentGid,
        value.anchorParentMode,
      ) ||
      anchorReal !== value.anchorDirectory ||
      stateReal !== value.stateDirectory ||
      backupReal !== value.backupDirectory
    )
      fail('RUNTIME_CUSTODY_INVALID');
  } catch (error) {
    if (error instanceof CommunitiesStagingRoleSplitV3ExternalAnchorSubjectError) throw error;
    fail('RUNTIME_CUSTODY_INVALID');
  }
}

export async function createCommunitiesStagingRoleSplitV3CustodyBoundFileExternalPhaseAnchor(
  subject: CommunitiesStagingRoleSplitV3ExternalAnchorSubject,
  requestSha256: string,
  creationReceiptSha256: string,
): Promise<CommunitiesStagingRoleSplitV3FileExternalPhaseAnchor> {
  await assertCommunitiesStagingRoleSplitV3ExternalAnchorRuntimeCustody(subject);
  return new CommunitiesStagingRoleSplitV3FileExternalPhaseAnchor(
    communitiesStagingRoleSplitV3ExternalAnchorSubjectSha256(subject),
    subject.anchorDirectory,
    requestSha256,
    creationReceiptSha256,
  );
}
