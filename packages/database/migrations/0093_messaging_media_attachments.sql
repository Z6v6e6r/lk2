-- Expand-only LOCAL_ONLY chat media pipeline. One message may reference up to four attachments
-- (images or files) that were uploaded through the private S3 quarantine, scanned and marked READY
-- before the message exists. Object keys stay closed inside integration storage: a reader receives
-- only a short-lived signed URL for a READY asset that belongs to a conversation they can read and
-- that no moderation action has hidden.
-- phub:reviewed-new-table-index

set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table messaging.media_assets (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  conversation_id uuid not null,
  uploader_user_id uuid not null,
  media_type text not null check (media_type in ('IMAGE', 'FILE')),
  state text not null default 'UPLOADING'
    check (state in ('UPLOADING', 'SCANNING', 'READY', 'REJECTED', 'EXPIRED', 'PURGED')),
  declared_content_type text not null check (char_length(btrim(declared_content_type)) between 1 and 200),
  declared_size_bytes bigint not null check (declared_size_bytes between 1 and 15728640),
  declared_sha256 text not null check (declared_sha256 ~ '^[0-9a-f]{64}$'),
  source_object_key text not null check (char_length(source_object_key) between 1 and 1000),
  source_object_version text,
  source_etag text,
  source_content_type text,
  source_size_bytes bigint check (source_size_bytes is null or source_size_bytes between 1 and 15728640),
  source_sha256 text check (source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$'),
  ready_object_key text check (ready_object_key is null or char_length(ready_object_key) between 1 and 1000),
  bound_conversation_id uuid,
  bound_message_id uuid,
  revision integer not null default 1 check (revision > 0),
  scan_lease_owner text,
  scan_lease_expires_at timestamptz,
  scan_available_at timestamptz not null default now(),
  scan_attempts integer not null default 0 check (scan_attempts >= 0),
  scan_failed_at timestamptz,
  scan_failure_code text,
  rejection_code text,
  upload_expires_at timestamptz not null,
  finalized_at timestamptz,
  ready_at timestamptz,
  rejected_at timestamptz,
  unattached_expires_at timestamptz,
  expired_at timestamptz,
  purged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, conversation_id) references messaging.conversations(tenant_id, id),
  foreign key (tenant_id, uploader_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, bound_conversation_id) references messaging.conversations(tenant_id, id),
  foreign key (tenant_id, bound_message_id) references messaging.messages(tenant_id, id),
  unique (tenant_id, source_object_key),
  check (
    (state = 'UPLOADING' and source_object_version is null and finalized_at is null
      and ready_at is null and ready_object_key is null and rejected_at is null
      and rejection_code is null and unattached_expires_at is null)
    or (state = 'SCANNING' and source_object_version is not null and finalized_at is not null
      and ready_at is null and ready_object_key is null and rejected_at is null
      and rejection_code is null and unattached_expires_at is null)
    or (state = 'READY' and source_object_version is not null and ready_at is not null
      and ready_object_key is not null and rejected_at is null and rejection_code is null)
    or (state = 'REJECTED' and rejected_at is not null and rejection_code is not null
      and ready_at is null and ready_object_key is null)
    or (state in ('EXPIRED', 'PURGED') and expired_at is not null)
  ),
  check ((bound_message_id is null) = (bound_conversation_id is null)),
  check (bound_conversation_id is null or bound_conversation_id = conversation_id),
  check ((media_type = 'IMAGE') = (declared_content_type in ('image/jpeg', 'image/png', 'image/webp'))),
  -- A file is never served inline, so the only content types refused outright are the ones a browser
  -- would execute inside our own origin. Everything else is stored and downloaded as an attachment.
  check (declared_content_type not in (
    'text/html', 'application/xhtml+xml', 'image/svg+xml',
    'application/javascript', 'text/javascript'
  ))
);

-- One open upload per conversation and content hash keeps a double-tap from reserving twice.
create unique index media_assets_ready_object_key_idx
  on messaging.media_assets (tenant_id, ready_object_key)
  where ready_object_key is not null;

create index media_assets_scan_claim_idx
  on messaging.media_assets (tenant_id, scan_available_at, upload_expires_at)
  where state in ('UPLOADING', 'SCANNING');

create index media_assets_expiry_idx
  on messaging.media_assets (tenant_id, upload_expires_at)
  where state = 'UPLOADING';

create index media_assets_unattached_idx
  on messaging.media_assets (tenant_id, unattached_expires_at)
  where state = 'READY' and bound_message_id is null;

create index media_assets_conversation_idx
  on messaging.media_assets (tenant_id, conversation_id, created_at desc);

create table messaging.media_commands (
  tenant_id uuid not null,
  actor_user_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  command_type text not null check (command_type in ('ISSUE_UPLOAD', 'FINALIZE_UPLOAD')),
  media_id uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  result_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (tenant_id, actor_user_id, idempotency_key),
  foreign key (tenant_id, actor_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, media_id) references messaging.media_assets(tenant_id, id)
);

create table messaging.media_gc_jobs (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  media_id uuid not null,
  object_kind text not null check (object_kind in ('SOURCE', 'READY')),
  object_key text not null check (char_length(object_key) between 1 and 1000),
  object_version text not null check (char_length(object_version) between 1 and 200),
  lease_owner text,
  lease_expires_at timestamptz,
  available_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  dead_at timestamptz,
  failure_code text,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, media_id) references messaging.media_assets(tenant_id, id),
  unique (tenant_id, object_key, object_version)
);

create index media_gc_jobs_claim_idx
  on messaging.media_gc_jobs (tenant_id, available_at)
  where dead_at is null;

-- The attachment row is a frozen snapshot of one READY asset on one message. Ordering is explicit so
-- a message renders its four attachments deterministically.
alter table messaging.message_attachments
  add column media_id uuid,
  add column uploader_user_id uuid,
  add column position smallint;

alter table messaging.message_attachments
  alter column scan_state set default 'READY';

alter table messaging.message_attachments
  add constraint message_attachments_media_fkey
    foreign key (tenant_id, media_id) references messaging.media_assets(tenant_id, id),
  add constraint message_attachments_uploader_fkey
    foreign key (tenant_id, uploader_user_id) references identity.users(tenant_id, id),
  add constraint message_attachments_position_check
    check (position is null or position between 1 and 4);

-- The attachment row is a READY snapshot, so the four-state upload machine of migration 0007 no
-- longer applies here; the row keeps only the terminal READY state.
alter table messaging.message_attachments
  drop constraint if exists message_attachments_scan_state_check,
  add constraint message_attachments_ready_scan_check check (scan_state = 'READY');

create unique index message_attachments_message_media_idx
  on messaging.message_attachments (tenant_id, conversation_id, message_id, media_id);
create unique index message_attachments_message_position_idx
  on messaging.message_attachments (tenant_id, conversation_id, message_id, position);

-- Defence in depth: the send transaction already requires a READY asset, but the deferred trigger
-- makes attaching an unscanned or foreign message object impossible even if a future writer forgets.
create or replace function messaging.enforce_ready_attachment()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
      from messaging.media_assets media
     where media.tenant_id = new.tenant_id
       and media.id = new.media_id
       and media.state = 'READY'
       and media.bound_conversation_id = new.conversation_id
       and media.bound_message_id = new.message_id
  ) then
    raise exception 'MESSAGING_ATTACHMENT_NOT_READY';
  end if;
  return new;
end;
$$;

create constraint trigger message_attachments_ready_guard
after insert or update on messaging.message_attachments
deferrable initially deferred
for each row execute function messaging.enforce_ready_attachment();

alter table messaging.media_assets enable row level security;
alter table messaging.media_commands enable row level security;
alter table messaging.media_gc_jobs enable row level security;

create policy messaging_media_assets_tenant_isolation
  on messaging.media_assets
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy messaging_media_commands_tenant_isolation
  on messaging.media_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy messaging_media_gc_jobs_tenant_isolation
  on messaging.media_gc_jobs
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table messaging.media_assets force row level security;
alter table messaging.media_commands force row level security;
alter table messaging.media_gc_jobs force row level security;

-- A moderator hides a message rather than deleting it: the row, its attachments and the audit trail
-- stay, and every reader filter consults hidden_at. Author deletion stays a separate, unwritten path.
alter table messaging.messages
  add column hidden_at timestamptz,
  add column hidden_by_action_id uuid;

alter table messaging.messages
  add constraint messages_hidden_pair_check
    check ((hidden_at is null) = (hidden_by_action_id is null)),
  add constraint messages_hidden_by_action_fkey
    foreign key (tenant_id, hidden_by_action_id) references moderation.actions(tenant_id, id);

create index messages_hidden_idx
  on messaging.messages (tenant_id, conversation_id, hidden_at)
  where hidden_at is not null;
