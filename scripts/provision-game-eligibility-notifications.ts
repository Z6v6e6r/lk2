import { createDatabasePool, queryOne, withTenantTransaction } from '@phub/database';
import {
  GAME_ELIGIBILITY_NOTIFICATION_CANONICAL_CONTRACT,
  GAME_ELIGIBILITY_NOTIFICATION_REQUEST_HASH,
  GAME_ELIGIBILITY_NOTIFICATION_RULESET_VERSION,
} from '@phub/notifications';
import type { PoolClient, QueryResultRow } from 'pg';

const CONFIRMATION_TOKEN = 'APPLY_GAME_ELIGIBILITY_NOTIFICATION_RULESET';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const contract = GAME_ELIGIBILITY_NOTIFICATION_CANONICAL_CONTRACT;
const definition = contract.definitions[0];

interface TenantRow extends QueryResultRow {
  readonly id: string;
}

interface RuntimeRow extends QueryResultRow {
  readonly in_app_enabled: boolean;
  readonly web_push_enabled: boolean;
}

interface ProvisionCommandRow extends QueryResultRow {
  readonly request_hash: string;
  readonly result: unknown;
}

interface TemplateRow extends QueryResultRow {
  readonly id: string;
  readonly category: string;
  readonly channels: string[];
  readonly title_template: string;
  readonly body_template: string;
  readonly deep_link_template: string | null;
}

interface IdRow extends QueryResultRow {
  readonly id: string;
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

async function assertNotificationAdminAccess(
  client: PoolClient,
  tenantId: string,
  actorId: string,
): Promise<void> {
  const authorized = await client.query(
    `select 1
       from identity.users u
       join identity.user_access_profiles access
         on access.tenant_id = u.tenant_id and access.user_id = u.id
      where u.tenant_id = $1
        and u.id = $2
        and u.status = 'ACTIVE'
        and 'admin' = any(access.roles)
        and 'notifications.manage' = any(access.permissions)`,
    [tenantId, actorId],
  );
  if (authorized.rowCount !== 1) throw new Error('ADMIN_PERMISSION_REQUIRED');
}

function templateMatches(row: TemplateRow): boolean {
  return (
    row.category === contract.template.category &&
    JSON.stringify(row.channels) === JSON.stringify(contract.template.channels) &&
    row.title_template === definition.title &&
    row.body_template === definition.body &&
    row.deep_link_template === contract.template.deepLink
  );
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const tenantKey = argument('tenant-key');
const actorId = argument('actor-id');
const idempotencyKey = argument('idempotency-key');
const confirm = argument('confirm');
if (!tenantKey || !TENANT_KEY_PATTERN.test(tenantKey)) {
  throw new Error('--tenant-key must be a valid PadlHub tenant key');
}
if (!actorId || !UUID_PATTERN.test(actorId)) {
  throw new Error('--actor-id must be an active PadlHub user UUID in the tenant');
}
if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
  throw new Error('--idempotency-key must be 16-128 safe characters');
}

const pool = createDatabasePool(connectionString);
try {
  const tenant = await pool.query<TenantRow>(
    'select id from identity.tenants where tenant_key = $1 and active = true',
    [tenantKey],
  );
  const tenantId = tenant.rows[0]?.id;
  if (!tenantId) throw new Error('Tenant was not found or is inactive');

  const current = await withTenantTransaction(pool, tenantId, async (client) => {
    await assertNotificationAdminAccess(client, tenantId, actorId);
    const runtime = await queryOne<RuntimeRow>(
      client,
      `select in_app_enabled, web_push_enabled
         from notifications.tenant_runtime_settings
        where tenant_id = $1`,
      [tenantId],
    );
    const previous = await queryOne<ProvisionCommandRow>(
      client,
      `select request_hash, result
         from notifications.ruleset_provision_commands
        where tenant_id = $1 and idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    return { runtime, previous };
  });

  if (
    current.previous &&
    current.previous.request_hash !== GAME_ELIGIBILITY_NOTIFICATION_REQUEST_HASH
  ) {
    throw new Error('IDEMPOTENCY_KEY_REUSED');
  }

  const preview = {
    mode: confirm === CONFIRMATION_TOKEN ? 'apply' : 'dry-run',
    tenantKey,
    tenantId,
    actorId,
    rulesetVersion: GAME_ELIGIBILITY_NOTIFICATION_RULESET_VERSION,
    templateVersion: contract.template.version,
    locale: contract.template.locale,
    idempotencyKey,
    replay: Boolean(current.previous),
    inAppRuntimeEnabled: current.runtime?.in_app_enabled ?? false,
    webPushRuntimeEnabled: current.runtime?.web_push_enabled ?? false,
    runtimeChangedByThisCommand: false,
    sourceEventType: definition.sourceEventType,
  };

  if (confirm !== CONFIRMATION_TOKEN) {
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    process.stdout.write(`Re-run with --confirm=${CONFIRMATION_TOKEN} to apply.\n`);
    process.exitCode = 0;
  } else {
    const result = await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `notification-runtime:${tenantId}`,
      ]);
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `notification-ruleset:${tenantId}:${GAME_ELIGIBILITY_NOTIFICATION_RULESET_VERSION}`,
      ]);
      await assertNotificationAdminAccess(client, tenantId, actorId);

      const previous = await queryOne<ProvisionCommandRow>(
        client,
        `select request_hash, result
           from notifications.ruleset_provision_commands
          where tenant_id = $1 and idempotency_key = $2
          for update`,
        [tenantId, idempotencyKey],
      );
      if (previous) {
        if (previous.request_hash !== GAME_ELIGIBILITY_NOTIFICATION_REQUEST_HASH) {
          throw new Error('IDEMPOTENCY_KEY_REUSED');
        }
        return { replay: true, result: previous.result };
      }

      await client.query(
        `insert into notifications.templates (
           tenant_id, template_key, version, locale, category, channels,
           title_template, body_template, deep_link_template, active, created_by_user_id
         ) values ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10, $11)
         on conflict (tenant_id, template_key, version, locale) do nothing`,
        [
          tenantId,
          definition.key,
          contract.template.version,
          contract.template.locale,
          contract.template.category,
          [...contract.template.channels],
          definition.title,
          definition.body,
          contract.template.deepLink,
          contract.template.active,
          actorId,
        ],
      );
      const template = await queryOne<TemplateRow>(
        client,
        `select id, category, channels, title_template, body_template, deep_link_template
           from notifications.templates
          where tenant_id = $1 and template_key = $2 and version = $3 and locale = $4
          for update`,
        [tenantId, definition.key, contract.template.version, contract.template.locale],
      );
      if (!template) throw new Error('GAME_ELIGIBILITY_NOTIFICATION_TEMPLATE_WRITE_LOST');
      if (!templateMatches(template)) {
        throw new Error('GAME_ELIGIBILITY_NOTIFICATION_TEMPLATE_VERSION_CONFLICT');
      }
      await client.query(
        `update notifications.templates
            set active = false
          where tenant_id = $1 and template_key = $2 and locale = $3
            and id <> $4 and active = true`,
        [tenantId, definition.key, contract.template.locale, template.id],
      );
      await client.query(
        `update notifications.templates set active = $3
          where tenant_id = $1 and id = $2`,
        [tenantId, template.id, contract.template.active],
      );

      const rule = await queryOne<IdRow>(
        client,
        `insert into notifications.trigger_rules (
           tenant_id, rule_key, source_event_type, template_id, audience_selector,
           channel_override, mandatory, active, created_by_user_id
         ) values ($1, $2, $3, $4, $5::jsonb, $6::text[], $7, $8, $9)
         on conflict (tenant_id, rule_key) do update set
           source_event_type = excluded.source_event_type,
           template_id = excluded.template_id,
           audience_selector = excluded.audience_selector,
           channel_override = excluded.channel_override,
           mandatory = excluded.mandatory,
           active = excluded.active,
           updated_at = now()
        returning id`,
        [
          tenantId,
          `${definition.key}.${contract.rule.keySuffix}`,
          definition.sourceEventType,
          template.id,
          JSON.stringify(contract.rule.audienceSelector),
          [...contract.rule.channelOverride],
          definition.mandatory,
          contract.rule.active,
          actorId,
        ],
      );
      if (!rule) throw new Error('GAME_ELIGIBILITY_NOTIFICATION_RULE_WRITE_LOST');

      const appliedResult = {
        rulesetVersion: GAME_ELIGIBILITY_NOTIFICATION_RULESET_VERSION,
        templateVersion: contract.template.version,
        locale: contract.template.locale,
        templateId: template.id,
        ruleId: rule.id,
        runtimeChanged: false,
      };
      await client.query(
        `insert into notifications.ruleset_provision_commands (
           tenant_id, idempotency_key, ruleset_version, request_hash, actor_user_id, result
         ) values ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          tenantId,
          idempotencyKey,
          GAME_ELIGIBILITY_NOTIFICATION_RULESET_VERSION,
          GAME_ELIGIBILITY_NOTIFICATION_REQUEST_HASH,
          actorId,
          JSON.stringify(appliedResult),
        ],
      );
      await client.query(
        `insert into audit.audit_log (
           tenant_id, actor_id, action, resource_type, resource_id,
           result, correlation_id, new_value
         ) values ($1, $2, 'GAME_ELIGIBILITY_NOTIFICATION_RULESET_PROVISIONED', 'TENANT', $1,
                   'SUCCESS', $3, $4::jsonb)`,
        [
          tenantId,
          actorId,
          `game-eligibility-notification-ruleset:${idempotencyKey}`,
          JSON.stringify(appliedResult),
        ],
      );
      return { replay: false, result: appliedResult };
    });
    process.stdout.write(`${JSON.stringify({ ...preview, ...result, applied: true }, null, 2)}\n`);
  }
} finally {
  await pool.end();
}
