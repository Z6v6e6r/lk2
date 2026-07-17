-- Expand-only administrative access grants and manual notification campaigns.
-- Staff access remains tenant-scoped and is granted explicitly by an audited operator command.

create table if not exists identity.user_access_profiles (
  tenant_id uuid not null,
  user_id uuid not null,
  roles text[] not null default array['client']::text[],
  permissions text[] not null default array['profile.read']::text[],
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, updated_by) references identity.users(tenant_id, id),
  check (cardinality(roles) > 0),
  check (array_position(roles, null) is null),
  check (array_position(permissions, null) is null)
);

create index if not exists user_summaries_phone_lookup_idx
  on profile.user_summaries (tenant_id, phone_e164)
  where phone_e164 is not null;

create table if not exists notifications.admin_campaigns (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 300),
  body text not null check (char_length(body) between 1 and 8000),
  deep_link text,
  requested_channels text[] not null,
  state text not null default 'ACCEPTED' check (state in ('ACCEPTED', 'CANCELLED')),
  input_count integer not null check (input_count between 1 and 100),
  matched_count integer not null check (matched_count between 0 and input_count),
  unresolved_count integer not null check (unresolved_count = input_count - matched_count),
  in_app_created_count integer not null default 0 check (in_app_created_count >= 0),
  push_queued_count integer not null default 0 check (push_queued_count >= 0),
  suppressed_count integer not null default 0 check (suppressed_count >= 0),
  created_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, created_by_user_id) references identity.users(tenant_id, id),
  check (cardinality(requested_channels) > 0),
  check (
    requested_channels
      <@ array['IN_APP', 'WEB_PUSH', 'IOS_PUSH', 'ANDROID_PUSH']::text[]
  ),
  check (
    deep_link is null
    or (
      char_length(deep_link) between 1 and 2000
      and deep_link like '/%'
      and deep_link not like '//%'
      and position('\' in deep_link) = 0
    )
  )
);

create index if not exists admin_campaigns_created_idx
  on notifications.admin_campaigns (tenant_id, created_at desc, id);

create table if not exists notifications.admin_campaign_recipients (
  tenant_id uuid not null,
  campaign_id uuid not null,
  user_id uuid not null,
  intent_id uuid,
  state text not null check (state in ('PROJECTED', 'SUPPRESSED')),
  projected_channels text[] not null default '{}'::text[],
  suppression_reasons text[] not null default '{}'::text[],
  push_delivery_count integer not null default 0 check (push_delivery_count >= 0),
  created_at timestamptz not null default now(),
  primary key (tenant_id, campaign_id, user_id),
  foreign key (tenant_id, campaign_id)
    references notifications.admin_campaigns(tenant_id, id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, intent_id) references notifications.intents(tenant_id, id),
  check (
    projected_channels
      <@ array['IN_APP', 'WEB_PUSH', 'IOS_PUSH', 'ANDROID_PUSH']::text[]
  ),
  check (array_position(suppression_reasons, null) is null)
);

create index if not exists admin_campaign_recipients_user_idx
  on notifications.admin_campaign_recipients (tenant_id, user_id, created_at desc);

create table if not exists notifications.admin_campaign_commands (
  tenant_id uuid not null,
  actor_user_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  campaign_id uuid,
  result_state text not null default 'PENDING'
    check (result_state in ('PENDING', 'ACCEPTED')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (tenant_id, actor_user_id, idempotency_key),
  foreign key (tenant_id, actor_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, campaign_id)
    references notifications.admin_campaigns(tenant_id, id),
  check (
    (result_state = 'PENDING' and campaign_id is null and completed_at is null)
    or (result_state = 'ACCEPTED' and campaign_id is not null and completed_at is not null)
  )
);

alter table identity.user_access_profiles enable row level security;
alter table notifications.admin_campaigns enable row level security;
alter table notifications.admin_campaign_recipients enable row level security;
alter table notifications.admin_campaign_commands enable row level security;

create policy user_access_profiles_tenant_isolation
  on identity.user_access_profiles
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy admin_campaigns_tenant_isolation
  on notifications.admin_campaigns
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy admin_campaign_recipients_tenant_isolation
  on notifications.admin_campaign_recipients
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy admin_campaign_commands_tenant_isolation
  on notifications.admin_campaign_commands
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table identity.user_access_profiles force row level security;
alter table notifications.admin_campaigns force row level security;
alter table notifications.admin_campaign_recipients force row level security;
alter table notifications.admin_campaign_commands force row level security;
