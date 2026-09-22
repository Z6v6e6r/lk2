import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { withTenantTransaction } from './connection.js';

/**
 * User-owned notification preferences. The projector reads these rows directly, so this repository
 * is the only writer and the aggregate stays tenant-scoped: every statement runs inside a
 * tenant transaction and the table is protected by RLS with FORCE RLS.
 */
export type NotificationPreferenceChannel = 'IN_APP' | 'PUSH';

export interface NotificationPreferenceChannelRule {
  readonly category: string;
  readonly channel: NotificationPreferenceChannel;
}

export interface NotificationPreferenceRecord {
  readonly category: string;
  readonly channel: NotificationPreferenceChannel;
  readonly enabled: boolean;
  readonly quietFrom?: string;
  readonly quietUntil?: string;
  readonly timezone: string;
}

export interface NotificationPreferenceUpdate {
  readonly category: string;
  readonly channel: NotificationPreferenceChannel;
  readonly enabled: boolean;
  readonly quietFrom?: string | null;
  readonly quietUntil?: string | null;
  readonly timezone?: string | null;
}

export interface NotificationPreferenceRepository {
  listConfigurableChannels(tenantId: string): Promise<readonly NotificationPreferenceChannelRule[]>;
  listPreferences(input: {
    readonly tenantId: string;
    readonly userId: string;
  }): Promise<readonly NotificationPreferenceRecord[]>;
  replacePreferences(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly entries: readonly NotificationPreferenceUpdate[];
    readonly correlationId: string;
  }): Promise<readonly NotificationPreferenceRecord[]>;
}

interface PreferenceRow extends QueryResultRow {
  readonly category: string;
  readonly channel: string;
  readonly enabled: boolean;
  readonly quiet_from: string | null;
  readonly quiet_until: string | null;
  readonly timezone: string;
}

interface ChannelRuleRow extends QueryResultRow {
  readonly category: string;
  readonly channel: string;
}

const DEFAULT_TIMEZONE = 'Europe/Moscow';

function isChannel(value: string): value is NotificationPreferenceChannel {
  return value === 'IN_APP' || value === 'PUSH';
}

function mapPreference(row: PreferenceRow): NotificationPreferenceRecord | undefined {
  if (!isChannel(row.channel)) return undefined;
  return {
    category: row.category,
    channel: row.channel,
    enabled: row.enabled,
    ...(row.quiet_from && row.quiet_until
      ? { quietFrom: row.quiet_from, quietUntil: row.quiet_until }
      : {}),
    timezone: row.timezone,
  };
}

function samePreference(
  current: NotificationPreferenceRecord,
  next: NotificationPreferenceRecord,
): boolean {
  return (
    current.enabled === next.enabled &&
    current.quietFrom === next.quietFrom &&
    current.quietUntil === next.quietUntil &&
    current.timezone === next.timezone
  );
}

function normalize(input: NotificationPreferenceUpdate): NotificationPreferenceRecord {
  const quietWindow =
    input.quietFrom && input.quietUntil
      ? { quietFrom: input.quietFrom, quietUntil: input.quietUntil }
      : {};
  return {
    category: input.category,
    channel: input.channel,
    enabled: input.enabled,
    ...quietWindow,
    timezone: input.timezone?.trim() || DEFAULT_TIMEZONE,
  };
}

async function readPreferences(
  client: PoolClient,
  tenantId: string,
  userId: string,
): Promise<readonly NotificationPreferenceRecord[]> {
  const result = await client.query<PreferenceRow>(
    `select category, channel, enabled,
            left(quiet_from::text, 5) as quiet_from,
            left(quiet_until::text, 5) as quiet_until,
            timezone
       from notifications.user_preferences
      where tenant_id = $1 and user_id = $2
        and channel in ('IN_APP', 'PUSH')
      order by category, channel`,
    [tenantId, userId],
  );
  return result.rows
    .map((row) => mapPreference(row))
    .filter((row): row is NotificationPreferenceRecord => row !== undefined);
}

export function createNotificationPreferenceRepository(
  pool: Pool,
): NotificationPreferenceRepository {
  return {
    listConfigurableChannels(tenantId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        // A user may only configure a category/channel pair that an active tenant rule can actually
        // deliver. ADMIN_MESSAGE has no trigger rule because a CUP campaign renders directly into
        // inbox and push, so it is named here instead of being invented by the UI.
        const result = await client.query<ChannelRuleRow>(
          `select category, channel
             from (
               select distinct t.category as category,
                      channel.value as channel
                 from notifications.trigger_rules r
                 join notifications.templates t
                   on t.tenant_id = r.tenant_id and t.id = r.template_id
                 cross join lateral unnest(coalesce(r.channel_override, t.channels))
                   as channel(value)
                where r.tenant_id = $1
                  and r.active = true
                  and t.active = true
                  and channel.value in ('IN_APP', 'PUSH')
               union
               select 'ADMIN_MESSAGE' as category, channel.value as channel
                 from unnest(array['IN_APP', 'PUSH']::text[]) as channel(value)
             ) configurable
            order by category, channel`,
          [tenantId],
        );
        return result.rows
          .filter((row) => isChannel(row.channel))
          .map((row) => ({
            category: row.category,
            channel: row.channel as NotificationPreferenceChannel,
          }));
      });
    },

    listPreferences(input) {
      return withTenantTransaction(pool, input.tenantId, (client) =>
        readPreferences(client, input.tenantId, input.userId),
      );
    },

    replacePreferences(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${input.tenantId}:NOTIFICATION_PREFERENCES:${input.userId}`,
        ]);
        const current = await readPreferences(client, input.tenantId, input.userId);
        const currentByKey = new Map(
          current.map((preference) => [`${preference.category}:${preference.channel}`, preference]),
        );
        const changed: { readonly category: string; readonly channel: string }[] = [];
        for (const entry of input.entries) {
          const next = normalize(entry);
          const previous = currentByKey.get(`${next.category}:${next.channel}`);
          if (previous && samePreference(previous, next)) continue;
          await client.query(
            `insert into notifications.user_preferences (
               tenant_id, user_id, category, channel, enabled,
               quiet_from, quiet_until, timezone, updated_at
             ) values ($1, $2, $3, $4, $5, $6::time, $7::time, $8, now())
             on conflict (tenant_id, user_id, category, channel) do update set
               enabled = excluded.enabled,
               quiet_from = excluded.quiet_from,
               quiet_until = excluded.quiet_until,
               timezone = excluded.timezone,
               updated_at = now()`,
            [
              input.tenantId,
              input.userId,
              next.category,
              next.channel,
              next.enabled,
              next.quietFrom ?? null,
              next.quietUntil ?? null,
              next.timezone,
            ],
          );
          changed.push({ category: next.category, channel: next.channel });
        }

        if (changed.length > 0) {
          await client.query(
            `insert into audit.audit_log (
               tenant_id, actor_id, action, resource_type, resource_id,
               result, correlation_id, new_value
             ) values ($1, $2, 'NOTIFICATION_PREFERENCES_UPDATED', 'NOTIFICATION_PREFERENCE', $2,
                       'SUCCESS', $3, $4::jsonb)`,
            [input.tenantId, input.userId, input.correlationId, JSON.stringify({ changed })],
          );
          await client.query(
            `insert into audit.outbox_events (
               tenant_id, event_type, aggregate_id, correlation_id, payload
             ) values ($1, 'notifications.preferences.updated.v1', $2, $3, $4::jsonb)`,
            [
              input.tenantId,
              input.userId,
              input.correlationId,
              JSON.stringify({ recipientUserId: input.userId, changed }),
            ],
          );
        }

        return readPreferences(client, input.tenantId, input.userId);
      });
    },
  };
}
