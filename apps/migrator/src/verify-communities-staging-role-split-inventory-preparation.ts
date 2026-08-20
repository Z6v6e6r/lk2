import {
  COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INPUT_CODES,
  communitiesStagingRoleSplitInventoryPreparationSha256,
  parseCommunitiesStagingRoleSplitInventoryPreparation,
  type CommunitiesStagingRoleSplitInventoryPreparationInputCode,
} from '@phub/database';
import { isAbsolute, resolve } from 'node:path';

import {
  communitiesStagingRoleSplitInventoryPreparationVerificationText,
  verifyCommunitiesStagingRoleSplitInventoryPreparation,
} from './communities-staging-role-split-inventory-preparation.js';
import { readRootOwnedEvidence } from './root-owned-evidence.js';

const MAXIMUM_PREPARATION_BYTES = 128 * 1024;
const MAXIMUM_CANONICAL_INPUT_BYTES = 64 * 1024;
const MAXIMUM_EXTERNAL_EVIDENCE_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const argumentSpecs = [
  ['--preparation', 'PREPARATION'],
  ['--preparation-sha256', 'PREPARATION_SHA256'],
  ['--marker-request', 'MARKER_REQUEST'],
  ['--marker-evidence', 'MARKER_EVIDENCE'],
  ['--role-mapping', 'ROLE_MAPPING'],
  ['--independent-source-provenance', 'INDEPENDENT_SOURCE_PROVENANCE'],
  ['--connection-descriptor', 'CONNECTION_DESCRIPTOR'],
  ['--credential-custody', 'CREDENTIAL_CUSTODY'],
  ['--executable-custody', 'EXECUTABLE_CUSTODY'],
  ['--output-custody', 'OUTPUT_CUSTODY'],
  ['--output-artifact', 'OUTPUT_ARTIFACT'],
] as const;

function maximumBytes(code: CommunitiesStagingRoleSplitInventoryPreparationInputCode): number {
  return ['MARKER_REQUEST', 'MARKER_EVIDENCE', 'ROLE_MAPPING'].includes(code)
    ? MAXIMUM_CANONICAL_INPUT_BYTES
    : MAXIMUM_EXTERNAL_EVIDENCE_BYTES;
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (
    arguments_.length !== argumentSpecs.length * 2 ||
    argumentSpecs.some(([flag], index) => arguments_[index * 2] !== flag) ||
    argumentSpecs.some((_, index) => !arguments_[index * 2 + 1])
  )
    throw new Error('INPUT_INVALID');
  const values = Object.fromEntries(
    argumentSpecs.map(([, code], index) => [code, arguments_[index * 2 + 1]!]),
  ) as Record<(typeof argumentSpecs)[number][1], string>;
  const paths = argumentSpecs
    .map(([, code]) => code)
    .filter((code) => code !== 'PREPARATION_SHA256')
    .map((code) => values[code]);
  if (
    !SHA256_PATTERN.test(values.PREPARATION_SHA256) ||
    paths.some((path) => !isAbsolute(path) || resolve(path) !== path) ||
    new Set(paths).size !== paths.length
  )
    throw new Error('INPUT_INVALID');
  const preparationBytes = await readRootOwnedEvidence(
    values.PREPARATION,
    MAXIMUM_PREPARATION_BYTES,
  );
  const preparation = parseCommunitiesStagingRoleSplitInventoryPreparation(
    preparationBytes.toString('utf8'),
  );
  if (
    communitiesStagingRoleSplitInventoryPreparationSha256(preparation) !== values.PREPARATION_SHA256
  )
    throw new Error('INPUT_INVALID');
  const evidence = {} as Record<
    CommunitiesStagingRoleSplitInventoryPreparationInputCode,
    { path: string; bytes: Buffer }
  >;
  for (const code of COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INPUT_CODES) {
    const path = values[code];
    evidence[code] = {
      path,
      bytes: await readRootOwnedEvidence(path, maximumBytes(code)),
    };
  }
  process.stdout.write(
    communitiesStagingRoleSplitInventoryPreparationVerificationText(
      verifyCommunitiesStagingRoleSplitInventoryPreparation({
        preparationPath: values.PREPARATION,
        preparationBytes,
        expectedPreparationSha256: values.PREPARATION_SHA256,
        evidence,
        outputArtifactPath: values.OUTPUT_ARTIFACT,
      }),
    ),
  );
}

try {
  await main();
} catch {
  process.stderr.write('COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INVALID\n');
  process.exitCode = 1;
}
