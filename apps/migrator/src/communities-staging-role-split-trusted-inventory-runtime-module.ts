import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export {
  COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_RUNTIME_WIRING_VERSION,
  CommunitiesStagingRoleSplitTrustedInventoryRuntimeWiringError,
  createCommunitiesStagingRoleSplitTrustedInventoryRuntimeWiring,
  type CommunitiesStagingRoleSplitTrustedInventoryRuntimeWiring,
  type CommunitiesStagingRoleSplitTrustedInventoryRuntimeWiringInput,
} from './communities-staging-role-split-trusted-inventory-runtime-wiring.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_RUNTIME_MODULE_VERSION =
  'communities-staging-role-split-trusted-inventory-runtime-module-v1';

function isDirectInvocation(): boolean {
  const entrypoint = process.argv[1];
  return typeof entrypoint === 'string' && fileURLToPath(import.meta.url) === resolve(entrypoint);
}

if (isDirectInvocation()) {
  process.stderr.write('COMMUNITIES_ROLE_SPLIT_EXECUTION_NOT_AUTHORIZED\n');
  process.exitCode = 78;
}
