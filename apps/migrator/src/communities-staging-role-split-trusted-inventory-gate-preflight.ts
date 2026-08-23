import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

import {
  communitiesStagingRoleSplitTrustedInventoryGateSha256,
  parseCommunitiesStagingRoleSplitTrustedInventoryGate,
} from '../../../packages/database/src/communities-staging-role-split-trusted-inventory-gate.js';
import { communitiesRoleSplitCanonicalJson } from '../../../packages/database/src/communities-role-split-input-c.js';
import { parseCommunitiesStagingRoleSplitInventoryPreparation } from '../../../packages/database/src/communities-staging-role-split-inventory-preparation.js';
import { parseCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor } from '../../../packages/database/src/communities-staging-role-split-trusted-inventory.js';
import type { CommunitiesStagingRoleSplitInventoryPreparationVerification } from './communities-staging-role-split-inventory-preparation.js';
import {
  communitiesStagingRoleSplitTrustedInventoryGateVerificationText,
  verifyCommunitiesStagingRoleSplitTrustedInventoryGate,
} from './communities-staging-role-split-trusted-inventory-gate.js';
import { readRootOwnedEvidence } from './root-owned-evidence.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const MAXIMUM_GATE_BYTES = 128 * 1024;
const MAXIMUM_PREPARATION_BYTES = 128 * 1024;
const MAXIMUM_PREPARATION_VERIFICATION_BYTES = 128 * 1024;
const MAXIMUM_CONNECTION_DESCRIPTOR_BYTES = 64 * 1024;

const argumentSpecs = [
  ['--gate', 'GATE'],
  ['--gate-sha256', 'GATE_SHA256'],
  ['--preparation', 'PREPARATION'],
  ['--preparation-verification', 'PREPARATION_VERIFICATION'],
  ['--connection-descriptor', 'CONNECTION_DESCRIPTOR'],
  ['--credential-descriptor', 'CREDENTIAL_DESCRIPTOR'],
  ['--producer-descriptor', 'PRODUCER_DESCRIPTOR'],
  ['--output-directory', 'OUTPUT_DIRECTORY'],
  ['--output-artifact', 'OUTPUT_ARTIFACT'],
  ['--output-receipt', 'OUTPUT_RECEIPT'],
  ['--marker-request', 'MARKER_REQUEST'],
  ['--marker-evidence', 'MARKER_EVIDENCE'],
  ['--role-mapping', 'ROLE_MAPPING'],
] as const;

type ArgumentCode = (typeof argumentSpecs)[number][1];

export type CommunitiesStagingRoleSplitTrustedInventoryGatePreflightIo = {
  readonly readRootOwnedEvidence: (path: string, maximumBytes: number) => Promise<Buffer>;
};

const defaultIo: CommunitiesStagingRoleSplitTrustedInventoryGatePreflightIo = {
  readRootOwnedEvidence,
};

function fail(): never {
  throw new Error('COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_GATE_PREFLIGHT_INVALID');
}

function canonicalAbsolutePath(path: string): boolean {
  return (
    typeof path === 'string' &&
    isAbsolute(path) &&
    resolve(path) === path &&
    ![...path].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    })
  );
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parsePreparationVerification(
  bytes: Buffer,
): CommunitiesStagingRoleSplitInventoryPreparationVerification {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail();
  }
  if (`${communitiesRoleSplitCanonicalJson(value)}\n` !== text) fail();
  return value as CommunitiesStagingRoleSplitInventoryPreparationVerification;
}

function parseArguments(arguments_: readonly string[]): Record<ArgumentCode, string> {
  if (
    arguments_.length !== argumentSpecs.length * 2 ||
    argumentSpecs.some(([flag], index) => arguments_[index * 2] !== flag) ||
    argumentSpecs.some((_, index) => !arguments_[index * 2 + 1])
  )
    fail();
  return Object.fromEntries(
    argumentSpecs.map(([, code], index) => [code, arguments_[index * 2 + 1]!]),
  ) as Record<ArgumentCode, string>;
}

export async function runCommunitiesStagingRoleSplitTrustedInventoryGatePreflight(
  arguments_: readonly string[],
  io: CommunitiesStagingRoleSplitTrustedInventoryGatePreflightIo = defaultIo,
): Promise<string> {
  try {
    const values = parseArguments(arguments_);
    const paths = argumentSpecs
      .map(([, code]) => code)
      .filter((code) => code !== 'GATE_SHA256')
      .map((code) => values[code]);
    if (
      !SHA256.test(values.GATE_SHA256) ||
      paths.some((path) => !canonicalAbsolutePath(path)) ||
      new Set(paths).size !== paths.length
    )
      fail();

    const gateBytes = await io.readRootOwnedEvidence(values.GATE, MAXIMUM_GATE_BYTES);
    const gate = parseCommunitiesStagingRoleSplitTrustedInventoryGate(gateBytes.toString('utf8'));
    if (
      sha256(gateBytes) !== values.GATE_SHA256 ||
      communitiesStagingRoleSplitTrustedInventoryGateSha256(gate) !== values.GATE_SHA256
    )
      fail();

    const preparationBytes = await io.readRootOwnedEvidence(
      values.PREPARATION,
      MAXIMUM_PREPARATION_BYTES,
    );
    const preparation = parseCommunitiesStagingRoleSplitInventoryPreparation(
      preparationBytes.toString('utf8'),
    );
    if (sha256(preparationBytes) !== gate.preparationSha256) fail();
    const preparationVerificationBytes = await io.readRootOwnedEvidence(
      values.PREPARATION_VERIFICATION,
      MAXIMUM_PREPARATION_VERIFICATION_BYTES,
    );
    const preparationVerification = parsePreparationVerification(preparationVerificationBytes);
    if (sha256(preparationVerificationBytes) !== gate.preparationVerificationSha256) fail();
    const connectionDescriptorBytes = await io.readRootOwnedEvidence(
      values.CONNECTION_DESCRIPTOR,
      MAXIMUM_CONNECTION_DESCRIPTOR_BYTES,
    );
    const connectionDescriptor =
      parseCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor(
        connectionDescriptorBytes.toString('utf8'),
      );
    const connectionInput = preparation.inputs.find(
      (entry) => entry.code === 'CONNECTION_DESCRIPTOR',
    );
    if (
      !connectionInput ||
      sha256(connectionDescriptorBytes) !== gate.connectionDescriptorSha256 ||
      connectionInput.contentSha256 !== gate.connectionDescriptorSha256 ||
      connectionInput.pathSha256 !== sha256(`${values.CONNECTION_DESCRIPTOR}\n`)
    )
      fail();

    return communitiesStagingRoleSplitTrustedInventoryGateVerificationText(
      verifyCommunitiesStagingRoleSplitTrustedInventoryGate({
        gate,
        expectedGateSha256: values.GATE_SHA256,
        preparation,
        preparationVerification,
        connectionDescriptor,
        paths: {
          credentialDescriptorPath: values.CREDENTIAL_DESCRIPTOR,
          producerDescriptorPath: values.PRODUCER_DESCRIPTOR,
          outputDirectoryPath: values.OUTPUT_DIRECTORY,
          outputArtifactPath: values.OUTPUT_ARTIFACT,
          outputReceiptPath: values.OUTPUT_RECEIPT,
          markerRequestPath: values.MARKER_REQUEST,
          markerEvidencePath: values.MARKER_EVIDENCE,
          roleMappingPath: values.ROLE_MAPPING,
        },
      }),
    );
  } catch {
    fail();
  }
}
