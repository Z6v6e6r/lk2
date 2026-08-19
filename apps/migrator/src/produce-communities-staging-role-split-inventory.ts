import { isAbsolute } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';

import {
  CommunitiesStagingRoleSplitInventoryError,
  produceCommunitiesStagingRoleSplitInventory,
} from './communities-staging-role-split-inventory.js';

const requiredEnvironment = [
  'DATABASE_URL',
  'COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CONFIRMATION',
  'PHUB_ROLE_SPLIT_MARKER_REQUEST_PATH',
  'PHUB_ROLE_SPLIT_MARKER_REQUEST_SHA256',
  'PHUB_ROLE_SPLIT_MARKER_EVIDENCE_PATH',
  'PHUB_ROLE_SPLIT_MARKER_EVIDENCE_SHA256',
  'PHUB_ROLE_SPLIT_ROLE_MAPPING_PATH',
  'PHUB_ROLE_SPLIT_ROLE_MAPPING_SHA256',
] as const;

async function readRootOwnedEvidence(path: string, maximumBytes: number): Promise<Buffer> {
  if (!isAbsolute(path)) throw new Error('INPUT_CUSTODY_INVALID');
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o022) !== 0 ||
    metadata.size < 1 ||
    metadata.size > maximumBytes
  )
    throw new Error('INPUT_CUSTODY_INVALID');
  return readFile(path);
}

async function main(): Promise<void> {
  if (requiredEnvironment.some((key) => !process.env[key])) throw new Error('INPUT_INVALID');
  const requestBytes = await readRootOwnedEvidence(
    process.env.PHUB_ROLE_SPLIT_MARKER_REQUEST_PATH!,
    64 * 1024,
  );
  const evidenceBytes = await readRootOwnedEvidence(
    process.env.PHUB_ROLE_SPLIT_MARKER_EVIDENCE_PATH!,
    64 * 1024,
  );
  const mappingBytes = await readRootOwnedEvidence(
    process.env.PHUB_ROLE_SPLIT_ROLE_MAPPING_PATH!,
    64 * 1024,
  );
  const report = await produceCommunitiesStagingRoleSplitInventory({
    confirmation: process.env.COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CONFIRMATION!,
    connectionString: process.env.DATABASE_URL!,
    requestText: requestBytes.toString('utf8'),
    expectedRequestSha256: process.env.PHUB_ROLE_SPLIT_MARKER_REQUEST_SHA256!,
    markerEvidenceText: evidenceBytes.toString('utf8'),
    expectedMarkerEvidenceSha256: process.env.PHUB_ROLE_SPLIT_MARKER_EVIDENCE_SHA256!,
    roleMappingText: mappingBytes.toString('utf8'),
    expectedRoleMappingSha256: process.env.PHUB_ROLE_SPLIT_ROLE_MAPPING_SHA256!,
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

try {
  await main();
} catch (error) {
  const code =
    error instanceof CommunitiesStagingRoleSplitInventoryError
      ? error.code
      : error instanceof Error && ['INPUT_INVALID', 'INPUT_CUSTODY_INVALID'].includes(error.message)
        ? `COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_${error.message}`
        : 'COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_EXECUTION_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
