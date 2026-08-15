import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);

async function source(path: string) {
  return readFile(new URL(path, root), 'utf8');
}

describe('Communities staging preflight operational boundary', () => {
  it('stops the Communities clone rehearsal until chat/push maintenance is complete', async () => {
    const [communitiesRunbook, chatRunbook, executionPolicy] = await Promise.all([
      source('docs/runbooks/communities-chain-integration.md'),
      source('docs/runbooks/chats-notifications-moderation.md'),
      source('packages/database/src/migration-execution-policy.ts'),
    ]);

    expect(communitiesRunbook).toContain('CHAT_PUSH_FOUNDATION_MAINTENANCE_UNEXPECTED_PENDING');
    expect(communitiesRunbook).toContain('chats-notifications-moderation.md');
    expect(communitiesRunbook).toContain('stop without invoking the migrator');
    expect(communitiesRunbook).toContain('whose `0069`–`0073` pending set is empty');
    expect(communitiesRunbook).toContain('`media` role precheck');
    expect(communitiesRunbook).toContain('role postcheck');
    expect(communitiesRunbook).toContain('rolled-back runtime tenant DML/RLS probe');
    expect(communitiesRunbook).not.toContain('if only a subset of `0069`–`0073` is pending');
    expect(chatRunbook).toContain('if any sixth file is pending');
    expect(executionPolicy).toContain('CHAT_PUSH_FOUNDATION_MAINTENANCE_UNEXPECTED_PENDING');
  });

  it('is manual, exact-SHA pinned and uses separate restricted credentials', async () => {
    const workflow = await source('.github/workflows/communities-staging-preflight.yaml');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/\n\s+(push|pull_request|schedule):/u);
    expect(workflow).toContain('group: staging');
    expect(workflow).toContain('refs/heads/main');
    expect(workflow).toContain('EXPECTED_MAIN_SHA');
    expect(workflow).toContain('INVENTORY_COMMUNITIES_STAGING');
    expect(workflow).toContain('BACKUP_RESTORE_COMMUNITIES_STAGING');
    expect(workflow).toContain('STAGING_PREFLIGHT_INVENTORY_KEY');
    expect(workflow).toContain('STAGING_PREFLIGHT_BACKUP_KEY');
    expect(workflow).toContain('STAGING_PREFLIGHT_DATABASE');
    expect(workflow).toContain('STAGING_PREFLIGHT_SYSTEM_IDENTIFIER');
    expect(workflow).toContain('environment: staging-backup');
    expect(workflow).toContain('source_ledger_sha: ${{ steps.verify.outputs.source_ledger_sha }}');
    expect(workflow).toContain('phase_binding_sha: ${{ steps.verify.outputs.phase_binding_sha }}');
    expect(workflow).not.toContain('target_database: ${{ steps.verify.outputs.target_database }}');
    expect(workflow).not.toContain(
      'system_identifier: ${{ steps.verify.outputs.system_identifier }}',
    );
    expect(workflow).toContain('EXPECTED_PHASE_BINDING_SHA');
    expect(workflow).toContain('actual_phase_binding_sha');
    expect(workflow).toContain('COMMUNITIES_STAGING_EXPECTED_BACKUP_SCRIPT_SHA');
    expect(workflow).toContain('COMMUNITIES_STAGING_EXPECTED_RESTORE_HELPER_SHA');
    expect(workflow).toContain('id: artifact-shas');
    expect(workflow).toContain('steps.artifact-shas.outputs.remote_script_sha');
    expect(workflow).toContain('steps.artifact-shas.outputs.backup_script_sha');
    expect(workflow).toContain('steps.artifact-shas.outputs.restore_helper_sha');
    expect(workflow).toContain('sha256sum deploy/jetson/inspect-communities-staging-target.sh');
    expect(workflow).not.toContain("hashFiles('deploy/jetson/");
    expect(workflow).toContain('META|sourceLedgerSha|$EXPECTED_SOURCE_LEDGER_SHA');
    expect(workflow).toContain('META|systemIdentifier|$EXPECTED_SYSTEM_IDENTIFIER');
    expect(workflow).toContain('timeout --signal=TERM --kill-after=30s 10m');
    expect(workflow).toContain('timeout --signal=TERM --kill-after=30s 150m');
    expect(workflow).not.toMatch(/uses:\s+[^\s]+@v[0-9]+/u);
    expect(workflow).toContain('2> communities-staging-target.stderr');
    expect(workflow).toContain('2> communities-staging-backup.stderr');
    expect(workflow).toContain('test ! -s communities-staging-target.stderr');
    expect(workflow).toContain('test ! -s communities-staging-backup.stderr');
    expect(workflow).toContain('if: ${{ success() }}');
    expect(workflow).toContain('Publish only the redacted inventory failure marker');
    expect(workflow).toContain('Publish only the redacted backup failure marker');
    expect(workflow).not.toContain('STAGING_DEPLOY_KEY');
    expect(workflow).not.toContain('docker compose pull');
    expect(workflow).not.toMatch(
      /(?:npm run db:migrate|apps\/migrator|docker compose (?:up|restart)|\bscp )/u,
    );
  });

  it('runs inventory as one bounded read-only database transaction', async () => {
    const inventory = await source('deploy/jetson/inspect-communities-staging-target.sh');

    expect(inventory).toContain('INVENTORY_COMMUNITIES_STAGING');
    expect(inventory).toContain('default_transaction_read_only=on');
    expect(inventory).toContain('statement_timeout=15000');
    expect(inventory).toContain('lock_timeout=2000');
    expect(inventory).toContain('-qAt');
    expect(inventory).toContain('repeatable read read only');
    expect(inventory).toContain('pg_catalog.pg_control_system()');
    expect(inventory).toContain('/usr/bin/timeout --signal=TERM --kill-after=30s 10m');
    expect(inventory).toContain('confirmation=${SSH_ORIGINAL_COMMAND:-}');
    expect(inventory).toContain('META|installedBackupScriptSha|');
    expect(inventory).toContain('META|installedRestoreHelperSha|');
    expect(inventory).toContain("'0020_community_logo_storage.sql', 'integration'");
    expect(inventory).toContain("'0019_community_home_source.sql', 'integration'");
    expect(inventory).toContain("select 'RLS|'");
    expect(inventory).toContain("select 'INDEX|'");
    expect(inventory).toContain('stat -c %u "$script_path"');
    expect(inventory).toContain('writable by the forced-command principal');
    const databaseProgram = inventory.split("<<'SQL'\n")[1] ?? '';
    expect(databaseProgram).not.toMatch(/\b(insert|update|delete|create|alter|drop|truncate)\b/iu);
  });

  it('binds backup evidence to the source ledger and a deleted PG16 clone', async () => {
    const [backup, restore] = await Promise.all([
      source('deploy/jetson/create-communities-staging-backup.sh'),
      source('deploy/jetson/verify-postgres-backup-restore.sh'),
    ]);

    expect(backup).toContain('BACKUP_RESTORE_COMMUNITIES_STAGING');
    expect(backup).toContain('original_command=${SSH_ORIGINAL_COMMAND:-}');
    expect(backup).toContain('expected_backup_script_sha=${6:-}');
    expect(backup).toContain('expected_restore_helper_sha=${7:-}');
    expect(backup).not.toContain('chmod 700 "$backup_dir"');
    expect(backup).toContain('/usr/bin/timeout --signal=TERM --kill-after=30s 150m');
    expect(backup).toContain('source_manifest_before');
    expect(backup).toContain('source_manifest_after');
    expect(backup).toContain('source_identity_before');
    expect(backup).toContain('source_identity_after');
    expect(backup).toContain('/var/lib/phub-preflight/backups');
    expect(backup).toContain('on_signal');
    expect(backup).toContain('capacity_summary=');
    expect(backup).toContain('restore_summary=');
    expect(backup).toContain('postgres_tool_version pg_dump');
    expect(backup).toContain('PHUB_EXPECTED_SOURCE_LEDGER_DIGEST');
    expect(backup).toContain('pg_dump');
    expect(backup).toContain('writable by the forced-command principal');
    expect(backup).not.toMatch(/\b(migrator|deploy|restart)\b/u);
    expect(restore).toContain('show server_version_num');
    expect(restore).toContain('restored_ledger_digest');
    expect(restore).toContain('restored migration ledger digest does not match');
    expect(restore).toContain('restore database still exists after cleanup');
  });
});
