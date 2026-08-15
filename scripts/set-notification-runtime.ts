import { createDatabasePool, queryOne, withTenantTransaction } from '@phub/database';
import {
  BOOKING_NOTIFICATION_REQUEST_HASH,
  BOOKING_NOTIFICATION_RULESET_VERSION,
} from '@phub/notifications';
import type { QueryResultRow } from 'pg';

import { assertCanonicalBookingReminderReady } from './booking-notification-contract.js';
import { assertCommsOperatorAccess } from './messaging-runtime-access.js';

const CONFIRMATION_TOKEN = 'APPLY_NOTIFICATION_RUNTIME';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

interface TenantRow extends QueryResultRow {
  readonly id: string;
}

interface RuntimeRow extends QueryResultRow {
  readonly in_app_enabled: boolean;
  readonly web_push_enabled: boolean;
  readonly booking_reminders_enabled: boolean;
  readonly booking_reminder_ruleset_version: string | null;
  readonly booking_reminder_contract_hash: string | null;
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const tenantKey = argument('tenant-key');
const actorId = argument('actor-id');
const inApp = argument('in-app') ?? 'keep';
const webPush = argument('web-push') ?? 'keep';
const bookingReminders = argument('booking-reminders') ?? 'keep';
const confirm = argument('confirm');
if (!tenantKey || !TENANT_KEY_PATTERN.test(tenantKey)) {
  throw new Error('--tenant-key must be a valid PadlHub tenant key');
}
if (!actorId || !UUID_PATTERN.test(actorId)) {
  throw new Error('--actor-id must be an active PadlHub user UUID in the tenant');
}
if (inApp !== 'on' && inApp !== 'off' && inApp !== 'keep') {
  throw new Error('--in-app must be on, off or keep');
}
if (webPush !== 'on' && webPush !== 'off' && webPush !== 'keep') {
  throw new Error('--web-push must be on, off or keep');
}
if (bookingReminders !== 'on' && bookingReminders !== 'off' && bookingReminders !== 'keep') {
  throw new Error('--booking-reminders must be on, off or keep');
}
if (inApp === 'keep' && webPush === 'keep' && bookingReminders === 'keep') {
  throw new Error('At least one of --in-app, --web-push or --booking-reminders must be on or off');
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
    await assertCommsOperatorAccess(client, tenantId, actorId);
    return queryOne<RuntimeRow>(
      client,
      `select in_app_enabled, web_push_enabled, booking_reminders_enabled,
              booking_reminder_ruleset_version, booking_reminder_contract_hash
         from notifications.tenant_runtime_settings
        where tenant_id = $1`,
      [tenantId],
    );
  });
  const currentInAppEnabled = current?.in_app_enabled ?? false;
  const currentWebPushEnabled = current?.web_push_enabled ?? false;
  const currentBookingRemindersEnabled = current?.booking_reminders_enabled ?? false;
  const currentBookingReminderRulesetVersion = current?.booking_reminder_ruleset_version ?? null;
  const currentBookingReminderContractHash = current?.booking_reminder_contract_hash ?? null;
  const desiredInAppEnabled = inApp === 'keep' ? currentInAppEnabled : inApp === 'on';
  const desiredWebPushEnabled = webPush === 'keep' ? currentWebPushEnabled : webPush === 'on';
  const desiredBookingRemindersEnabled =
    bookingReminders === 'keep' ? currentBookingRemindersEnabled : bookingReminders === 'on';
  const desiredBookingReminderRulesetVersion = desiredBookingRemindersEnabled
    ? BOOKING_NOTIFICATION_RULESET_VERSION
    : null;
  const desiredBookingReminderContractHash = desiredBookingRemindersEnabled
    ? BOOKING_NOTIFICATION_REQUEST_HASH
    : null;
  if (desiredBookingRemindersEnabled && !desiredInAppEnabled && !desiredWebPushEnabled) {
    throw new Error('BOOKING_REMINDER_TRANSPORT_NOT_ENABLED');
  }
  if (desiredBookingRemindersEnabled) {
    await withTenantTransaction(pool, tenantId, async (client) => {
      await assertCommsOperatorAccess(client, tenantId, actorId);
      await assertCanonicalBookingReminderReady(
        client,
        tenantId,
        {
          inAppEnabled: desiredInAppEnabled,
          webPushEnabled: desiredWebPushEnabled,
        },
        false,
      );
    });
  }
  const preview = {
    mode: confirm === CONFIRMATION_TOKEN ? 'apply' : 'dry-run',
    tenantKey,
    tenantId,
    actorId,
    currentInAppEnabled,
    desiredInAppEnabled,
    currentWebPushEnabled,
    desiredWebPushEnabled,
    currentBookingRemindersEnabled,
    desiredBookingRemindersEnabled,
    currentBookingReminderRulesetVersion,
    desiredBookingReminderRulesetVersion,
    currentBookingReminderContractCurrent:
      currentBookingReminderRulesetVersion === BOOKING_NOTIFICATION_RULESET_VERSION &&
      currentBookingReminderContractHash === BOOKING_NOTIFICATION_REQUEST_HASH,
    desiredBookingReminderContractCurrent: desiredBookingRemindersEnabled,
  };
  if (confirm !== CONFIRMATION_TOKEN) {
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    process.stdout.write(`Re-run with --confirm=${CONFIRMATION_TOKEN} to apply.\n`);
    process.exitCode = 0;
  } else {
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `notification-runtime:${tenantId}`,
      ]);
      await assertCommsOperatorAccess(client, tenantId, actorId);

      const lockedCurrent = await queryOne<RuntimeRow>(
        client,
        `select in_app_enabled, web_push_enabled, booking_reminders_enabled,
                booking_reminder_ruleset_version, booking_reminder_contract_hash
           from notifications.tenant_runtime_settings
          where tenant_id = $1
          for update`,
        [tenantId],
      );
      if (
        (lockedCurrent?.in_app_enabled ?? false) !== currentInAppEnabled ||
        (lockedCurrent?.web_push_enabled ?? false) !== currentWebPushEnabled ||
        (lockedCurrent?.booking_reminders_enabled ?? false) !== currentBookingRemindersEnabled ||
        (lockedCurrent?.booking_reminder_ruleset_version ?? null) !==
          currentBookingReminderRulesetVersion ||
        (lockedCurrent?.booking_reminder_contract_hash ?? null) !==
          currentBookingReminderContractHash
      ) {
        throw new Error('NOTIFICATION_RUNTIME_CHANGED_CONCURRENTLY');
      }
      if (desiredBookingRemindersEnabled) {
        if (!desiredInAppEnabled && !desiredWebPushEnabled) {
          throw new Error('BOOKING_REMINDER_TRANSPORT_NOT_ENABLED');
        }
        await assertCanonicalBookingReminderReady(
          client,
          tenantId,
          {
            inAppEnabled: desiredInAppEnabled,
            webPushEnabled: desiredWebPushEnabled,
          },
          true,
        );
      }

      await client.query(
        `insert into notifications.tenant_runtime_settings (
           tenant_id, in_app_enabled, web_push_enabled, booking_reminders_enabled,
           booking_reminder_ruleset_version, booking_reminder_contract_hash, updated_by
         ) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (tenant_id) do update set
           in_app_enabled = excluded.in_app_enabled,
           web_push_enabled = excluded.web_push_enabled,
           booking_reminders_enabled = excluded.booking_reminders_enabled,
           booking_reminder_ruleset_version = excluded.booking_reminder_ruleset_version,
           booking_reminder_contract_hash = excluded.booking_reminder_contract_hash,
           updated_by = excluded.updated_by,
           updated_at = now()`,
        [
          tenantId,
          desiredInAppEnabled,
          desiredWebPushEnabled,
          desiredBookingRemindersEnabled,
          desiredBookingReminderRulesetVersion,
          desiredBookingReminderContractHash,
          actorId,
        ],
      );
      await client.query(
        `insert into audit.audit_log (
           tenant_id, actor_id, action, resource_type, resource_id,
           result, correlation_id, old_value, new_value
         ) values ($1, $2, 'NOTIFICATION_RUNTIME_CHANGED', 'TENANT', $1,
                   'SUCCESS', $3, $4::jsonb, $5::jsonb)`,
        [
          tenantId,
          actorId,
          `notification-runtime-${Date.now()}`,
          JSON.stringify({
            inAppEnabled: lockedCurrent?.in_app_enabled ?? false,
            webPushEnabled: lockedCurrent?.web_push_enabled ?? false,
            bookingRemindersEnabled: lockedCurrent?.booking_reminders_enabled ?? false,
            bookingReminderRulesetVersion: lockedCurrent?.booking_reminder_ruleset_version ?? null,
            bookingReminderContractHash: lockedCurrent?.booking_reminder_contract_hash ?? null,
          }),
          JSON.stringify({
            inAppEnabled: desiredInAppEnabled,
            webPushEnabled: desiredWebPushEnabled,
            bookingRemindersEnabled: desiredBookingRemindersEnabled,
            bookingReminderRulesetVersion: desiredBookingReminderRulesetVersion,
            bookingReminderContractHash: desiredBookingReminderContractHash,
          }),
        ],
      );
    });
    process.stdout.write(`${JSON.stringify({ ...preview, applied: true }, null, 2)}\n`);
  }
} finally {
  await pool.end();
}
