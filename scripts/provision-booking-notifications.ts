import { createHash } from 'node:crypto';

import { createDatabasePool, queryOne, withTenantTransaction } from '@phub/database';
import type { QueryResultRow } from 'pg';

const CONFIRMATION_TOKEN = 'APPLY_BOOKING_NOTIFICATION_RULESET';
const RULESET_VERSION = 'booking.ru-ru.v1';
const LOCALE = 'ru-RU';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

const definitions = [
  {
    key: 'booking.confirmed',
    sourceEventType: 'booking.confirmed.v1',
    title: 'Запись подтверждена',
    body: '{{serviceTitle}}: {{startsAt}}, {{locationName}}',
    mandatory: true,
  },
  {
    key: 'booking.changed',
    sourceEventType: 'booking.changed.v1',
    title: 'Запись изменена',
    body: '{{serviceTitle}}: новое время {{startsAt}}, {{locationName}}',
    mandatory: true,
  },
  {
    key: 'booking.cancelled',
    sourceEventType: 'booking.cancelled.v1',
    title: 'Запись отменена',
    body: '{{serviceTitle}}: {{startsAt}}, {{locationName}}',
    mandatory: true,
  },
  {
    key: 'booking.reminder',
    sourceEventType: 'booking.reminder.due.v1',
    title: 'Напоминание о записи',
    body: '{{serviceTitle}} начнётся {{startsAt}}, {{locationName}}',
    mandatory: false,
  },
] as const;

const requestHash = createHash('sha256')
  .update(JSON.stringify({ rulesetVersion: RULESET_VERSION, locale: LOCALE, definitions }))
  .digest('hex');

interface TenantRow extends QueryResultRow {
  readonly id: string;
}

interface RuntimeRow extends QueryResultRow {
  readonly in_app_enabled: boolean;
  readonly web_push_enabled: boolean;
}

interface ProvisionCommandRow extends QueryResultRow {
  readonly ruleset_version: string;
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

function templateMatches(row: TemplateRow, definition: (typeof definitions)[number]): boolean {
  return (
    row.category === 'BOOKING' &&
    JSON.stringify(row.channels) === JSON.stringify(['IN_APP', 'PUSH']) &&
    row.title_template === definition.title &&
    row.body_template === definition.body &&
    row.deep_link_template === '/bookings/{{bookingId}}'
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
    const actor = await client.query(
      `select 1
         from identity.users
        where tenant_id = $1 and id = $2 and status = 'ACTIVE'`,
      [tenantId, actorId],
    );
    if (actor.rowCount === 0) throw new Error('Actor is not an active user in the tenant');
    const runtime = await queryOne<RuntimeRow>(
      client,
      `select in_app_enabled, web_push_enabled
         from notifications.tenant_runtime_settings
        where tenant_id = $1`,
      [tenantId],
    );
    const previous = await queryOne<ProvisionCommandRow>(
      client,
      `select ruleset_version, request_hash, result
         from notifications.ruleset_provision_commands
        where tenant_id = $1 and idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    return { runtime, previous };
  });

  if (current.previous && current.previous.request_hash !== requestHash) {
    throw new Error('IDEMPOTENCY_KEY_REUSED');
  }

  const preview = {
    mode: confirm === CONFIRMATION_TOKEN ? 'apply' : 'dry-run',
    tenantKey,
    tenantId,
    actorId,
    rulesetVersion: RULESET_VERSION,
    locale: LOCALE,
    idempotencyKey,
    replay: Boolean(current.previous),
    inAppRuntimeEnabled: current.runtime?.in_app_enabled ?? false,
    webPushRuntimeEnabled: current.runtime?.web_push_enabled ?? false,
    runtimeChangedByThisCommand: false,
    definitions: definitions.map((definition) => ({
      key: definition.key,
      sourceEventType: definition.sourceEventType,
      mandatory: definition.mandatory,
    })),
  };

  if (confirm !== CONFIRMATION_TOKEN) {
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    process.stdout.write(`Re-run with --confirm=${CONFIRMATION_TOKEN} to apply.\n`);
    process.exitCode = 0;
  } else {
    const result = await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `notification-ruleset:${tenantId}:${RULESET_VERSION}`,
      ]);
      const actor = await client.query(
        `select 1
           from identity.users
          where tenant_id = $1 and id = $2 and status = 'ACTIVE'`,
        [tenantId, actorId],
      );
      if (actor.rowCount === 0) throw new Error('Actor is not an active user in the tenant');

      const previous = await queryOne<ProvisionCommandRow>(
        client,
        `select ruleset_version, request_hash, result
           from notifications.ruleset_provision_commands
          where tenant_id = $1 and idempotency_key = $2
          for update`,
        [tenantId, idempotencyKey],
      );
      if (previous) {
        if (previous.request_hash !== requestHash) throw new Error('IDEMPOTENCY_KEY_REUSED');
        return { replay: true, result: previous.result };
      }

      const templateIds: string[] = [];
      const ruleIds: string[] = [];
      for (const definition of definitions) {
        await client.query(
          `insert into notifications.templates (
             tenant_id, template_key, version, locale, category, channels,
             title_template, body_template, deep_link_template, active, created_by_user_id
           ) values ($1, $2, 1, $3, 'BOOKING', array['IN_APP', 'PUSH']::text[],
                     $4, $5, '/bookings/{{bookingId}}', false, $6)
           on conflict (tenant_id, template_key, version, locale) do nothing`,
          [tenantId, definition.key, LOCALE, definition.title, definition.body, actorId],
        );
        const template = await queryOne<TemplateRow>(
          client,
          `select id, category, channels, title_template, body_template, deep_link_template
             from notifications.templates
            where tenant_id = $1 and template_key = $2 and version = 1 and locale = $3
            for update`,
          [tenantId, definition.key, LOCALE],
        );
        if (!template) throw new Error('BOOKING_NOTIFICATION_TEMPLATE_WRITE_LOST');
        if (!templateMatches(template, definition)) {
          throw new Error(`BOOKING_NOTIFICATION_TEMPLATE_VERSION_CONFLICT:${definition.key}`);
        }
        await client.query(
          `update notifications.templates
              set active = false
            where tenant_id = $1 and template_key = $2 and locale = $3
              and id <> $4 and active = true`,
          [tenantId, definition.key, LOCALE, template.id],
        );
        await client.query(
          `update notifications.templates set active = true
            where tenant_id = $1 and id = $2`,
          [tenantId, template.id],
        );
        templateIds.push(template.id);

        const rule = await queryOne<IdRow>(
          client,
          `insert into notifications.trigger_rules (
             tenant_id, rule_key, source_event_type, template_id, audience_selector,
             channel_override, mandatory, active, created_by_user_id
           ) values ($1, $2, $3, $4,
                     '{"type":"EVENT_USERS","field":"recipientUserIds"}'::jsonb,
                     array['IN_APP', 'PUSH']::text[], $5, true, $6)
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
            `${definition.key}.default`,
            definition.sourceEventType,
            template.id,
            definition.mandatory,
            actorId,
          ],
        );
        if (!rule) throw new Error('BOOKING_NOTIFICATION_RULE_WRITE_LOST');
        ruleIds.push(rule.id);
      }

      const appliedResult = {
        rulesetVersion: RULESET_VERSION,
        locale: LOCALE,
        templateIds,
        ruleIds,
        runtimeChanged: false,
      };
      await client.query(
        `insert into notifications.ruleset_provision_commands (
           tenant_id, idempotency_key, ruleset_version, request_hash, actor_user_id, result
         ) values ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          tenantId,
          idempotencyKey,
          RULESET_VERSION,
          requestHash,
          actorId,
          JSON.stringify(appliedResult),
        ],
      );
      await client.query(
        `insert into audit.audit_log (
           tenant_id, actor_id, action, resource_type, resource_id,
           result, correlation_id, new_value
         ) values ($1, $2, 'BOOKING_NOTIFICATION_RULESET_PROVISIONED', 'TENANT', $1,
                   'SUCCESS', $3, $4::jsonb)`,
        [
          tenantId,
          actorId,
          `booking-notification-ruleset:${idempotencyKey}`,
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
