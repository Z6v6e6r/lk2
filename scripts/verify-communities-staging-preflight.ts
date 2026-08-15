import { readFile } from 'node:fs/promises';

import {
  loadPackagedMigrationLedger,
  parseCommunitiesStagingEvidence,
  verifyCommunitiesStagingEvidence,
} from './communities-staging-preflight-support.js';

const evidenceFile = process.env.COMMUNITIES_STAGING_EVIDENCE_FILE;
const candidateRelease = process.env.COMMUNITIES_STAGING_CANDIDATE_RELEASE;
const expectedRemoteScriptSha = process.env.COMMUNITIES_STAGING_EXPECTED_REMOTE_SCRIPT_SHA;
const expectedBackupScriptSha = process.env.COMMUNITIES_STAGING_EXPECTED_BACKUP_SCRIPT_SHA;
const expectedRestoreHelperSha = process.env.COMMUNITIES_STAGING_EXPECTED_RESTORE_HELPER_SHA;
const expectedTargetDatabase = process.env.COMMUNITIES_STAGING_EXPECTED_DATABASE;
const expectedSystemIdentifier = process.env.COMMUNITIES_STAGING_EXPECTED_SYSTEM_IDENTIFIER;
if (!evidenceFile) throw new Error('COMMUNITIES_STAGING_EVIDENCE_FILE is required');
if (!candidateRelease) throw new Error('COMMUNITIES_STAGING_CANDIDATE_RELEASE is required');
if (!expectedRemoteScriptSha) {
  throw new Error('COMMUNITIES_STAGING_EXPECTED_REMOTE_SCRIPT_SHA is required');
}
if (!expectedBackupScriptSha) {
  throw new Error('COMMUNITIES_STAGING_EXPECTED_BACKUP_SCRIPT_SHA is required');
}
if (!expectedRestoreHelperSha) {
  throw new Error('COMMUNITIES_STAGING_EXPECTED_RESTORE_HELPER_SHA is required');
}
if (!expectedTargetDatabase) throw new Error('COMMUNITIES_STAGING_EXPECTED_DATABASE is required');
if (!expectedSystemIdentifier) {
  throw new Error('COMMUNITIES_STAGING_EXPECTED_SYSTEM_IDENTIFIER is required');
}

const [rawEvidence, packaged] = await Promise.all([
  readFile(evidenceFile, 'utf8'),
  loadPackagedMigrationLedger(),
]);
const report = verifyCommunitiesStagingEvidence({
  candidateRelease,
  expectedRemoteScriptSha,
  expectedBackupScriptSha,
  expectedRestoreHelperSha,
  expectedTargetDatabase,
  expectedSystemIdentifier,
  evidence: parseCommunitiesStagingEvidence(rawEvidence),
  packaged,
});
process.stdout.write(`${JSON.stringify(report)}\n`);
