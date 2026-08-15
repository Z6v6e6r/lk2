import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  assertMigrationLedgerCompatible,
  type MigrationLedgerEntry,
} from '../packages/database/src/migration-ledger-policy.js';

const sha256Schema = /^[0-9a-f]{64}$/;
const releaseSchema = /^[0-9a-f]{40}$/;
const filenameSchema = /^[0-9]{4}_[a-z0-9_]+\.sql$/;
const decimalSchema = /^(0|[1-9][0-9]*)$/;

const requiredMetadata = [
  'activeRelease',
  'remoteScriptSha',
  'installedBackupScriptSha',
  'installedRestoreHelperSha',
  'targetDatabase',
  'systemIdentifier',
  'serverVersionNum',
  'databaseBytes',
  'roleSuper',
  'roleBypassRls',
  'roleReadAllStatsUsage',
  'communityMediaExists',
  'communityMediaRows',
  'communityMediaBytes',
  'privacyCommandsExists',
  'privacyMissingPayloads',
  'rlsGapCount',
  'invalidIndexCount',
  'quotaIndexCount',
  'longTransactionCount',
  'waitingLockCount',
] as const;

type RequiredMetadataKey = (typeof requiredMetadata)[number];

export interface CommunitiesStagingEvidence {
  readonly metadata: ReadonlyMap<RequiredMetadataKey, string>;
  readonly migrations: readonly MigrationLedgerEntry[];
  readonly rlsRelations: ReadonlyMap<string, RlsRelationEvidence>;
  readonly quotaIndexes: ReadonlyMap<string, QuotaIndexEvidence>;
}

interface RlsRelationEvidence {
  readonly present: boolean;
  readonly enabled: boolean;
  readonly forced: boolean;
}

interface QuotaIndexEvidence {
  readonly schema: string;
  readonly relation: string;
  readonly valid: boolean;
  readonly ready: boolean;
  readonly keys: string;
  readonly includes: string;
  readonly predicate: string;
}

const expectedRlsRelationsByMigration = new Map<string, readonly string[]>([
  ['0018_communities_foundation.sql', ['communities.communities', 'communities.memberships']],
  ['0019_community_home_source.sql', ['integration.community_home_source_components']],
  [
    '0020_community_logo_storage.sql',
    ['integration.community_logo_sync', 'integration.community_logo_object_gc'],
  ],
  ['0054_community_membership_pin_commands.sql', ['communities.membership_pin_commands']],
  ['0055_community_create_commands.sql', ['communities.create_commands']],
  [
    '0057_community_membership_lifecycle.sql',
    ['communities.join_requests', 'communities.membership_lifecycle_commands'],
  ],
  [
    '0058_community_direct_invites.sql',
    ['communities.direct_invites', 'communities.direct_invite_commands'],
  ],
  [
    '0059_community_direct_invite_quotas.sql',
    ['communities.direct_invite_quota_grants', 'communities.direct_invite_quota_grant_commands'],
  ],
  ['0062_community_ownership_transfers.sql', ['communities.ownership_transfer_commands']],
  [
    '0063_community_content_foundation.sql',
    [
      'community_content.posts',
      'community_content.post_revisions',
      'community_content.comments',
      'community_content.comment_revisions',
      'community_content.post_reactions',
      'community_content.comment_reactions',
      'community_content.commands',
    ],
  ],
  [
    '0064_community_durable_events.sql',
    ['community_content.event_heads', 'community_content.events'],
  ],
  [
    '0065_community_content_moderation.sql',
    ['community_content.moderation_commands', 'community_content.moderation_actions'],
  ],
  [
    '0066_community_member_count_projection.sql',
    ['communities.member_count_projections', 'communities.member_count_contributions'],
  ],
  [
    '0067_community_media_lifecycle.sql',
    [
      'community_content.media_assets',
      'community_content.media_variants',
      'community_content.post_revision_media',
      'community_content.media_commands',
      'community_content.media_gc_jobs',
    ],
  ],
  [
    '0076_community_create_quota_grants.sql',
    ['communities.create_quota_grants', 'communities.create_quota_grant_commands'],
  ],
  [
    '0077_community_media_operational_recovery.sql',
    ['community_content.media_operations_commands'],
  ],
  [
    '0079_profile_photo_client_assisted_source.sql',
    [
      'integration.profile_photo_client_commands',
      'integration.profile_photo_observation_watermarks',
    ],
  ],
  [
    '0080_community_logo_stable_delivery.sql',
    ['integration.community_logo_observation_watermarks'],
  ],
]);

const expectedQuotaIndexes = new Map<
  string,
  Omit<QuotaIndexEvidence, 'valid' | 'ready' | 'predicate'> & { readonly predicate: RegExp }
>([
  [
    'community_media_actor_outstanding_quota_idx',
    {
      schema: 'community_content',
      relation: 'media_assets',
      keys: 'tenant_id,uploader_user_id,upload_expires_at,id',
      includes: 'declared_size_bytes',
      predicate: /^\(?state = 'UPLOADING'::text\)?$/u,
    },
  ],
  [
    'community_media_actor_daily_bytes_quota_idx',
    {
      schema: 'community_content',
      relation: 'media_assets',
      keys: 'tenant_id,uploader_user_id,created_at,id',
      includes: 'declared_size_bytes',
      predicate: /^$/u,
    },
  ],
  [
    'community_media_actor_pipeline_quota_idx',
    {
      schema: 'community_content',
      relation: 'media_assets',
      keys: 'tenant_id,uploader_user_id,state,upload_expires_at,id',
      includes: '',
      predicate: /^\(?state = ANY \(ARRAY\['UPLOADING'::text, 'SCANNING'::text\]\)\)?$/u,
    },
  ],
  [
    'community_media_tenant_pipeline_quota_idx',
    {
      schema: 'community_content',
      relation: 'media_assets',
      keys: 'tenant_id,state,upload_expires_at,id',
      includes: 'declared_size_bytes',
      predicate: /^\(?state = ANY \(ARRAY\['UPLOADING'::text, 'SCANNING'::text\]\)\)?$/u,
    },
  ],
]);

export interface CommunitiesStagingPreflightReport {
  readonly outcome: 'COMMUNITIES_STAGING_PREFLIGHT_READY';
  readonly candidateRelease: string;
  readonly activeRelease: string;
  readonly remoteScriptSha: string;
  readonly installedBackupScriptSha: string;
  readonly installedRestoreHelperSha: string;
  readonly targetDatabase: string;
  readonly systemIdentifier: string;
  readonly appliedLedgerSha256: string;
  readonly serverVersionNum: number;
  readonly databaseBytes: number;
  readonly communityMediaRows: number;
  readonly communityMediaBytes: number;
  readonly appliedMigrationCount: number;
  readonly packagedMigrationCount: number;
  readonly missingMigrationCount: number;
  readonly missingMigrationFilenames: readonly string[];
  readonly appliedLatest: string;
  readonly packagedLatest: string;
  readonly quotaIndexCount: number;
  readonly authorizesMigration: false;
  readonly authorizesDeploy: false;
  readonly authorizesImport: false;
  readonly authorizesActivation: false;
}

function required(metadata: ReadonlyMap<RequiredMetadataKey, string>, key: RequiredMetadataKey) {
  const value = metadata.get(key);
  if (value === undefined) throw new Error(`COMMUNITIES_STAGING_EVIDENCE_MISSING:${key}`);
  return value;
}

function parseCount(metadata: ReadonlyMap<RequiredMetadataKey, string>, key: RequiredMetadataKey) {
  const raw = required(metadata, key);
  if (!decimalSchema.test(raw)) throw new Error(`COMMUNITIES_STAGING_EVIDENCE_INVALID:${key}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`COMMUNITIES_STAGING_EVIDENCE_INVALID:${key}`);
  return value;
}

function parseBoolean(
  metadata: ReadonlyMap<RequiredMetadataKey, string>,
  key: RequiredMetadataKey,
) {
  const raw = required(metadata, key);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`COMMUNITIES_STAGING_EVIDENCE_INVALID:${key}`);
}

export async function loadPackagedMigrationLedger(
  migrationsDirectory = resolve(process.cwd(), 'packages/database/migrations'),
): Promise<readonly MigrationLedgerEntry[]> {
  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith('.sql'))
    .sort();
  return Promise.all(
    filenames.map(async (filename) => ({
      filename,
      checksum: createHash('sha256')
        .update(await readFile(resolve(migrationsDirectory, filename)))
        .digest('hex'),
    })),
  );
}

export function parseCommunitiesStagingEvidence(raw: string): CommunitiesStagingEvidence {
  const metadata = new Map<RequiredMetadataKey, string>();
  const migrations: MigrationLedgerEntry[] = [];
  const migrationNames = new Set<string>();
  const rlsRelations = new Map<string, RlsRelationEvidence>();
  const quotaIndexes = new Map<string, QuotaIndexEvidence>();

  for (const line of raw.split(/\r?\n/u)) {
    if (!line) continue;
    const fields = line.split('|');
    if (fields[0] === 'META' && fields.length === 3) {
      const key = fields[1] as RequiredMetadataKey;
      if (!requiredMetadata.includes(key)) {
        throw new Error(`COMMUNITIES_STAGING_EVIDENCE_UNKNOWN_META:${fields[1] ?? ''}`);
      }
      if (metadata.has(key)) throw new Error(`COMMUNITIES_STAGING_EVIDENCE_DUPLICATE:${key}`);
      metadata.set(key, fields[2] ?? '');
      continue;
    }
    if (fields[0] === 'MIGRATION' && fields.length === 3) {
      const filename = fields[1] ?? '';
      const checksum = fields[2] ?? '';
      if (!filenameSchema.test(filename) || !sha256Schema.test(checksum)) {
        throw new Error('COMMUNITIES_STAGING_EVIDENCE_INVALID_MIGRATION');
      }
      if (migrationNames.has(filename)) {
        throw new Error(`MIGRATION_LEDGER_DUPLICATE:${filename}`);
      }
      migrationNames.add(filename);
      migrations.push({ filename, checksum });
      continue;
    }
    if (fields[0] === 'RLS' && fields.length === 5) {
      const relation = fields[1] ?? '';
      if (!/^(?:communities|community_content|integration)\.[a-z][a-z0-9_]*$/u.test(relation)) {
        throw new Error('COMMUNITIES_STAGING_EVIDENCE_INVALID_RLS');
      }
      if (rlsRelations.has(relation)) {
        throw new Error(`COMMUNITIES_STAGING_EVIDENCE_DUPLICATE_RLS:${relation}`);
      }
      const values = fields.slice(2).map((value) => {
        if (value === 'true') return true;
        if (value === 'false') return false;
        throw new Error('COMMUNITIES_STAGING_EVIDENCE_INVALID_RLS');
      });
      rlsRelations.set(relation, {
        present: values[0]!,
        enabled: values[1]!,
        forced: values[2]!,
      });
      continue;
    }
    if (fields[0] === 'INDEX' && fields.length === 9) {
      const name = fields[1] ?? '';
      if (!/^[a-z][a-z0-9_]*$/u.test(name) || quotaIndexes.has(name)) {
        throw new Error('COMMUNITIES_STAGING_EVIDENCE_INVALID_INDEX');
      }
      const parseIndexBoolean = (value: string | undefined) => {
        if (value === 'true') return true;
        if (value === 'false') return false;
        throw new Error('COMMUNITIES_STAGING_EVIDENCE_INVALID_INDEX');
      };
      quotaIndexes.set(name, {
        schema: fields[2] ?? '',
        relation: fields[3] ?? '',
        valid: parseIndexBoolean(fields[4]),
        ready: parseIndexBoolean(fields[5]),
        keys: fields[6] ?? '',
        includes: fields[7] ?? '',
        predicate: fields[8] ?? '',
      });
      continue;
    }
    throw new Error('COMMUNITIES_STAGING_EVIDENCE_INVALID_LINE');
  }

  for (const key of requiredMetadata) required(metadata, key);
  if (migrations.length === 0) throw new Error('COMMUNITIES_STAGING_LEDGER_EMPTY');
  return { metadata, migrations, rlsRelations, quotaIndexes };
}

export function verifyCommunitiesStagingEvidence(input: {
  readonly candidateRelease: string;
  readonly expectedRemoteScriptSha: string;
  readonly expectedBackupScriptSha: string;
  readonly expectedRestoreHelperSha: string;
  readonly expectedTargetDatabase: string;
  readonly expectedSystemIdentifier: string;
  readonly evidence: CommunitiesStagingEvidence;
  readonly packaged: readonly MigrationLedgerEntry[];
}): CommunitiesStagingPreflightReport {
  if (!releaseSchema.test(input.candidateRelease)) {
    throw new Error('COMMUNITIES_STAGING_CANDIDATE_RELEASE_INVALID');
  }
  if (!sha256Schema.test(input.expectedRemoteScriptSha)) {
    throw new Error('COMMUNITIES_STAGING_EXPECTED_SCRIPT_SHA_INVALID');
  }
  if (
    !sha256Schema.test(input.expectedBackupScriptSha) ||
    !sha256Schema.test(input.expectedRestoreHelperSha)
  ) {
    throw new Error('COMMUNITIES_STAGING_EXPECTED_BACKUP_COMMAND_SHA_INVALID');
  }
  if (input.packaged.length === 0) throw new Error('COMMUNITIES_STAGING_PACKAGED_LEDGER_EMPTY');
  assertMigrationLedgerCompatible({ applied: input.evidence.migrations, packaged: input.packaged });
  const appliedLedgerSha256 = createHash('sha256')
    .update(
      `${input.evidence.migrations
        .map(({ filename, checksum }) => `${filename}|${checksum}`)
        .join('\n')}\n`,
    )
    .digest('hex');

  const appliedNames = new Set(input.evidence.migrations.map(({ filename }) => filename));
  const appliedPackagedNames = input.packaged
    .map(({ filename }) => filename)
    .filter((filename) => appliedNames.has(filename));
  const missingMigrationFilenames = input.packaged
    .map(({ filename }) => filename)
    .filter((filename) => !appliedNames.has(filename));

  const metadata = input.evidence.metadata;
  const activeRelease = required(metadata, 'activeRelease');
  if (!releaseSchema.test(activeRelease))
    throw new Error('COMMUNITIES_STAGING_ACTIVE_RELEASE_INVALID');
  const remoteScriptSha = required(metadata, 'remoteScriptSha');
  if (remoteScriptSha !== input.expectedRemoteScriptSha) {
    throw new Error('COMMUNITIES_STAGING_REMOTE_SCRIPT_SHA_MISMATCH');
  }
  const installedBackupScriptSha = required(metadata, 'installedBackupScriptSha');
  const installedRestoreHelperSha = required(metadata, 'installedRestoreHelperSha');
  if (installedBackupScriptSha !== input.expectedBackupScriptSha) {
    throw new Error('COMMUNITIES_STAGING_BACKUP_SCRIPT_SHA_MISMATCH');
  }
  if (installedRestoreHelperSha !== input.expectedRestoreHelperSha) {
    throw new Error('COMMUNITIES_STAGING_RESTORE_HELPER_SHA_MISMATCH');
  }
  const targetDatabase = required(metadata, 'targetDatabase');
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/u.test(targetDatabase)) {
    throw new Error('COMMUNITIES_STAGING_TARGET_DATABASE_INVALID');
  }
  const systemIdentifier = required(metadata, 'systemIdentifier');
  if (!decimalSchema.test(systemIdentifier)) {
    throw new Error('COMMUNITIES_STAGING_SYSTEM_IDENTIFIER_INVALID');
  }
  if (targetDatabase !== input.expectedTargetDatabase) {
    throw new Error('COMMUNITIES_STAGING_TARGET_DATABASE_MISMATCH');
  }
  if (systemIdentifier !== input.expectedSystemIdentifier) {
    throw new Error('COMMUNITIES_STAGING_SYSTEM_IDENTIFIER_MISMATCH');
  }

  const serverVersionNum = parseCount(metadata, 'serverVersionNum');
  if (serverVersionNum < 160_000 || serverVersionNum >= 170_000) {
    throw new Error('COMMUNITIES_STAGING_POSTGRES_VERSION_UNSUPPORTED');
  }
  const databaseBytes = parseCount(metadata, 'databaseBytes');
  const communityMediaRows = parseCount(metadata, 'communityMediaRows');
  const communityMediaBytes = parseCount(metadata, 'communityMediaBytes');
  const privacyMissingPayloads = parseCount(metadata, 'privacyMissingPayloads');
  const quotaIndexCount = parseCount(metadata, 'quotaIndexCount');
  const roleCanAuditRls =
    parseBoolean(metadata, 'roleSuper') || parseBoolean(metadata, 'roleBypassRls');
  const roleCanReadAllStats =
    parseBoolean(metadata, 'roleSuper') || parseBoolean(metadata, 'roleReadAllStatsUsage');
  const communityMediaExists = parseBoolean(metadata, 'communityMediaExists');
  const privacyCommandsExists = parseBoolean(metadata, 'privacyCommandsExists');

  if (!roleCanReadAllStats) {
    throw new Error('COMMUNITIES_STAGING_ACTIVITY_AUDIT_NOT_AUTHORITATIVE');
  }
  if (!roleCanAuditRls) {
    throw new Error('COMMUNITIES_STAGING_RLS_AUDIT_NOT_AUTHORITATIVE');
  }

  for (const key of [
    'rlsGapCount',
    'invalidIndexCount',
    'longTransactionCount',
    'waitingLockCount',
  ] as const) {
    if (parseCount(metadata, key) !== 0) throw new Error(`COMMUNITIES_STAGING_BLOCKER:${key}`);
  }

  if (appliedNames.has('0053_profile_visibility_sections.sql')) {
    if (!privacyCommandsExists) {
      throw new Error('COMMUNITIES_STAGING_0053_AUDIT_NOT_AUTHORITATIVE');
    }
    if (privacyMissingPayloads !== 0) {
      throw new Error('COMMUNITIES_STAGING_0053_FORWARD_REPAIR_REQUIRED');
    }
  }
  if (appliedNames.has('0078_community_media_issue_quotas.sql')) {
    if (!communityMediaExists || quotaIndexCount !== expectedQuotaIndexes.size) {
      throw new Error('COMMUNITIES_STAGING_0078_INDEX_CONTRACT_INCOMPLETE');
    }
    for (const [name, expected] of expectedQuotaIndexes) {
      const actual = input.evidence.quotaIndexes.get(name);
      if (
        !actual ||
        actual.schema !== expected.schema ||
        actual.relation !== expected.relation ||
        !actual.valid ||
        !actual.ready ||
        actual.keys !== expected.keys ||
        actual.includes !== expected.includes ||
        !expected.predicate.test(actual.predicate)
      ) {
        throw new Error(`COMMUNITIES_STAGING_0078_INDEX_CONTRACT_MISMATCH:${name}`);
      }
    }
    if (input.evidence.quotaIndexes.size !== expectedQuotaIndexes.size) {
      throw new Error('COMMUNITIES_STAGING_0078_INDEX_CONTRACT_UNEXPECTED');
    }
  } else if (input.evidence.quotaIndexes.size !== 0 || quotaIndexCount !== 0) {
    throw new Error('COMMUNITIES_STAGING_0078_INDEX_WITHOUT_LEDGER');
  }

  const expectedRlsRelations = [...expectedRlsRelationsByMigration]
    .filter(([filename]) => appliedNames.has(filename))
    .flatMap(([, relations]) => relations);
  for (const relation of expectedRlsRelations) {
    const actual = input.evidence.rlsRelations.get(relation);
    if (!actual?.present || !actual.enabled || !actual.forced) {
      throw new Error(`COMMUNITIES_STAGING_RLS_CONTRACT_MISMATCH:${relation}`);
    }
  }
  if (input.evidence.rlsRelations.size !== expectedRlsRelations.length) {
    throw new Error('COMMUNITIES_STAGING_RLS_CONTRACT_UNEXPECTED');
  }

  return {
    outcome: 'COMMUNITIES_STAGING_PREFLIGHT_READY',
    candidateRelease: input.candidateRelease,
    activeRelease,
    remoteScriptSha,
    installedBackupScriptSha,
    installedRestoreHelperSha,
    targetDatabase,
    systemIdentifier,
    appliedLedgerSha256,
    serverVersionNum,
    databaseBytes,
    communityMediaRows,
    communityMediaBytes,
    appliedMigrationCount: input.evidence.migrations.length,
    packagedMigrationCount: input.packaged.length,
    missingMigrationCount: missingMigrationFilenames.length,
    missingMigrationFilenames,
    appliedLatest: appliedPackagedNames.at(-1) ?? 'LEGACY_ONLY',
    packagedLatest: input.packaged.at(-1)?.filename ?? 'NONE',
    quotaIndexCount,
    authorizesMigration: false,
    authorizesDeploy: false,
    authorizesImport: false,
    authorizesActivation: false,
  };
}
