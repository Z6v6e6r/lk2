import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('community media migration', () => {
  it('creates a tenant-isolated immutable-version media lifecycle', async () => {
    const sql = await readFile(
      new URL('../migrations/0072_community_media_lifecycle.sql', import.meta.url),
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
    expect(sql).not.toMatch(/drop\s+(table|column)|truncate/i);
  });
});
