import { describe, expect, it } from 'vitest';

import type { MigrationLedgerEntry } from '../packages/database/src/migration-ledger-policy.js';
import {
  parseCommunitiesStagingEvidence,
  verifyCommunitiesStagingEvidence,
} from './communities-staging-preflight-support.js';

const candidateRelease = 'a'.repeat(40);
const remoteScriptSha = 'b'.repeat(64);
const backupScriptSha = 'd'.repeat(64);
const restoreHelperSha = 'e'.repeat(64);
const checksum = (character: string) => character.repeat(64);

const baseMetadata = {
  activeRelease: 'c'.repeat(40),
  remoteScriptSha,
  installedBackupScriptSha: backupScriptSha,
  installedRestoreHelperSha: restoreHelperSha,
  targetDatabase: 'phub',
  systemIdentifier: '7482081092357201457',
  serverVersionNum: '160009',
  databaseBytes: '1048576',
  roleSuper: 'false',
  roleBypassRls: 'true',
  roleReadAllStatsUsage: 'true',
  communityMediaExists: 'true',
  communityMediaRows: '20',
  communityMediaBytes: '40960',
  privacyCommandsExists: 'true',
  privacyMissingPayloads: '0',
  rlsGapCount: '0',
  invalidIndexCount: '0',
  quotaIndexCount: '4',
  longTransactionCount: '0',
  waitingLockCount: '0',
} as const;

function evidence(
  migrations: readonly MigrationLedgerEntry[],
  metadata: Partial<Record<keyof typeof baseMetadata, string>> = {},
) {
  const hasQuotaMigration = migrations.some(
    ({ filename }) => filename === '0078_community_media_issue_quotas.sql',
  );
  const merged = {
    ...baseMetadata,
    quotaIndexCount: hasQuotaMigration ? '4' : '0',
    ...metadata,
  };
  return parseCommunitiesStagingEvidence(
    [
      ...Object.entries(merged).map(([key, value]) => `META|${key}|${value}`),
      ...migrations.map(({ filename, checksum: value }) => `MIGRATION|${filename}|${value}`),
      ...(hasQuotaMigration
        ? [
            "INDEX|community_media_actor_outstanding_quota_idx|community_content|media_assets|true|true|tenant_id,uploader_user_id,upload_expires_at,id|declared_size_bytes|(state = 'UPLOADING'::text)",
            'INDEX|community_media_actor_daily_bytes_quota_idx|community_content|media_assets|true|true|tenant_id,uploader_user_id,created_at,id|declared_size_bytes|',
            "INDEX|community_media_actor_pipeline_quota_idx|community_content|media_assets|true|true|tenant_id,uploader_user_id,state,upload_expires_at,id||(state = ANY (ARRAY['UPLOADING'::text, 'SCANNING'::text]))",
            "INDEX|community_media_tenant_pipeline_quota_idx|community_content|media_assets|true|true|tenant_id,state,upload_expires_at,id|declared_size_bytes|(state = ANY (ARRAY['UPLOADING'::text, 'SCANNING'::text]))",
          ]
        : []),
    ].join('\n'),
  );
}

function verify(
  applied: readonly MigrationLedgerEntry[],
  packaged: readonly MigrationLedgerEntry[],
  metadata: Partial<Record<keyof typeof baseMetadata, string>> = {},
) {
  return verifyCommunitiesStagingEvidence({
    candidateRelease,
    expectedRemoteScriptSha: remoteScriptSha,
    expectedBackupScriptSha: backupScriptSha,
    expectedRestoreHelperSha: restoreHelperSha,
    expectedTargetDatabase: baseMetadata.targetDatabase,
    expectedSystemIdentifier: baseMetadata.systemIdentifier,
    evidence: evidence(applied, metadata),
    packaged,
  });
}

describe('Communities staging preflight evidence', () => {
  const packaged = [
    { filename: '0001_initial.sql', checksum: checksum('1') },
    { filename: '0002_second.sql', checksum: checksum('2') },
    { filename: '0053_profile_visibility_sections.sql', checksum: checksum('3') },
    { filename: '0078_community_media_issue_quotas.sql', checksum: checksum('4') },
  ] as const;

  it('accepts an exact packaged ledger and reports a non-authorizing result', () => {
    const report = verify(packaged, packaged);
    expect(report).toMatchObject({
      outcome: 'COMMUNITIES_STAGING_PREFLIGHT_READY',
      appliedMigrationCount: 4,
      missingMigrationCount: 0,
      packagedLatest: '0078_community_media_issue_quotas.sql',
      authorizesMigration: false,
      authorizesDeploy: false,
      authorizesImport: false,
      authorizesActivation: false,
    });
    expect(report.appliedLedgerSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('reports missing packaged migrations without rejecting a compatible historical gap', () => {
    expect(verify(packaged.slice(0, 2), packaged)).toMatchObject({
      appliedLatest: '0002_second.sql',
      missingMigrationCount: 2,
      missingMigrationFilenames: [
        '0053_profile_visibility_sections.sql',
        '0078_community_media_issue_quotas.sql',
      ],
    });
    expect(verify([packaged[0], packaged[2]], packaged)).toMatchObject({
      missingMigrationFilenames: ['0002_second.sql', '0078_community_media_issue_quotas.sql'],
    });
  });

  it('fails closed on unknown, mismatched, duplicate and superseded ledgers', () => {
    expect(() =>
      verify([{ filename: '0099_foreign.sql', checksum: checksum('9') }], packaged),
    ).toThrow('MIGRATION_LEDGER_UNKNOWN:0099_foreign.sql');
    expect(() =>
      verify([{ filename: '0001_initial.sql', checksum: checksum('9') }], packaged),
    ).toThrow('MIGRATION_CHECKSUM_MISMATCH:0001_initial.sql');
    expect(() => evidence([packaged[0], packaged[0]])).toThrow(
      'MIGRATION_LEDGER_DUPLICATE:0001_initial.sql',
    );
    expect(() =>
      verify(
        [
          {
            filename: '0060_community_membership_pin_commands.sql',
            checksum: checksum('6'),
          },
        ],
        packaged,
      ),
    ).toThrow('COMMUNITIES_CANONICAL_HISTORY_REJECTED:0060_community_membership_pin_commands.sql');
  });

  it('accepts the sole exact reviewed legacy 0043 alias alongside packaged gaps', () => {
    const legacy = {
      filename: '0043_messaging_runtime.sql',
      checksum: '32512565880a9062a432eb68ec192b0640570f1636d2f2a946ab4ebc5bf96465',
    } as const;
    expect(verify([packaged[0], legacy, packaged[2]], packaged)).toMatchObject({
      appliedMigrationCount: 3,
      missingMigrationFilenames: ['0002_second.sql', '0078_community_media_issue_quotas.sql'],
    });
  });

  it('requires exact remote script custody and authoritative 0053 evidence', () => {
    expect(() => verify(packaged, packaged, { remoteScriptSha: checksum('9') })).toThrow(
      'COMMUNITIES_STAGING_REMOTE_SCRIPT_SHA_MISMATCH',
    );
    expect(() => verify(packaged.slice(0, 3), packaged, { roleBypassRls: 'false' })).toThrow(
      'COMMUNITIES_STAGING_RLS_AUDIT_NOT_AUTHORITATIVE',
    );
    expect(() => verify(packaged.slice(0, 3), packaged, { privacyMissingPayloads: '1' })).toThrow(
      'COMMUNITIES_STAGING_0053_FORWARD_REPAIR_REQUIRED',
    );
    expect(() => verify(packaged, packaged, { installedBackupScriptSha: checksum('9') })).toThrow(
      'COMMUNITIES_STAGING_BACKUP_SCRIPT_SHA_MISMATCH',
    );
    expect(() => verify(packaged, packaged, { installedRestoreHelperSha: checksum('9') })).toThrow(
      'COMMUNITIES_STAGING_RESTORE_HELPER_SHA_MISMATCH',
    );
  });

  it('requires independently pinned database identity and authoritative activity visibility', () => {
    expect(() =>
      verifyCommunitiesStagingEvidence({
        candidateRelease,
        expectedRemoteScriptSha: remoteScriptSha,
        expectedBackupScriptSha: backupScriptSha,
        expectedRestoreHelperSha: restoreHelperSha,
        expectedTargetDatabase: 'other_database',
        expectedSystemIdentifier: baseMetadata.systemIdentifier,
        evidence: evidence(packaged),
        packaged,
      }),
    ).toThrow('COMMUNITIES_STAGING_TARGET_DATABASE_MISMATCH');
    expect(() =>
      verifyCommunitiesStagingEvidence({
        candidateRelease,
        expectedRemoteScriptSha: remoteScriptSha,
        expectedBackupScriptSha: backupScriptSha,
        expectedRestoreHelperSha: restoreHelperSha,
        expectedTargetDatabase: baseMetadata.targetDatabase,
        expectedSystemIdentifier: '1',
        evidence: evidence(packaged),
        packaged,
      }),
    ).toThrow('COMMUNITIES_STAGING_SYSTEM_IDENTIFIER_MISMATCH');
    expect(() =>
      verify(packaged, packaged, {
        roleSuper: 'false',
        roleReadAllStatsUsage: 'false',
      }),
    ).toThrow('COMMUNITIES_STAGING_ACTIVITY_AUDIT_NOT_AUTHORITATIVE');
  });

  it('requires all four valid quota indexes after 0078 and no live blockers', () => {
    expect(() => verify(packaged, packaged, { quotaIndexCount: '3' })).toThrow(
      'COMMUNITIES_STAGING_0078_INDEX_CONTRACT_INCOMPLETE',
    );
    expect(() => verify(packaged, packaged, { longTransactionCount: '1' })).toThrow(
      'COMMUNITIES_STAGING_BLOCKER:longTransactionCount',
    );
    expect(() => verify(packaged, packaged, { waitingLockCount: '1' })).toThrow(
      'COMMUNITIES_STAGING_BLOCKER:waitingLockCount',
    );

    const wrongIndexEvidence = evidence(packaged);
    const wrongIndexes = new Map(wrongIndexEvidence.quotaIndexes);
    wrongIndexes.set('community_media_actor_pipeline_quota_idx', {
      ...wrongIndexes.get('community_media_actor_pipeline_quota_idx')!,
      relation: 'media_variants',
    });
    expect(() =>
      verifyCommunitiesStagingEvidence({
        candidateRelease,
        expectedRemoteScriptSha: remoteScriptSha,
        expectedBackupScriptSha: backupScriptSha,
        expectedRestoreHelperSha: restoreHelperSha,
        expectedTargetDatabase: baseMetadata.targetDatabase,
        expectedSystemIdentifier: baseMetadata.systemIdentifier,
        evidence: { ...wrongIndexEvidence, quotaIndexes: wrongIndexes },
        packaged,
      }),
    ).toThrow(
      'COMMUNITIES_STAGING_0078_INDEX_CONTRACT_MISMATCH:community_media_actor_pipeline_quota_idx',
    );
  });

  it('requires every migration-owned tenant relation to exist with RLS and FORCE RLS', () => {
    const integrationMigrations = [
      { filename: '0019_community_home_source.sql', checksum: checksum('1') },
      { filename: '0020_community_logo_storage.sql', checksum: checksum('2') },
    ] as const;
    const parsed = evidence(integrationMigrations, { quotaIndexCount: '0' });
    const validRelations = new Map([
      [
        'integration.community_home_source_components',
        { present: true, enabled: true, forced: true },
      ],
      ['integration.community_logo_sync', { present: true, enabled: true, forced: true }],
      ['integration.community_logo_object_gc', { present: true, enabled: true, forced: true }],
    ]);
    expect(
      verifyCommunitiesStagingEvidence({
        candidateRelease,
        expectedRemoteScriptSha: remoteScriptSha,
        expectedBackupScriptSha: backupScriptSha,
        expectedRestoreHelperSha: restoreHelperSha,
        expectedTargetDatabase: baseMetadata.targetDatabase,
        expectedSystemIdentifier: baseMetadata.systemIdentifier,
        evidence: { ...parsed, rlsRelations: validRelations },
        packaged: integrationMigrations,
      }),
    ).toMatchObject({ outcome: 'COMMUNITIES_STAGING_PREFLIGHT_READY' });

    validRelations.set('integration.community_logo_object_gc', {
      present: true,
      enabled: true,
      forced: false,
    });
    expect(() =>
      verifyCommunitiesStagingEvidence({
        candidateRelease,
        expectedRemoteScriptSha: remoteScriptSha,
        expectedBackupScriptSha: backupScriptSha,
        expectedRestoreHelperSha: restoreHelperSha,
        expectedTargetDatabase: baseMetadata.targetDatabase,
        expectedSystemIdentifier: baseMetadata.systemIdentifier,
        evidence: { ...parsed, rlsRelations: validRelations },
        packaged: integrationMigrations,
      }),
    ).toThrow('COMMUNITIES_STAGING_RLS_CONTRACT_MISMATCH:integration.community_logo_object_gc');
  });

  it('rejects unknown metadata, malformed lines and an empty ledger', () => {
    const valid = Object.entries(baseMetadata)
      .map(([key, value]) => `META|${key}|${value}`)
      .join('\n');
    expect(() => parseCommunitiesStagingEvidence(`${valid}\nMETA|extra|1`)).toThrow(
      'COMMUNITIES_STAGING_EVIDENCE_UNKNOWN_META:extra',
    );
    expect(() => parseCommunitiesStagingEvidence(`${valid}\nnot-evidence`)).toThrow(
      'COMMUNITIES_STAGING_EVIDENCE_INVALID_LINE',
    );
    expect(() => parseCommunitiesStagingEvidence(valid)).toThrow(
      'COMMUNITIES_STAGING_LEDGER_EMPTY',
    );
  });
});
