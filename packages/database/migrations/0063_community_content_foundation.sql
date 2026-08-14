-- Expand-only canonical Community Content foundation. Posts/comments are the
-- feed source of truth; no per-member feed copies are created.

create schema if not exists community_content;

create table if not exists community_content.posts (
  tenant_id uuid not null,
  community_id uuid not null,
  id uuid not null default gen_random_uuid(),
  author_user_id uuid not null,
  status text not null
    check (status in ('PENDING_MODERATION', 'PUBLISHED', 'ARCHIVED', 'HIDDEN')),
  body text check (body is null or char_length(body) between 1 and 10000),
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  restore_until timestamptz,
  retention_until timestamptz,
  hidden_at timestamptz,
  primary key (tenant_id, id),
  unique (tenant_id, community_id, id),
  foreign key (tenant_id, community_id)
    references communities.communities(tenant_id, id),
  foreign key (tenant_id, author_user_id)
    references identity.users(tenant_id, id),
  check (status <> 'PUBLISHED' or (published_at is not null and body is not null)),
  check (
    (status = 'ARCHIVED'
      and archived_at is not null
      and restore_until = archived_at + interval '30 days'
      and retention_until = archived_at + interval '5 years')
    or
    (status <> 'ARCHIVED'
      and archived_at is null
      and restore_until is null
      and retention_until is null)
  ),
  check (
    (status = 'HIDDEN' and hidden_at is not null)
    or (status <> 'HIDDEN' and hidden_at is null)
  )
);

create table if not exists community_content.post_revisions (
  tenant_id uuid not null,
  post_id uuid not null,
  revision bigint not null check (revision > 0),
  body text check (body is null or char_length(body) between 1 and 10000),
  lifecycle_status text not null
    check (lifecycle_status in ('PENDING_MODERATION', 'PUBLISHED', 'ARCHIVED', 'HIDDEN')),
  changed_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, post_id, revision),
  foreign key (tenant_id, post_id)
    references community_content.posts(tenant_id, id),
  foreign key (tenant_id, changed_by_user_id)
    references identity.users(tenant_id, id)
);

create table if not exists community_content.comments (
  tenant_id uuid not null,
  community_id uuid not null,
  post_id uuid not null,
  id uuid not null default gen_random_uuid(),
  author_user_id uuid not null,
  status text not null
    check (status in ('PUBLISHED', 'ARCHIVED', 'HIDDEN')),
  body text check (body is null or char_length(body) between 1 and 2000),
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  restore_until timestamptz,
  retention_until timestamptz,
  hidden_at timestamptz,
  primary key (tenant_id, id),
  unique (tenant_id, community_id, post_id, id),
  foreign key (tenant_id, community_id, post_id)
    references community_content.posts(tenant_id, community_id, id),
  foreign key (tenant_id, author_user_id)
    references identity.users(tenant_id, id),
  check (status <> 'PUBLISHED' or body is not null),
  check (
    (status = 'ARCHIVED'
      and archived_at is not null
      and restore_until = archived_at + interval '30 days'
      and retention_until = archived_at + interval '5 years')
    or
    (status <> 'ARCHIVED'
      and archived_at is null
      and restore_until is null
      and retention_until is null)
  ),
  check (
    (status = 'HIDDEN' and hidden_at is not null)
    or (status <> 'HIDDEN' and hidden_at is null)
  )
);

create table if not exists community_content.comment_revisions (
  tenant_id uuid not null,
  comment_id uuid not null,
  revision bigint not null check (revision > 0),
  body text check (body is null or char_length(body) between 1 and 2000),
  lifecycle_status text not null
    check (lifecycle_status in ('PUBLISHED', 'ARCHIVED', 'HIDDEN')),
  changed_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, comment_id, revision),
  foreign key (tenant_id, comment_id)
    references community_content.comments(tenant_id, id),
  foreign key (tenant_id, changed_by_user_id)
    references identity.users(tenant_id, id)
);

create table if not exists community_content.post_reactions (
  tenant_id uuid not null,
  post_id uuid not null,
  user_id uuid not null,
  reaction_type text check (reaction_type in ('LIKE', 'DISLIKE')),
  status text not null check (status in ('ACTIVE', 'REMOVED')),
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key (tenant_id, post_id, user_id),
  foreign key (tenant_id, post_id)
    references community_content.posts(tenant_id, id),
  foreign key (tenant_id, user_id)
    references identity.users(tenant_id, id),
  check (
    (status = 'ACTIVE' and reaction_type is not null and removed_at is null)
    or (status = 'REMOVED' and reaction_type is null and removed_at is not null)
  )
);

create table if not exists community_content.comment_reactions (
  tenant_id uuid not null,
  comment_id uuid not null,
  user_id uuid not null,
  reaction_type text check (reaction_type in ('LIKE', 'DISLIKE')),
  status text not null check (status in ('ACTIVE', 'REMOVED')),
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key (tenant_id, comment_id, user_id),
  foreign key (tenant_id, comment_id)
    references community_content.comments(tenant_id, id),
  foreign key (tenant_id, user_id)
    references identity.users(tenant_id, id),
  check (
    (status = 'ACTIVE' and reaction_type is not null and removed_at is null)
    or (status = 'REMOVED' and reaction_type is null and removed_at is not null)
  )
);

create table if not exists community_content.commands (
  tenant_id uuid not null,
  actor_user_id uuid not null,
  community_id uuid not null,
  command_type text not null check (command_type in (
    'POST_CREATE', 'POST_EDIT', 'POST_ARCHIVE', 'POST_RESTORE',
    'COMMENT_CREATE', 'COMMENT_EDIT', 'COMMENT_ARCHIVE', 'COMMENT_RESTORE',
    'POST_REACTION_SET', 'POST_REACTION_REMOVE',
    'COMMENT_REACTION_SET', 'COMMENT_REACTION_REMOVE'
  )),
  target_id uuid,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  result_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, actor_user_id, idempotency_key),
  foreign key (tenant_id, actor_user_id)
    references identity.users(tenant_id, id),
  foreign key (tenant_id, community_id)
    references communities.communities(tenant_id, id)
);

create index if not exists community_content_feed_keyset_idx
  on community_content.posts (tenant_id, community_id, published_at desc, id desc)
  where status = 'PUBLISHED';

create index if not exists community_content_comments_keyset_idx
  on community_content.comments (tenant_id, community_id, post_id, published_at, id)
  where status = 'PUBLISHED';

create index if not exists community_content_commands_target_idx
  on community_content.commands (tenant_id, community_id, target_id, created_at desc);

alter table community_content.posts enable row level security;
alter table community_content.post_revisions enable row level security;
alter table community_content.comments enable row level security;
alter table community_content.comment_revisions enable row level security;
alter table community_content.post_reactions enable row level security;
alter table community_content.comment_reactions enable row level security;
alter table community_content.commands enable row level security;

create policy community_content_posts_tenant_isolation on community_content.posts
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy community_content_post_revisions_tenant_isolation on community_content.post_revisions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy community_content_comments_tenant_isolation on community_content.comments
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy community_content_comment_revisions_tenant_isolation on community_content.comment_revisions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy community_content_post_reactions_tenant_isolation on community_content.post_reactions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy community_content_comment_reactions_tenant_isolation on community_content.comment_reactions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy community_content_commands_tenant_isolation on community_content.commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table community_content.posts force row level security;
alter table community_content.post_revisions force row level security;
alter table community_content.comments force row level security;
alter table community_content.comment_revisions force row level security;
alter table community_content.post_reactions force row level security;
alter table community_content.comment_reactions force row level security;
alter table community_content.commands force row level security;
