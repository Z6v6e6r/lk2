import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('messaging media attachments migration', () => {
  it('keeps the quarantine pipeline, bounded assets and forced tenant isolation', async () => {
    const sql = await readFile(
      new URL('../migrations/0093_messaging_media_attachments.sql', import.meta.url),
      'utf8',
    );

    expect(sql).toContain("set local lock_timeout = '5s'");
    expect(sql).toContain("set local statement_timeout = '30s'");
    expect(sql).toContain('phub:reviewed-new-table-index');
    expect(sql).toContain('create table messaging.media_assets');
    expect(sql).toContain('create table messaging.media_commands');
    expect(sql).toContain('create table messaging.media_gc_jobs');
    // Four attachments of at most 15 MiB each is the whole slice-1 budget.
    expect(sql).toContain(
      'declared_size_bytes bigint not null check (declared_size_bytes between 1 and 15728640)',
    );
    expect(sql).toContain(
      "check (state in ('UPLOADING', 'SCANNING', 'READY', 'REJECTED', 'EXPIRED', 'PURGED'))",
    );
    expect(sql).toContain(
      "check ((media_type = 'IMAGE') = (declared_content_type in ('image/jpeg', 'image/png', 'image/webp')))",
    );
    // Web content types a browser would execute inside our origin are refused at the schema level.
    expect(sql).toContain("'text/html', 'application/xhtml+xml', 'image/svg+xml'");
    expect(sql).toContain("'application/javascript', 'text/javascript'");
    expect(sql).not.toContain('application/pdf');
    expect(sql).not.toMatch(/\b(drop table|truncate|delete from)\b/i);
  });

  it('pins the ready version and the moderation hide state', async () => {
    const sql = await readFile(
      new URL('../migrations/0093_messaging_media_attachments.sql', import.meta.url),
      'utf8',
    );

    // Serving and garbage collection both address one exact object version.
    expect(sql).toContain('ready_object_version text');
    expect(sql).toContain('ready_object_version is not null');
    expect(sql).toContain("object_kind text not null check (object_kind in ('SOURCE', 'READY'))");
    expect(sql).toContain('add column hidden_at timestamptz');
    expect(sql).toContain('add column hidden_by_action_id uuid');
    expect(sql).toContain('check ((hidden_at is null) = (hidden_by_action_id is null))');
    expect(sql).toContain('references moderation.actions(tenant_id, id)');
    expect(sql).toContain('messages_hidden_idx');
    // A hidden message is never deleted: the row and its audit trail survive.
    expect(sql).not.toMatch(/delete from messaging\.messages/i);
  });

  it('requires every attachment to be bound to READY media in one deferred guard', async () => {
    const sql = await readFile(
      new URL('../migrations/0093_messaging_media_attachments.sql', import.meta.url),
      'utf8',
    );

    expect(sql).toContain('alter table messaging.message_attachments');
    expect(sql).toContain('add column media_id uuid');
    expect(sql).toContain('add column uploader_user_id uuid');
    expect(sql).toContain('add column position smallint');
    expect(sql).toContain('message_attachments_position_check');
    expect(sql).toContain('create constraint trigger message_attachments_ready_guard');
    expect(sql).toContain('deferrable initially deferred');
    expect(sql).toContain('execute function messaging.enforce_ready_attachment()');
    expect(sql).toContain("raise exception 'MESSAGING_ATTACHMENT_NOT_READY'");
    expect(sql).toContain("media.state = 'READY'");
    expect(sql).toContain('media.bound_conversation_id = new.conversation_id');
    expect(sql).toContain('media.bound_message_id = new.message_id');
    expect(sql.match(/enable row level security/g)).toHaveLength(3);
    expect(sql.match(/force row level security/g)).toHaveLength(3);
  });
});
