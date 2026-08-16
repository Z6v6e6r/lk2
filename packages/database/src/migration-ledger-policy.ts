export interface MigrationLedgerEntry {
  readonly filename: string;
  readonly checksum: string;
}

const forbiddenCommunitiesHistory = new Set([
  '0060_community_membership_pin_commands.sql',
  '0061_community_create_commands.sql',
  '0062_community_discovery_indexes.sql',
  '0063_community_membership_lifecycle.sql',
  '0064_community_direct_invites.sql',
  '0065_community_direct_invite_quotas.sql',
  '0066_community_mine_keyset_index.sql',
  '0067_community_ownership_transfers.sql',
  '0068_community_content_foundation.sql',
  '0069_community_durable_events.sql',
  '0070_community_content_moderation.sql',
  '0071_community_member_count_projection.sql',
  '0072_community_media_lifecycle.sql',
  '0073_community_event_retention.sql',
  '0074_community_create_quota_grants.sql',
  '0075_community_media_operational_recovery.sql',
]);

const reviewedLegacyMigrations = new Map([
  [
    '0043_messaging_runtime.sql',
    '32512565880a9062a432eb68ec192b0640570f1636d2f2a946ab4ebc5bf96465',
  ],
  [
    '0044_contextual_messaging_projection.sql',
    '103976b96034ac3996c47c9adc536d22c06c5bc0ad12352af1413241b9c50832',
  ],
]);

export function assertMigrationLedgerCompatible(input: {
  readonly applied: readonly MigrationLedgerEntry[];
  readonly packaged: readonly MigrationLedgerEntry[];
}): void {
  const packagedByFilename = new Map(input.packaged.map((entry) => [entry.filename, entry]));
  const seen = new Set<string>();

  for (const entry of input.applied) {
    if (seen.has(entry.filename)) {
      throw new Error(`MIGRATION_LEDGER_DUPLICATE:${entry.filename}`);
    }
    seen.add(entry.filename);

    if (forbiddenCommunitiesHistory.has(entry.filename)) {
      throw new Error(`COMMUNITIES_CANONICAL_HISTORY_REJECTED:${entry.filename}`);
    }

    const expectedChecksum =
      packagedByFilename.get(entry.filename)?.checksum ??
      reviewedLegacyMigrations.get(entry.filename);
    if (!expectedChecksum) {
      throw new Error(`MIGRATION_LEDGER_UNKNOWN:${entry.filename}`);
    }
    if (expectedChecksum !== entry.checksum) {
      throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${entry.filename}`);
    }
  }
}
