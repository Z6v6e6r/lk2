-- Expand-only storage foundation for chats, connector correspondence and notifications.
-- Runtime routes remain feature-gated until their authorization/audit handlers are deployed.

create schema if not exists moderation;

create table if not exists integration.messaging_connector_accounts (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  connector_type text not null check (connector_type ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 200),
  external_account_id text,
  credential_ref text not null check (char_length(btrim(credential_ref)) between 1 and 500),
  status text not null default 'DISABLED' check (status in ('ACTIVE', 'DISABLED', 'DEGRADED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, connector_type, external_account_id)
);

create table if not exists integration.messaging_contacts (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  connector_account_id uuid not null,
  external_contact_id text not null check (char_length(btrim(external_contact_id)) between 1 and 500),
  display_name text,
  linked_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, connector_account_id)
    references integration.messaging_connector_accounts(tenant_id, id),
  foreign key (tenant_id, linked_user_id)
    references identity.users(tenant_id, id),
  unique (tenant_id, connector_account_id, external_contact_id)
);

create table if not exists integration.notification_provider_accounts (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  channel text not null check (channel in ('PUSH', 'EMAIL', 'SMS', 'CONNECTOR')),
  platform text check (platform is null or platform in ('WEB', 'IOS', 'ANDROID')),
  provider text not null check (provider ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  app_id text not null check (char_length(btrim(app_id)) between 1 and 300),
  environment text not null check (environment in ('SANDBOX', 'PRODUCTION')),
  credential_ref text not null check (char_length(btrim(credential_ref)) between 1 and 500),
  status text not null default 'DISABLED' check (status in ('ACTIVE', 'DISABLED', 'DEGRADED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, id, channel),
  unique (tenant_id, channel, platform, provider, app_id, environment),
  check ((channel = 'PUSH' and platform is not null) or (channel <> 'PUSH' and platform is null))
);

create table if not exists integration.notification_endpoints (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  provider_account_id uuid not null,
  channel text not null check (channel in ('PUSH', 'EMAIL', 'SMS', 'CONNECTOR')),
  address_ciphertext bytea not null,
  address_hash text not null check (address_hash ~ '^[0-9a-f]{64}$'),
  encryption_key_id text not null check (char_length(btrim(encryption_key_id)) between 1 and 500),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'INVALID', 'REVOKED')),
  last_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, id, channel),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, provider_account_id, channel)
    references integration.notification_provider_accounts(tenant_id, id, channel),
  unique (tenant_id, user_id, provider_account_id, address_hash)
);

create table if not exists integration.moderation_provider_accounts (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  provider text not null check (provider ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 200),
  mode text not null check (mode in ('SIGNAL_ONLY', 'RECOMMEND_ONLY')),
  credential_ref text not null check (char_length(btrim(credential_ref)) between 1 and 500),
  status text not null default 'DISABLED' check (status in ('ACTIVE', 'DISABLED', 'DEGRADED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, provider, display_name)
);

create table if not exists messaging.conversations (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  kind text not null check (kind in ('DIRECT', 'GAME', 'TOURNAMENT', 'COMMUNITY', 'SUPPORT')),
  context_type text check (context_type is null or context_type in ('GAME', 'TOURNAMENT', 'COMMUNITY')),
  context_id uuid,
  title text check (title is null or char_length(btrim(title)) between 1 and 300),
  state text not null default 'OPEN' check (state in ('OPEN', 'CLOSED', 'ARCHIVED')),
  next_sequence bigint not null default 1 check (next_sequence > 0),
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, id, kind),
  foreign key (tenant_id, created_by_user_id) references identity.users(tenant_id, id),
  check (
    (kind in ('DIRECT', 'SUPPORT') and context_type is null and context_id is null)
    or (kind = 'GAME' and context_type = 'GAME' and context_id is not null)
    or (kind = 'TOURNAMENT' and context_type = 'TOURNAMENT' and context_id is not null)
    or (kind = 'COMMUNITY' and context_type = 'COMMUNITY' and context_id is not null)
  )
);

create unique index if not exists conversations_context_unique_idx
  on messaging.conversations (tenant_id, kind, context_id)
  where kind in ('GAME', 'TOURNAMENT', 'COMMUNITY');

create index if not exists conversations_updated_idx
  on messaging.conversations (tenant_id, updated_at desc, id);

create table if not exists messaging.direct_conversations (
  tenant_id uuid not null references identity.tenants(id),
  conversation_id uuid not null,
  conversation_kind text not null default 'DIRECT' check (conversation_kind = 'DIRECT'),
  left_user_id uuid not null,
  right_user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, conversation_id),
  foreign key (tenant_id, conversation_id, conversation_kind)
    references messaging.conversations(tenant_id, id, kind),
  foreign key (tenant_id, left_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, right_user_id) references identity.users(tenant_id, id),
  unique (tenant_id, left_user_id, right_user_id),
  check (left_user_id < right_user_id)
);

create table if not exists messaging.conversation_members (
  tenant_id uuid not null references identity.tenants(id),
  conversation_id uuid not null,
  id uuid not null default gen_random_uuid(),
  member_type text not null check (member_type in ('USER', 'EXTERNAL_CONTACT', 'SYSTEM')),
  user_id uuid,
  external_contact_id uuid,
  role text not null default 'MEMBER' check (role in ('OWNER', 'MODERATOR', 'MEMBER', 'AGENT', 'BOT')),
  state text not null default 'ACTIVE' check (state in ('ACTIVE', 'LEFT', 'REMOVED', 'BLOCKED')),
  notification_level text not null default 'ALL' check (notification_level in ('ALL', 'MENTIONS', 'NONE')),
  last_read_sequence bigint not null default 0 check (last_read_sequence >= 0),
  muted_until timestamptz,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (tenant_id, conversation_id, id),
  foreign key (tenant_id, conversation_id) references messaging.conversations(tenant_id, id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, external_contact_id)
    references integration.messaging_contacts(tenant_id, id),
  check (
    (member_type = 'USER' and user_id is not null and external_contact_id is null)
    or (member_type = 'EXTERNAL_CONTACT' and user_id is null and external_contact_id is not null)
    or (member_type = 'SYSTEM' and user_id is null and external_contact_id is null)
  ),
  check ((state = 'ACTIVE' and left_at is null) or state <> 'ACTIVE')
);

create unique index if not exists conversation_members_user_unique_idx
  on messaging.conversation_members (tenant_id, conversation_id, user_id)
  where user_id is not null;

create unique index if not exists conversation_members_contact_unique_idx
  on messaging.conversation_members (tenant_id, conversation_id, external_contact_id)
  where external_contact_id is not null;

create index if not exists conversation_members_user_lookup_idx
  on messaging.conversation_members (tenant_id, user_id, state, conversation_id)
  where user_id is not null;

create table if not exists messaging.messages (
  tenant_id uuid not null references identity.tenants(id),
  conversation_id uuid not null,
  id uuid not null default gen_random_uuid(),
  sequence bigint not null check (sequence > 0),
  sender_member_id uuid not null,
  client_message_id text not null check (char_length(client_message_id) between 16 and 128),
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  message_type text not null default 'TEXT' check (message_type in ('TEXT', 'IMAGE', 'FILE', 'SYSTEM', 'EVENT')),
  body text check (body is null or char_length(body) <= 8000),
  payload jsonb not null default '{}'::jsonb,
  reply_to_message_id uuid,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  primary key (tenant_id, conversation_id, id),
  unique (tenant_id, id),
  unique (tenant_id, conversation_id, sequence),
  unique (tenant_id, conversation_id, client_message_id),
  unique (tenant_id, conversation_id, idempotency_key),
  foreign key (tenant_id, conversation_id) references messaging.conversations(tenant_id, id),
  foreign key (tenant_id, conversation_id, sender_member_id)
    references messaging.conversation_members(tenant_id, conversation_id, id),
  foreign key (tenant_id, conversation_id, reply_to_message_id)
    references messaging.messages(tenant_id, conversation_id, id),
  check (edited_at is null or edited_at >= created_at),
  check (deleted_at is null or deleted_at >= created_at)
);

create index if not exists messages_conversation_sequence_idx
  on messaging.messages (tenant_id, conversation_id, sequence desc);

create table if not exists messaging.message_revisions (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  conversation_id uuid not null,
  message_id uuid not null,
  version integer not null check (version > 0),
  previous_body text,
  previous_payload jsonb not null default '{}'::jsonb,
  edited_by_member_id uuid not null,
  edited_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, conversation_id, message_id)
    references messaging.messages(tenant_id, conversation_id, id),
  foreign key (tenant_id, conversation_id, edited_by_member_id)
    references messaging.conversation_members(tenant_id, conversation_id, id),
  unique (tenant_id, conversation_id, message_id, version)
);

create table if not exists messaging.message_attachments (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  conversation_id uuid not null,
  message_id uuid not null,
  object_key text not null check (char_length(btrim(object_key)) between 1 and 1000),
  file_name text not null check (char_length(btrim(file_name)) between 1 and 500),
  content_type text not null check (char_length(btrim(content_type)) between 1 and 200),
  size_bytes bigint not null check (size_bytes between 1 and 52428800),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  scan_state text not null default 'UPLOADING' check (scan_state in ('UPLOADING', 'SCANNING', 'READY', 'REJECTED')),
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  primary key (tenant_id, id),
  foreign key (tenant_id, conversation_id, message_id)
    references messaging.messages(tenant_id, conversation_id, id),
  unique (tenant_id, object_key),
  check ((scan_state = 'READY' and ready_at is not null) or scan_state <> 'READY')
);

create table if not exists integration.messaging_thread_links (
  tenant_id uuid not null references identity.tenants(id),
  connector_account_id uuid not null,
  conversation_id uuid not null,
  external_thread_id text not null check (char_length(btrim(external_thread_id)) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, connector_account_id, conversation_id),
  foreign key (tenant_id, connector_account_id)
    references integration.messaging_connector_accounts(tenant_id, id),
  foreign key (tenant_id, conversation_id)
    references messaging.conversations(tenant_id, id),
  unique (tenant_id, connector_account_id, external_thread_id)
);

create table if not exists integration.messaging_message_links (
  tenant_id uuid not null references identity.tenants(id),
  connector_account_id uuid not null,
  message_id uuid not null,
  external_message_id text not null check (char_length(btrim(external_message_id)) between 1 and 500),
  direction text not null check (direction in ('INBOUND', 'OUTBOUND')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, connector_account_id, message_id),
  foreign key (tenant_id, connector_account_id)
    references integration.messaging_connector_accounts(tenant_id, id),
  foreign key (tenant_id, message_id) references messaging.messages(tenant_id, id),
  unique (tenant_id, connector_account_id, external_message_id)
);

create table if not exists notifications.templates (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  template_key text not null check (template_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  version integer not null check (version > 0),
  locale text not null default 'ru-RU' check (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  category text not null check (category ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  channels text[] not null,
  title_template text not null check (char_length(title_template) between 1 and 300),
  body_template text not null check (char_length(body_template) between 1 and 8000),
  deep_link_template text,
  active boolean not null default false,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, created_by_user_id) references identity.users(tenant_id, id),
  unique (tenant_id, template_key, version, locale),
  check (cardinality(channels) > 0),
  check (channels <@ array['IN_APP', 'PUSH', 'EMAIL', 'SMS', 'CONNECTOR']::text[])
);

create unique index if not exists notification_templates_active_unique_idx
  on notifications.templates (tenant_id, template_key, locale)
  where active;

create table if not exists notifications.trigger_rules (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  rule_key text not null check (rule_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  source_event_type text not null check (source_event_type ~ '^[a-z][a-z0-9_.-]+\.v[1-9][0-9]*$'),
  template_id uuid not null,
  audience_selector jsonb not null default '{}'::jsonb,
  channel_override text[],
  mandatory boolean not null default false,
  active boolean not null default false,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, template_id) references notifications.templates(tenant_id, id),
  foreign key (tenant_id, created_by_user_id) references identity.users(tenant_id, id),
  unique (tenant_id, rule_key),
  check (
    channel_override is null
    or (
      cardinality(channel_override) > 0
      and channel_override <@ array['IN_APP', 'PUSH', 'EMAIL', 'SMS', 'CONNECTOR']::text[]
    )
  )
);

create table if not exists notifications.user_preferences (
  tenant_id uuid not null references identity.tenants(id),
  user_id uuid not null,
  category text not null check (category ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  channel text not null check (channel in ('IN_APP', 'PUSH', 'EMAIL', 'SMS', 'CONNECTOR')),
  enabled boolean not null default true,
  quiet_from time,
  quiet_until time,
  timezone text not null default 'Europe/Moscow',
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id, category, channel),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  check ((quiet_from is null and quiet_until is null) or (quiet_from is not null and quiet_until is not null))
);

create table if not exists notifications.intents (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  recipient_user_id uuid not null,
  source_event_id uuid not null,
  trigger_rule_id uuid,
  template_id uuid not null,
  dedupe_key text not null check (char_length(dedupe_key) between 16 and 200),
  locale text not null default 'ru-RU',
  render_data jsonb not null default '{}'::jsonb,
  rendered_title text not null check (char_length(rendered_title) between 1 and 300),
  rendered_body text not null check (char_length(rendered_body) between 1 and 8000),
  rendered_deep_link text,
  state text not null default 'PENDING' check (state in ('PENDING', 'PROCESSING', 'DELIVERED', 'PARTIAL', 'FAILED', 'SUPPRESSED')),
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (tenant_id, id),
  foreign key (tenant_id, recipient_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, trigger_rule_id) references notifications.trigger_rules(tenant_id, id),
  foreign key (tenant_id, template_id) references notifications.templates(tenant_id, id),
  unique (tenant_id, dedupe_key),
  check (
    (state in ('DELIVERED', 'PARTIAL', 'FAILED', 'SUPPRESSED') and completed_at is not null)
    or (state in ('PENDING', 'PROCESSING') and completed_at is null)
  )
);

create index if not exists notification_intents_pending_idx
  on notifications.intents (tenant_id, available_at, created_at)
  where state in ('PENDING', 'PROCESSING');

create table if not exists notifications.inbox_items (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  intent_id uuid not null,
  user_id uuid not null,
  category text not null check (category ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  title text not null check (char_length(title) between 1 and 300),
  body text not null check (char_length(body) between 1 and 8000),
  deep_link text,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  dismissed_at timestamptz,
  primary key (tenant_id, id),
  foreign key (tenant_id, intent_id) references notifications.intents(tenant_id, id),
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id),
  unique (tenant_id, intent_id),
  check (dismissed_at is null or read_at is not null)
);

create index if not exists notification_inbox_user_idx
  on notifications.inbox_items (tenant_id, user_id, created_at desc, id);

create table if not exists notifications.deliveries (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  intent_id uuid not null,
  channel text not null check (channel in ('IN_APP', 'PUSH', 'EMAIL', 'SMS', 'CONNECTOR')),
  endpoint_id uuid,
  state text not null default 'PENDING' check (state in ('PENDING', 'SENDING', 'SENT', 'DELIVERED', 'FAILED', 'DEAD', 'SUPPRESSED')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]*$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (tenant_id, id),
  foreign key (tenant_id, intent_id) references notifications.intents(tenant_id, id),
  foreign key (tenant_id, endpoint_id, channel)
    references integration.notification_endpoints(tenant_id, id, channel),
  check ((channel = 'IN_APP' and endpoint_id is null) or (channel <> 'IN_APP' and endpoint_id is not null)),
  check (
    (state in ('SENT', 'DELIVERED', 'FAILED', 'DEAD', 'SUPPRESSED') and completed_at is not null)
    or (state in ('PENDING', 'SENDING') and completed_at is null)
  )
);

create unique index if not exists notification_deliveries_endpoint_unique_idx
  on notifications.deliveries (tenant_id, intent_id, channel, endpoint_id)
  where endpoint_id is not null;

create unique index if not exists notification_deliveries_in_app_unique_idx
  on notifications.deliveries (tenant_id, intent_id, channel)
  where channel = 'IN_APP';

create index if not exists notification_deliveries_retry_idx
  on notifications.deliveries (tenant_id, next_attempt_at, created_at)
  where state in ('PENDING', 'SENDING');

create table if not exists notifications.delivery_attempts (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  delivery_id uuid not null,
  attempt_no integer not null check (attempt_no > 0),
  outcome text not null check (outcome in ('SENT', 'DELIVERED', 'RETRYABLE_FAILURE', 'TERMINAL_FAILURE')),
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]*$'),
  started_at timestamptz not null default now(),
  completed_at timestamptz not null,
  primary key (tenant_id, id),
  foreign key (tenant_id, delivery_id) references notifications.deliveries(tenant_id, id),
  unique (tenant_id, delivery_id, attempt_no),
  check (completed_at >= started_at)
);

create table if not exists notifications.delivery_receipts (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  delivery_id uuid not null,
  receipt_key text not null check (char_length(receipt_key) between 16 and 200),
  receipt_type text not null check (receipt_type in ('PROVIDER_ACCEPTED', 'PROVIDER_DELIVERED', 'DISPLAYED', 'OPENED')),
  source text not null check (source in ('PROVIDER', 'CLIENT')),
  platform text check (platform is null or platform in ('WEB', 'IOS', 'ANDROID')),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  primary key (tenant_id, id),
  foreign key (tenant_id, delivery_id) references notifications.deliveries(tenant_id, id),
  unique (tenant_id, receipt_key),
  check (received_at >= occurred_at - interval '5 minutes'),
  check (
    (receipt_type in ('DISPLAYED', 'OPENED') and source = 'CLIENT')
    or (receipt_type in ('PROVIDER_ACCEPTED', 'PROVIDER_DELIVERED') and source = 'PROVIDER')
  )
);

create table if not exists integration.notification_provider_links (
  tenant_id uuid not null references identity.tenants(id),
  delivery_id uuid not null,
  provider_account_id uuid not null,
  external_message_id text not null check (char_length(btrim(external_message_id)) between 1 and 500),
  created_at timestamptz not null default now(),
  primary key (tenant_id, delivery_id),
  foreign key (tenant_id, delivery_id) references notifications.deliveries(tenant_id, id),
  foreign key (tenant_id, provider_account_id)
    references integration.notification_provider_accounts(tenant_id, id),
  unique (tenant_id, provider_account_id, external_message_id)
);

create table if not exists moderation.policies (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  policy_key text not null check (policy_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  version integer not null check (version > 0),
  scope text not null check (scope in ('DIRECT', 'GAME', 'TOURNAMENT', 'COMMUNITY', 'SUPPORT', 'ALL')),
  rules jsonb not null default '{}'::jsonb,
  active boolean not null default false,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, created_by_user_id) references identity.users(tenant_id, id),
  unique (tenant_id, policy_key, version)
);

create unique index if not exists moderation_policies_active_unique_idx
  on moderation.policies (tenant_id, policy_key)
  where active;

create table if not exists moderation.cases (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  conversation_id uuid not null,
  message_id uuid,
  subject_member_id uuid,
  source text not null check (source in ('USER_REPORT', 'PADLHUB_RULE', 'STAFF', 'EXTERNAL_SIGNAL')),
  dedupe_key text not null check (char_length(dedupe_key) between 16 and 200),
  severity text not null check (severity in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  reason_code text not null check (reason_code ~ '^[A-Z][A-Z0-9_]*$'),
  state text not null default 'OPEN' check (state in ('OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED', 'REOPENED')),
  version integer not null default 1 check (version > 0),
  assigned_to_user_id uuid,
  quarantine_until timestamptz,
  evidence_object_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  primary key (tenant_id, id),
  unique (tenant_id, dedupe_key),
  foreign key (tenant_id, conversation_id) references messaging.conversations(tenant_id, id),
  foreign key (tenant_id, conversation_id, message_id)
    references messaging.messages(tenant_id, conversation_id, id),
  foreign key (tenant_id, conversation_id, subject_member_id)
    references messaging.conversation_members(tenant_id, conversation_id, id),
  foreign key (tenant_id, assigned_to_user_id) references identity.users(tenant_id, id),
  check (message_id is not null or subject_member_id is not null),
  check (
    (state in ('RESOLVED', 'DISMISSED') and resolved_at is not null)
    or (state in ('OPEN', 'IN_REVIEW', 'REOPENED') and resolved_at is null)
  )
);

create index if not exists moderation_cases_queue_idx
  on moderation.cases (tenant_id, state, severity, created_at);

create table if not exists moderation.reports (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  conversation_id uuid not null,
  message_id uuid not null,
  reporter_user_id uuid not null,
  reason_code text not null check (reason_code ~ '^[A-Z][A-Z0-9_]*$'),
  details text check (details is null or char_length(details) <= 2000),
  state text not null default 'SUBMITTED' check (state in ('SUBMITTED', 'TRIAGED', 'DISMISSED')),
  case_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, conversation_id, message_id)
    references messaging.messages(tenant_id, conversation_id, id),
  foreign key (tenant_id, reporter_user_id) references identity.users(tenant_id, id),
  foreign key (tenant_id, case_id) references moderation.cases(tenant_id, id),
  unique (tenant_id, message_id, reporter_user_id, reason_code)
);

create table if not exists moderation.actions (
  tenant_id uuid not null references identity.tenants(id),
  id uuid not null default gen_random_uuid(),
  case_id uuid not null,
  action_type text not null check (
    action_type in (
      'DISMISS',
      'REDACT_MESSAGE',
      'RESTORE_MESSAGE',
      'WARN',
      'MUTE_MEMBER',
      'UNMUTE_MEMBER',
      'REMOVE_MEMBER',
      'RESTORE_MEMBER',
      'CLOSE_CONVERSATION',
      'REOPEN_CONVERSATION',
      'BLOCK_USER',
      'UNBLOCK_USER',
      'QUARANTINE',
      'RELEASE_QUARANTINE'
    )
  ),
  actor_type text not null check (actor_type in ('STAFF', 'PADLHUB_AUTOMATION')),
  actor_user_id uuid,
  reason_code text not null check (reason_code ~ '^[A-Z][A-Z0-9_]*$'),
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  expires_at timestamptz,
  correlation_id text not null check (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, case_id) references moderation.cases(tenant_id, id),
  foreign key (tenant_id, actor_user_id) references identity.users(tenant_id, id),
  check (
    (actor_type = 'STAFF' and actor_user_id is not null)
    or (actor_type = 'PADLHUB_AUTOMATION' and actor_user_id is null)
  )
);

create table if not exists integration.moderation_signal_links (
  tenant_id uuid not null references identity.tenants(id),
  provider_account_id uuid not null,
  external_signal_id text not null check (char_length(btrim(external_signal_id)) between 1 and 500),
  case_id uuid not null,
  risk_score numeric(5, 4) check (risk_score is null or risk_score between 0 and 1),
  recommended_action text,
  received_at timestamptz not null default now(),
  primary key (tenant_id, provider_account_id, external_signal_id),
  foreign key (tenant_id, provider_account_id)
    references integration.moderation_provider_accounts(tenant_id, id),
  foreign key (tenant_id, case_id) references moderation.cases(tenant_id, id)
);

alter table integration.messaging_connector_accounts enable row level security;
alter table integration.messaging_contacts enable row level security;
alter table integration.notification_provider_accounts enable row level security;
alter table integration.notification_endpoints enable row level security;
alter table integration.moderation_provider_accounts enable row level security;
alter table integration.messaging_thread_links enable row level security;
alter table integration.messaging_message_links enable row level security;
alter table integration.notification_provider_links enable row level security;
alter table integration.moderation_signal_links enable row level security;
alter table messaging.conversations enable row level security;
alter table messaging.direct_conversations enable row level security;
alter table messaging.conversation_members enable row level security;
alter table messaging.messages enable row level security;
alter table messaging.message_revisions enable row level security;
alter table messaging.message_attachments enable row level security;
alter table notifications.templates enable row level security;
alter table notifications.trigger_rules enable row level security;
alter table notifications.user_preferences enable row level security;
alter table notifications.intents enable row level security;
alter table notifications.inbox_items enable row level security;
alter table notifications.deliveries enable row level security;
alter table notifications.delivery_attempts enable row level security;
alter table notifications.delivery_receipts enable row level security;
alter table moderation.policies enable row level security;
alter table moderation.cases enable row level security;
alter table moderation.reports enable row level security;
alter table moderation.actions enable row level security;

create policy messaging_connector_accounts_tenant_isolation on integration.messaging_connector_accounts
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy messaging_contacts_tenant_isolation on integration.messaging_contacts
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy notification_provider_accounts_tenant_isolation on integration.notification_provider_accounts
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy notification_endpoints_tenant_isolation on integration.notification_endpoints
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy moderation_provider_accounts_tenant_isolation on integration.moderation_provider_accounts
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy messaging_thread_links_tenant_isolation on integration.messaging_thread_links
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy messaging_message_links_tenant_isolation on integration.messaging_message_links
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy notification_provider_links_tenant_isolation on integration.notification_provider_links
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy moderation_signal_links_tenant_isolation on integration.moderation_signal_links
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy conversations_tenant_isolation on messaging.conversations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy direct_conversations_tenant_isolation on messaging.direct_conversations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy conversation_members_tenant_isolation on messaging.conversation_members
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy messages_tenant_isolation on messaging.messages
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy message_revisions_tenant_isolation on messaging.message_revisions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy message_attachments_tenant_isolation on messaging.message_attachments
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy notification_templates_tenant_isolation on notifications.templates
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy notification_trigger_rules_tenant_isolation on notifications.trigger_rules
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy notification_user_preferences_tenant_isolation on notifications.user_preferences
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy notification_intents_tenant_isolation on notifications.intents
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy notification_inbox_items_tenant_isolation on notifications.inbox_items
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy notification_deliveries_tenant_isolation on notifications.deliveries
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy notification_delivery_attempts_tenant_isolation on notifications.delivery_attempts
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy notification_delivery_receipts_tenant_isolation on notifications.delivery_receipts
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy moderation_policies_tenant_isolation on moderation.policies
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy moderation_cases_tenant_isolation on moderation.cases
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy moderation_reports_tenant_isolation on moderation.reports
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy moderation_actions_tenant_isolation on moderation.actions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table integration.messaging_connector_accounts force row level security;
alter table integration.messaging_contacts force row level security;
alter table integration.notification_provider_accounts force row level security;
alter table integration.notification_endpoints force row level security;
alter table integration.moderation_provider_accounts force row level security;
alter table integration.messaging_thread_links force row level security;
alter table integration.messaging_message_links force row level security;
alter table integration.notification_provider_links force row level security;
alter table integration.moderation_signal_links force row level security;
alter table messaging.conversations force row level security;
alter table messaging.direct_conversations force row level security;
alter table messaging.conversation_members force row level security;
alter table messaging.messages force row level security;
alter table messaging.message_revisions force row level security;
alter table messaging.message_attachments force row level security;
alter table notifications.templates force row level security;
alter table notifications.trigger_rules force row level security;
alter table notifications.user_preferences force row level security;
alter table notifications.intents force row level security;
alter table notifications.inbox_items force row level security;
alter table notifications.deliveries force row level security;
alter table notifications.delivery_attempts force row level security;
alter table notifications.delivery_receipts force row level security;
alter table moderation.policies force row level security;
alter table moderation.cases force row level security;
alter table moderation.reports force row level security;
alter table moderation.actions force row level security;

do $$
declare
  current_tenant_id uuid;
begin
  for current_tenant_id in select id from identity.tenants loop
    perform set_config('app.tenant_id', current_tenant_id::text, true);
    insert into integration.domain_ownership (tenant_id, domain_name, ownership_mode)
    select current_tenant_id, domain_name, 'LOCAL_ONLY'
    from (values ('messaging'), ('notifications'), ('moderation')) as domain(domain_name)
    on conflict (tenant_id, domain_name) do nothing;
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;
