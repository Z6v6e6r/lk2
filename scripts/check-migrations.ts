import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const migrationsDirectory = resolve(process.cwd(), 'packages/database/migrations');
const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort();
const destructivePatterns: readonly { readonly pattern: RegExp; readonly message: string }[] = [
  { pattern: /\bdrop\s+table\b/i, message: 'DROP TABLE requires a later contract release' },
  { pattern: /\bdrop\s+column\b/i, message: 'DROP COLUMN requires a later contract release' },
  {
    pattern: /\balter\s+column\b[^;]*\btype\b/i,
    message: 'type replacement must use expand/migrate/contract',
  },
  { pattern: /\btruncate\b/i, message: 'TRUNCATE is forbidden in application migrations' },
];

// These migrations were already immutable release artifacts before the reviewed-index marker
// became mandatory. Pinning their exact digests preserves that history without allowing a new or
// modified transactional index to bypass the marker and timeout checks.
const preMarkerMigrationDigests = new Map<string, string>([
  [
    '0060_viva_home_booking_ownership.sql',
    '5b74d85ef678639694c9074f8a66eb5df6b243f60b1b6f429eced3f0b09d5f38',
  ],
  [
    '0061_community_mine_keyset_index.sql',
    '1caf9857dff642fb577a3713fa330b2e413670ec3f5e622582d2a6b17df78413',
  ],
  [
    '0062_community_ownership_transfers.sql',
    '58df5b8539a0bb29bb74e2c149d438adb4c831a0dc9295c31f13a471ff12e998',
  ],
  [
    '0063_community_content_foundation.sql',
    '515baca7fd0d897ee02308e4a23f5b09aef7a303bbefbe835e379a63a4f4c05d',
  ],
  [
    '0064_community_durable_events.sql',
    '3a7aead3d0b0c62a8a53d89a3d19a2008bee5896ae04a3bfe70a47d35d204072',
  ],
  [
    '0065_community_content_moderation.sql',
    'd48f63eaabcadef0d376d148ef6225cc8f5eb2423ae11d0c8a143d83d6a0ebe1',
  ],
  [
    '0066_community_member_count_projection.sql',
    'b228b50810a62a0ba609fb7ab67d5ef9bbf60bbd875e108aae03c91035eb5e49',
  ],
  [
    '0067_community_media_lifecycle.sql',
    '1653d039325452ca8ef0e88fb78a96863b928fae52688e3cd20e83f1fe16f0eb',
  ],
  [
    '0068_community_event_retention.sql',
    '94c959a60eeb02ad7308453cf7b99fbf38919900475091e3b025133f4fc3a2f8',
  ],
  [
    '0076_community_create_quota_grants.sql',
    '605c280677eb6443293eeca9b069cf8c03088ec978bede4e394e4edb7b05dcde',
  ],
  [
    '0077_community_media_operational_recovery.sql',
    '4116433e52aaddb675d4e38f3a32ab0980cc0406405a5a9a7caedc1afb11fb42',
  ],
  [
    '0078_community_media_issue_quotas.sql',
    'd91ad275840ca32a35a626fd0cfa4900cc21f2469d986923326c6522740de365',
  ],
  [
    '0079_profile_photo_client_assisted_source.sql',
    'e17a11983eacfe5d59b8d72fab4f603e887a451edd9a420456d99ba707485757',
  ],
]);

const failures: string[] = [];
for (const file of files) {
  const sql = await readFile(resolve(migrationsDirectory, file), 'utf8');
  for (const rule of destructivePatterns) {
    if (rule.pattern.test(sql)) failures.push(`${file}: ${rule.message}`);
  }
  const sequence = Number.parseInt(file.slice(0, 4), 10);
  const hasTransactionalIndex = /\bcreate\s+(?:unique\s+)?index\s+(?!concurrently\b)/i.test(sql);
  const hasReviewedIndexMarker =
    sql.includes('phub:reviewed-blocking-index') || sql.includes('phub:reviewed-new-table-index');
  const expectedPreMarkerDigest = preMarkerMigrationDigests.get(file);
  const isPinnedPreMarkerMigration =
    expectedPreMarkerDigest !== undefined &&
    createHash('sha256').update(sql).digest('hex') === expectedPreMarkerDigest;
  if (
    sequence >= 60 &&
    hasTransactionalIndex &&
    !hasReviewedIndexMarker &&
    !isPinnedPreMarkerMigration
  ) {
    failures.push(
      `${file}: transactional CREATE INDEX requires a reviewed blocking/new-table marker`,
    );
  }
  if (
    sql.includes('phub:reviewed-blocking-index') &&
    (!sql.includes('set local lock_timeout') || !sql.includes('set local statement_timeout'))
  ) {
    failures.push(`${file}: reviewed blocking index requires local lock and statement timeouts`);
  }
}

if (failures.length > 0) throw new Error(`Unsafe migrations:\n${failures.join('\n')}`);
process.stdout.write(
  `Checked ${files.length} migration(s): static destructive-pattern baseline only; ` +
    'lock, RLS and mixed-version safety require review\n',
);
