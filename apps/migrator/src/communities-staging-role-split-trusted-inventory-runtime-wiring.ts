import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

import {
  communitiesStagingRoleSplitInventoryPreparationSha256,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationSha256,
  communitiesStagingRoleSplitTrustedInventoryConnectionDescriptorSha256,
} from '@phub/database';

import { runCommunitiesStagingRoleSplitTrustedInventoryWithSupervisedProducer } from './communities-staging-role-split-trusted-inventory-supervised-producer.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_RUNTIME_WIRING_VERSION =
  'communities-staging-role-split-trusted-inventory-runtime-wiring-v1';

type SupervisedProducerInput = Parameters<
  typeof runCommunitiesStagingRoleSplitTrustedInventoryWithSupervisedProducer
>[0];

export type CommunitiesStagingRoleSplitTrustedInventoryRuntimeWiringInput = SupervisedProducerInput;

export class CommunitiesStagingRoleSplitTrustedInventoryRuntimeWiringError extends Error {
  constructor(
    readonly code: 'CONFIG_INVALID' | 'DESCRIPTOR_INVALID' | 'RUNTIME_INVALID' | 'STATE_INVALID',
  ) {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_RUNTIME_WIRING_${code}`);
    this.name = 'CommunitiesStagingRoleSplitTrustedInventoryRuntimeWiringError';
  }
}

function fail(code: CommunitiesStagingRoleSplitTrustedInventoryRuntimeWiringError['code']): never {
  throw new CommunitiesStagingRoleSplitTrustedInventoryRuntimeWiringError(code);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function pathSha256(path: string): string {
  return sha256(`${path}\n`);
}

function canonicalPath(path: string): boolean {
  const hasControlCharacter = [...path].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || code === 0x7f;
  });
  return path.startsWith('/') && resolve(path) === path && !hasControlCharacter;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function immutableData<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function preparationPathSha256(
  input: SupervisedProducerInput,
  code: 'MARKER_REQUEST' | 'MARKER_EVIDENCE' | 'ROLE_MAPPING',
): string {
  const binding = input.preparation.inputs.find((entry) => entry.code === code);
  if (!binding) fail('CONFIG_INVALID');
  return binding.pathSha256;
}

function assertConfig(input: SupervisedProducerInput): void {
  try {
    const preparationSha256 = communitiesStagingRoleSplitInventoryPreparationSha256(
      input.preparation,
    );
    const authorizationSha256 = communitiesStagingRoleSplitTrustedInventoryAuthorizationSha256(
      input.authorization,
    );
    const connectionDescriptorSha256 =
      communitiesStagingRoleSplitTrustedInventoryConnectionDescriptorSha256(
        input.connectionDescriptor,
      );
    const paths = [
      input.outputDirectoryPath,
      input.outputArtifactPath,
      input.outputReceiptPath,
      input.evidencePaths.markerRequestPath,
      input.evidencePaths.markerEvidencePath,
      input.evidencePaths.roleMappingPath,
    ];
    if (
      paths.some((path) => !canonicalPath(path)) ||
      new Set(paths).size !== paths.length ||
      dirname(input.outputArtifactPath) !== input.outputDirectoryPath ||
      dirname(input.outputReceiptPath) !== input.outputDirectoryPath ||
      input.expectedAuthorizationSha256 !== authorizationSha256 ||
      input.authorization.candidateCommitSha !== input.preparation.candidateCommitSha ||
      input.authorization.phase !== input.preparation.phase ||
      input.authorization.preparationSha256 !== preparationSha256 ||
      input.preparationVerification.candidateCommitSha !== input.preparation.candidateCommitSha ||
      input.preparationVerification.phase !== input.preparation.phase ||
      input.preparationVerification.preparationSha256 !== preparationSha256 ||
      input.authorization.connectionDescriptorSha256 !== connectionDescriptorSha256 ||
      input.authorization.outputDirectoryPathSha256 !== pathSha256(input.outputDirectoryPath) ||
      input.authorization.outputArtifactPathSha256 !== pathSha256(input.outputArtifactPath) ||
      input.authorization.outputReceiptPathSha256 !== pathSha256(input.outputReceiptPath) ||
      preparationPathSha256(input, 'MARKER_REQUEST') !==
        pathSha256(input.evidencePaths.markerRequestPath) ||
      preparationPathSha256(input, 'MARKER_EVIDENCE') !==
        pathSha256(input.evidencePaths.markerEvidencePath) ||
      preparationPathSha256(input, 'ROLE_MAPPING') !==
        pathSha256(input.evidencePaths.roleMappingPath)
    )
      fail('CONFIG_INVALID');
  } catch (error) {
    if (error instanceof CommunitiesStagingRoleSplitTrustedInventoryRuntimeWiringError) throw error;
    fail('CONFIG_INVALID');
  }
}

function descriptorFd(input: { readonly fd: number }): number {
  if (!Number.isSafeInteger(input.fd) || input.fd < 0) fail('DESCRIPTOR_INVALID');
  return input.fd;
}

function runtimeReady(): boolean {
  return process.platform === 'linux' && process.getuid?.() === 0 && process.getgid?.() === 0;
}

export interface CommunitiesStagingRoleSplitTrustedInventoryRuntimeWiring {
  readonly version: typeof COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_RUNTIME_WIRING_VERSION;
  readonly run: () => ReturnType<
    typeof runCommunitiesStagingRoleSplitTrustedInventoryWithSupervisedProducer
  >;
}

export function createCommunitiesStagingRoleSplitTrustedInventoryRuntimeWiring(
  input: CommunitiesStagingRoleSplitTrustedInventoryRuntimeWiringInput,
): CommunitiesStagingRoleSplitTrustedInventoryRuntimeWiring {
  const credentialFd = descriptorFd(input.credentialFile);
  const producerFd = descriptorFd(input.producerFile);
  if (credentialFd === producerFd) fail('DESCRIPTOR_INVALID');

  const snapshot: SupervisedProducerInput = Object.freeze({
    preparation: immutableData(input.preparation),
    preparationVerification: immutableData(input.preparationVerification),
    authorization: immutableData(input.authorization),
    expectedAuthorizationSha256: input.expectedAuthorizationSha256,
    connectionDescriptor: immutableData(input.connectionDescriptor),
    outputDirectoryPath: input.outputDirectoryPath,
    outputArtifactPath: input.outputArtifactPath,
    outputReceiptPath: input.outputReceiptPath,
    credentialFile: input.credentialFile,
    producerFile: input.producerFile,
    evidencePaths: immutableData(input.evidencePaths),
  });
  assertConfig(snapshot);

  let state: 'READY' | 'RUNNING' | 'FINISHED' = 'READY';
  return Object.freeze({
    version: COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_RUNTIME_WIRING_VERSION,
    run: async () => {
      if (state !== 'READY') fail('STATE_INVALID');
      state = 'RUNNING';
      try {
        if (!runtimeReady()) fail('RUNTIME_INVALID');
        if (
          descriptorFd(snapshot.credentialFile) !== credentialFd ||
          descriptorFd(snapshot.producerFile) !== producerFd
        )
          fail('DESCRIPTOR_INVALID');
        return await runCommunitiesStagingRoleSplitTrustedInventoryWithSupervisedProducer(snapshot);
      } finally {
        state = 'FINISHED';
      }
    },
  });
}
