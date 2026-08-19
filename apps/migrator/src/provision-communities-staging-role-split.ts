import { CommunitiesStagingRoleSplitError } from '@phub/database';
import { provisionCommunitiesStagingRoleSplitClone } from './communities-staging-role-split-provisioner.js';

const keys = [
  'DATABASE_URL',
  'COMMUNITIES_STAGING_ROLE_SPLIT_CONFIRMATION',
  'PHUB_RESTORE_DATABASE',
  'PHUB_SHARED_DATABASE',
  'PHUB_SYSTEM_IDENTIFIER',
  'COMMUNITIES_STAGING_ROLE_SPLIT_MANIFEST_SHA256',
  'DATABASE_EXECUTOR_ROLE',
  'DATABASE_EXECUTOR_ROLE_OID',
  'PHUB_CLONE_DATABASE_OWNER',
  'PHUB_SHARED_DATABASE_OWNER',
  'DATABASE_LEGACY_OWNER_ROLE',
  'DATABASE_RUNTIME_ROLE',
  'DATABASE_RUNTIME_ROLE_OID',
  'DATABASE_MIGRATOR_ROLE',
  'DATABASE_MIGRATOR_ROLE_OID',
  'PHUB_SOURCE_LEDGER_SHA256',
  'PHUB_SOURCE_LEDGER_COUNT',
  'PHUB_CLONE_SOURCE_BINDING',
  'PHUB_ROLE_SPLIT_INVENTORY_SHA256',
] as const;
if (keys.some((key) => !process.env[key])) {
  process.stderr.write('COMMUNITIES_STAGING_ROLE_SPLIT_INPUT_INVALID\n');
  process.exitCode = 1;
} else {
  try {
    await provisionCommunitiesStagingRoleSplitClone({
      connectionString: process.env.DATABASE_URL!,
      confirmation: process.env.COMMUNITIES_STAGING_ROLE_SPLIT_CONFIRMATION!,
      restoreDatabase: process.env.PHUB_RESTORE_DATABASE!,
      sharedDatabase: process.env.PHUB_SHARED_DATABASE!,
      expectedSystemIdentifier: process.env.PHUB_SYSTEM_IDENTIFIER!,
      manifestSha256: process.env.COMMUNITIES_STAGING_ROLE_SPLIT_MANIFEST_SHA256!,
      expectedExecutorRoleName: process.env.DATABASE_EXECUTOR_ROLE!,
      expectedExecutorRoleOid: process.env.DATABASE_EXECUTOR_ROLE_OID!,
      expectedCloneDatabaseOwner: process.env.PHUB_CLONE_DATABASE_OWNER!,
      expectedSharedDatabaseOwner: process.env.PHUB_SHARED_DATABASE_OWNER!,
      legacyOwnerRoleName: process.env.DATABASE_LEGACY_OWNER_ROLE!,
      runtimeRoleName: process.env.DATABASE_RUNTIME_ROLE!,
      runtimeRoleOid: process.env.DATABASE_RUNTIME_ROLE_OID!,
      migratorRoleName: process.env.DATABASE_MIGRATOR_ROLE!,
      migratorRoleOid: process.env.DATABASE_MIGRATOR_ROLE_OID!,
      sourceLedgerSha256: process.env.PHUB_SOURCE_LEDGER_SHA256!,
      sourceLedgerCount: process.env.PHUB_SOURCE_LEDGER_COUNT!,
      cloneSourceBindingMarker: process.env.PHUB_CLONE_SOURCE_BINDING!,
      expectedInventorySha256: process.env.PHUB_ROLE_SPLIT_INVENTORY_SHA256!,
    });
  } catch (error) {
    process.stderr.write(
      `${error instanceof CommunitiesStagingRoleSplitError ? error.code : 'COMMUNITIES_STAGING_ROLE_SPLIT_EXECUTION_FAILED'}\n`,
    );
    process.exitCode = 1;
  }
}
