import { createHash } from 'node:crypto';

export const COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_CONTRACT_VERSION =
  'communities-staging-role-split-clone-v1';
export const COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_CONFIRMATION =
  'PREPARE_COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_V1';

/** Redacted clone evidence scope, not an executable role/ACL plan. */
export const COMMUNITIES_STAGING_ROLE_SPLIT_OBJECT_MANIFEST = [
  ['schema', 'community_content', 'absent-before-0063'],
  ['schema', 'eligibility', 'absent-before-0084'],
  ['schema', 'communities', 'existing-create'],
  ['schema', 'games', 'existing-create'],
  ['schema', 'identity', 'existing-usage'],
  ['schema', 'integration', 'existing-create'],
  ['schema', 'messaging', 'existing-create'],
  ['schema', 'notifications', 'existing-create'],
  ['schema', 'profile', 'existing-usage'],
  ['schema', 'public', 'existing-usage'],
  ['extension', 'pg_trgm', 'required-by-0056'],
  ['table', 'public.schema_migrations', 'ledger'],
  ['table', 'profile.privacy_settings', 'alter-0053'],
  ['table', 'profile.privacy_commands', 'preexisting'],
  ['table', 'profile.user_summaries', 'preexisting'],
  ['table', 'communities.communities', 'alter-0055'],
  ['table', 'communities.memberships', 'alter-0054'],
  ['table', 'integration.notification_endpoints', 'alter-0070'],
  ['table', 'integration.external_entity_map', 'preexisting'],
  ['table', 'integration.user_profile_photo_sync', 'alter-0079'],
  ['table', 'integration.community_logo_sync', 'alter-0080'],
  ['table', 'identity.tenants', 'foreign-key-dependency'],
  ['table', 'identity.users', 'foreign-key-dependency'],
  ['table', 'messaging.conversations', 'preexisting'],
  ['table', 'messaging.tenant_runtime_settings', 'preexisting-0043'],
  ['table', 'messaging.direct_conversation_commands', 'preexisting-0043'],
  ['table', 'messaging.read_cursor_commands', 'preexisting-0043'],
  ['table', 'notifications.tenant_runtime_settings', 'alter-0073'],
  ['table', 'games.games', 'alter-0084'],
  ['table', 'games.participations', 'alter-0084'],
  ['table', 'games.seat_reservations', 'alter-0084'],
  ['table', 'games.waitlist_entries', 'alter-0084'],
  ['catalog', 'database-acl-default-acl', 'inventory-only'],
  ['catalog', 'relation-column-acl-rls-policy', 'inventory-only'],
  ['catalog', 'sequences-functions-types', 'inventory-only'],
] as const;

export const COMMUNITIES_STAGING_ROLE_SPLIT_INITIAL_PREEXISTING_RELATIONS =
  COMMUNITIES_STAGING_ROLE_SPLIT_OBJECT_MANIFEST.filter((entry) => entry[0] === 'table').map(
    (entry) => entry[1],
  );

export const COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256 = createHash('sha256')
  .update(
    `${COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_CONTRACT_VERSION}\n${COMMUNITIES_STAGING_ROLE_SPLIT_OBJECT_MANIFEST.map((entry) => entry.join('|')).join('\n')}\n`,
  )
  .digest('hex');
export function communitiesStagingRoleSplitInventorySha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class CommunitiesStagingRoleSplitError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CommunitiesStagingRoleSplitError';
  }
}
export function failCommunitiesStagingRoleSplit(code: string): never {
  throw new CommunitiesStagingRoleSplitError(`COMMUNITIES_STAGING_ROLE_SPLIT_${code}`);
}

export interface CommunitiesStagingRoleSplitCloneRequest {
  readonly confirmation: string;
  readonly restoreDatabase: string;
  readonly sharedDatabase: string;
  readonly expectedSystemIdentifier: string;
  readonly manifestSha256: string;
  readonly expectedExecutorRoleName: string;
  readonly expectedExecutorRoleOid: string;
  readonly expectedCloneDatabaseOwner: string;
  readonly expectedSharedDatabaseOwner: string;
  readonly legacyOwnerRoleName: string;
  readonly runtimeRoleName: string;
  readonly runtimeRoleOid: string;
  readonly migratorRoleName: string;
  readonly migratorRoleOid: string;
  readonly sourceLedgerSha256: string;
  readonly sourceLedgerCount: string;
  readonly cloneSourceBindingMarker: string;
  readonly expectedInventorySha256: string;
}
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const hex = /^[a-f0-9]{64}$/;
export function assertCommunitiesStagingRoleSplitCloneRequest(
  input: CommunitiesStagingRoleSplitCloneRequest,
): void {
  if (input.confirmation !== COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_CONFIRMATION)
    failCommunitiesStagingRoleSplit('CONFIRMATION_INVALID');
  if (!/^phub_restore_[0-9]+_[0-9]+$/.test(input.restoreDatabase))
    failCommunitiesStagingRoleSplit('RESTORE_DATABASE_INVALID');
  if (!identifier.test(input.sharedDatabase) || input.sharedDatabase === input.restoreDatabase)
    failCommunitiesStagingRoleSplit('SHARED_DATABASE_INVALID');
  if (!/^\d+$/.test(input.expectedSystemIdentifier))
    failCommunitiesStagingRoleSplit('SYSTEM_IDENTIFIER_INVALID');
  if (input.manifestSha256 !== COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256)
    failCommunitiesStagingRoleSplit('MANIFEST_BINDING_INVALID');
  for (const value of [
    input.expectedExecutorRoleName,
    input.expectedCloneDatabaseOwner,
    input.expectedSharedDatabaseOwner,
    input.legacyOwnerRoleName,
    input.runtimeRoleName,
    input.migratorRoleName,
  ])
    if (!identifier.test(value)) failCommunitiesStagingRoleSplit('ROLE_NAME_INVALID');
  if (
    input.runtimeRoleName === input.migratorRoleName ||
    input.runtimeRoleOid === input.migratorRoleOid
  )
    failCommunitiesStagingRoleSplit('ROLES_NOT_DISTINCT');
  if (
    ![
      input.expectedExecutorRoleOid,
      input.runtimeRoleOid,
      input.migratorRoleOid,
      input.sourceLedgerCount,
    ].every((value) => /^\d+$/.test(value))
  )
    failCommunitiesStagingRoleSplit('NUMERIC_BINDING_INVALID');
  if (![input.sourceLedgerSha256, input.expectedInventorySha256].every((value) => hex.test(value)))
    failCommunitiesStagingRoleSplit('SHA256_BINDING_INVALID');
  if (!/^[A-Za-z0-9._:-]{16,256}$/.test(input.cloneSourceBindingMarker))
    failCommunitiesStagingRoleSplit('CLONE_SOURCE_BINDING_INVALID');
}
export function requireCommunitiesStagingRoleSplitInventory(): never {
  failCommunitiesStagingRoleSplit('INVENTORY_REQUIRED');
}
