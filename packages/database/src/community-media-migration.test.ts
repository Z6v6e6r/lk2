import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('community media migration', () => {
  it('preserves the exact historical tenant-isolated media lifecycle before its forward repair', async () => {
    const sql = await readFile(
      new URL('../migrations/0067_community_media_lifecycle.sql', import.meta.url),
      'utf8',
    );
    for (const table of [
      'community_content.media_assets',
      'community_content.media_variants',
      'community_content.post_revision_media',
      'community_content.media_commands',
      'community_content.media_gc_jobs',
    ]) {
      expect(sql).toContain(`create table if not exists ${table}`);
      expect(sql).toContain(`alter table ${table} force row level security`);
    }
    expect(sql).toContain(
      "state in ('UPLOADING', 'SCANNING', 'READY', 'REJECTED', 'EXPIRED', 'PURGED')",
    );
    expect(sql).toContain('source_object_version text');
    expect(sql).toContain('source_etag text');
    expect(sql).toContain('object_version text not null');
    expect(sql).toContain('object_etag text not null');
    expect(sql).toContain('position between 1 and 10');
    expect(sql).toContain(
      'references community_content.post_revisions(tenant_id, post_id, revision)',
    );
    expect(sql).toContain('references community_content.media_variants(tenant_id, media_id, id)');
    expect(sql).toContain('community_media_gc_claim_idx');
    expect(sql).toContain('community_media_ready_variants_guard');
    expect(sql).toContain('community_post_revision_media_ready_guard');
    expect(sql).toContain('[0-9a-f]{64}\\\\.webp$');
    expect(sql).not.toMatch(/drop\s+(table|column)|truncate/i);
  });

  it('adds terminal recovery evidence, repairs the READY key CHECK and keeps the RLS boundary', async () => {
    const sql = await readFile(
      new URL('../migrations/0077_community_media_operational_recovery.sql', import.meta.url),
      'utf8',
    );

    expect(sql).toContain('add column if not exists scan_failed_at timestamptz');
    expect(sql).toContain('add column if not exists scan_failure_code text');
    expect(sql).toContain('add column if not exists dead_at timestamptz');
    expect(sql).toContain('add column if not exists failure_code text');
    expect(sql).toContain('create table if not exists community_content.media_operations_commands');
    expect(sql).toContain("operation in ('REPLAY_SCAN', 'REPLAY_GC')");
    expect(sql).toContain('community_media_failed_scan_idx');
    expect(sql).toContain('community_media_dead_gc_idx');
    expect(sql).toContain('drop constraint if exists media_variants_object_key_check');
    expect(sql).toContain('[0-9a-f]{64}\\.webp$');
    expect(sql).not.toContain('[0-9a-f]{64}\\\\.webp$');
    expect(sql).toContain(
      'alter table community_content.media_operations_commands force row level security',
    );
    expect(sql).not.toMatch(/drop\s+(table|column)|truncate|alter\s+column/i);
  });

  it('adds quota-supporting indexes without rewriting media state', async () => {
    const sql = await readFile(
      new URL('../migrations/0078_community_media_issue_quotas.sql', import.meta.url),
      'utf8',
    );

    expect(sql).toContain('community_media_actor_outstanding_quota_idx');
    expect(sql).toContain('community_media_actor_daily_bytes_quota_idx');
    expect(sql).toContain('community_media_actor_pipeline_quota_idx');
    expect(sql).toContain('community_media_tenant_pipeline_quota_idx');
    expect(sql).toContain("where state in ('UPLOADING', 'SCANNING')");
    expect(sql).not.toMatch(/drop\s+(table|column)|truncate|update\s+community_content/i);
  });
});
