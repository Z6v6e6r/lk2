import type { Pool, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export interface NotificationRuntimeSettings {
  readonly inAppEnabled: boolean;
  readonly webPushEnabled: boolean;
  readonly iosPushEnabled: boolean;
  readonly androidPushEnabled: boolean;
}

export interface NotificationInboxItem {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly body: string;
  readonly deepLink?: string;
  readonly createdAt: string;
  readonly readAt?: string;
}

export interface NotificationInboxPosition {
  readonly createdAt: string;
  readonly id: string;
}

export interface NotificationInboxPage {
  readonly items: readonly NotificationInboxItem[];
  readonly unreadCount: number;
  readonly next?: NotificationInboxPosition;
}

export type MarkNotificationReadResult =
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'idempotency_conflict' }
  | {
      readonly outcome: 'updated';
      readonly readThrough: NotificationInboxPosition;
      readonly changedCount: number;
      readonly replayed: boolean;
    };

export interface NotificationInboxRepository {
  getRuntimeSettings(tenantId: string): Promise<NotificationRuntimeSettings>;
  listInbox(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly limit: number;
    readonly unreadOnly: boolean;
    readonly before?: NotificationInboxPosition;
  }): Promise<NotificationInboxPage>;
  markReadThrough(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly throughItemId: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<MarkNotificationReadResult>;
}

interface RuntimeRow extends QueryResultRow {
  readonly in_app_enabled: boolean;
  readonly web_push_enabled: boolean;
  readonly ios_push_enabled: boolean;
  readonly android_push_enabled: boolean;
}

interface InboxRow extends QueryResultRow {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly body: string;
  readonly deep_link: string | null;
  readonly created_at: Date | string;
  readonly read_at: Date | string | null;
}

interface CountRow extends QueryResultRow {
  readonly unread_count: number;
}

interface PositionRow extends QueryResultRow {
  readonly id: string;
  readonly created_at: Date | string;
}

interface CommandRow extends QueryResultRow {
  readonly through_item_id: string;
  readonly result_cursor_item_id: string;
  readonly result_cursor_created_at: Date | string;
  readonly changed_count: number;
}

function timestamp(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const normalized = value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  if (!Number.isFinite(Date.parse(normalized))) throw new Error('NOTIFICATION_TIMESTAMP_INVALID');
  return normalized;
}

function mapInboxItem(row: InboxRow): NotificationInboxItem {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    body: row.body,
    ...(row.deep_link ? { deepLink: row.deep_link } : {}),
    createdAt: timestamp(row.created_at),
    ...(row.read_at ? { readAt: timestamp(row.read_at) } : {}),
  };
}

function mapPosition(row: PositionRow): NotificationInboxPosition {
  return { id: row.id, createdAt: timestamp(row.created_at) };
}

function isAfter(left: NotificationInboxPosition, right: NotificationInboxPosition): boolean {
  return (
    left.createdAt > right.createdAt || (left.createdAt === right.createdAt && left.id > right.id)
  );
}

export function createNotificationInboxRepository(pool: Pool): NotificationInboxRepository {
  return {
    getRuntimeSettings(tenantId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<RuntimeRow>(
          client,
          `select in_app_enabled, web_push_enabled, ios_push_enabled, android_push_enabled
             from notifications.tenant_runtime_settings
            where tenant_id = $1`,
          [tenantId],
        );
        return {
          inAppEnabled: row?.in_app_enabled ?? false,
          webPushEnabled: row?.web_push_enabled ?? false,
          iosPushEnabled: row?.ios_push_enabled ?? false,
          androidPushEnabled: row?.android_push_enabled ?? false,
        };
      });
    },

    listInbox(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const values: unknown[] = [input.tenantId, input.userId, input.unreadOnly];
        let cursorPredicate = '';
        if (input.before) {
          values.push(input.before.createdAt, input.before.id);
          cursorPredicate = 'and (created_at, id) < ($4::timestamptz, $5::uuid)';
        }
        values.push(input.limit + 1);
        const limitParameter = `$${values.length}`;
        const result = await client.query<InboxRow>(
          `select id, category, title, body, deep_link,
                  created_at::text as created_at, read_at::text as read_at
             from notifications.inbox_items
            where tenant_id = $1
              and user_id = $2
              and ($3::boolean = false or read_at is null)
              ${cursorPredicate}
            order by created_at desc, id desc
            limit ${limitParameter}`,
          values,
        );
        const unread = await queryOne<CountRow>(
          client,
          `select count(*)::integer as unread_count
             from notifications.inbox_items
            where tenant_id = $1 and user_id = $2 and read_at is null`,
          [input.tenantId, input.userId],
        );
        const hasMore = result.rows.length > input.limit;
        const visibleRows = hasMore ? result.rows.slice(0, input.limit) : result.rows;
        const last = visibleRows.at(-1);
        return {
          items: visibleRows.map(mapInboxItem),
          unreadCount: unread?.unread_count ?? 0,
          ...(hasMore && last ? { next: mapPosition(last) } : {}),
        };
      });
    },

    markReadThrough(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const targetRow = await queryOne<PositionRow>(
          client,
          `select id, created_at::text as created_at
             from notifications.inbox_items
            where tenant_id = $1 and user_id = $2 and id = $3`,
          [input.tenantId, input.userId, input.throughItemId],
        );
        if (!targetRow) return { outcome: 'not_found' };
        const target = mapPosition(targetRow);

        const claim = await client.query(
          `insert into notifications.read_cursor_commands (
             tenant_id, user_id, idempotency_key, through_item_id,
             result_cursor_created_at, result_cursor_item_id
           ) values ($1, $2, $3, $4, $5, $4)
           on conflict (tenant_id, user_id, idempotency_key) do nothing
           returning idempotency_key`,
          [
            input.tenantId,
            input.userId,
            input.idempotencyKey,
            input.throughItemId,
            target.createdAt,
          ],
        );
        if (claim.rowCount === 0) {
          const previous = await queryOne<CommandRow>(
            client,
            `select through_item_id, result_cursor_item_id,
                    result_cursor_created_at::text as result_cursor_created_at, changed_count
               from notifications.read_cursor_commands
              where tenant_id = $1 and user_id = $2 and idempotency_key = $3`,
            [input.tenantId, input.userId, input.idempotencyKey],
          );
          if (!previous || previous.through_item_id !== input.throughItemId) {
            return { outcome: 'idempotency_conflict' };
          }
          return {
            outcome: 'updated',
            readThrough: {
              id: previous.result_cursor_item_id,
              createdAt: timestamp(previous.result_cursor_created_at),
            },
            changedCount: previous.changed_count,
            replayed: true,
          };
        }

        const currentRow = await queryOne<PositionRow>(
          client,
          `select read_through_item_id as id, read_through_created_at::text as created_at
             from notifications.user_read_state
            where tenant_id = $1 and user_id = $2
            for update`,
          [input.tenantId, input.userId],
        );
        const current = currentRow ? mapPosition(currentRow) : undefined;
        const shouldAdvance = !current || isAfter(target, current);
        let changedCount = 0;
        const resultCursor = shouldAdvance ? target : current;

        if (shouldAdvance) {
          const updated = await client.query(
            `update notifications.inbox_items
                set read_at = coalesce(read_at, now())
              where tenant_id = $1 and user_id = $2 and read_at is null
                and (created_at, id) <= ($3::timestamptz, $4::uuid)`,
            [input.tenantId, input.userId, target.createdAt, target.id],
          );
          changedCount = updated.rowCount ?? 0;
          await client.query(
            `insert into notifications.user_read_state (
               tenant_id, user_id, read_through_created_at, read_through_item_id
             ) values ($1, $2, $3, $4)
             on conflict (tenant_id, user_id) do update set
               read_through_created_at = excluded.read_through_created_at,
               read_through_item_id = excluded.read_through_item_id,
               updated_at = now()`,
            [input.tenantId, input.userId, target.createdAt, target.id],
          );
          await client.query(
            `insert into audit.outbox_events (
               tenant_id, event_type, aggregate_id, correlation_id, payload
             ) values ($1, 'notifications.read-cursor.updated.v1', $2, $3, $4::jsonb)`,
            [
              input.tenantId,
              input.userId,
              input.correlationId,
              JSON.stringify({ recipientUserId: input.userId, readThroughItemId: target.id }),
            ],
          );
        }

        await client.query(
          `update notifications.read_cursor_commands
              set result_cursor_created_at = $4,
                  result_cursor_item_id = $5,
                  changed_count = $6
            where tenant_id = $1 and user_id = $2 and idempotency_key = $3`,
          [
            input.tenantId,
            input.userId,
            input.idempotencyKey,
            resultCursor.createdAt,
            resultCursor.id,
            changedCount,
          ],
        );
        await client.query(
          `insert into audit.audit_log (
             tenant_id, actor_id, action, resource_type, resource_id,
             result, correlation_id, new_value
           ) values ($1, $2, 'NOTIFICATION_READ_CURSOR_SET', 'NOTIFICATION_INBOX_ITEM', $3,
                     'SUCCESS', $4, $5::jsonb)`,
          [
            input.tenantId,
            input.userId,
            input.throughItemId,
            input.correlationId,
            JSON.stringify({
              readThroughItemId: resultCursor.id,
              changedCount,
              advanced: shouldAdvance,
            }),
          ],
        );
        return {
          outcome: 'updated',
          readThrough: resultCursor,
          changedCount,
          replayed: false,
        };
      });
    },
  };
}
