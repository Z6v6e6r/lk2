import { randomUUID } from 'node:crypto';
import type {
  SupportTicketCategory,
  SupportTicketPriority,
  SupportTicketStatus,
} from '@phub/domain';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { queryOne, withTenantTransaction } from './connection.js';

export interface SupportTicketMessage {
  readonly id: string;
  readonly body: string;
  readonly authorRole: 'USER' | 'AGENT' | 'SYSTEM';
  readonly internal: boolean;
  readonly createdAt: string;
}
export interface SupportTicketEvent {
  readonly id: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly description?: string;
}
export interface SupportTicketView {
  readonly id: string;
  readonly subject: string;
  readonly category: SupportTicketCategory;
  readonly status: SupportTicketStatus;
  readonly priority: SupportTicketPriority;
  readonly assignedTo: string | null;
  readonly tags: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt: string | null;
  readonly autoCloseAt: string | null;
  readonly version: number;
  readonly messages: readonly SupportTicketMessage[];
  readonly history: readonly SupportTicketEvent[];
  readonly nextMessageCursor?: string;
  readonly closedAt?: string | null;
  readonly conversationPurgedAt?: string | null;
}
export interface SupportTicketPage {
  readonly items: readonly SupportTicketView[];
  readonly nextCursor?: string;
}
export type SupportMutationResult =
  | { readonly outcome: 'applied'; readonly ticket: SupportTicketView; readonly replayed: boolean }
  | {
      readonly outcome:
        | 'not_found'
        | 'forbidden'
        | 'version_conflict'
        | 'idempotency_conflict'
        | 'rate_limited'
        | 'ticket_limit'
        | 'content_limit'
        | 'receipt_expired'
        | 'conversation_archived';
    };
interface TenantInput {
  readonly tenantId: string;
}
interface CommandInput extends TenantInput {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly correlationId: string;
}
interface TicketCommandInput extends CommandInput {
  readonly ticketId: string;
  readonly actorId: string;
  readonly expectedVersion: number;
}
export interface SupportTicketRepository {
  list(
    input: TenantInput & {
      readonly ownerUserId?: string;
      readonly adminActorId?: string;
      readonly limit: number;
      readonly cursor?: string;
      readonly status?: SupportTicketStatus;
      readonly category?: SupportTicketCategory;
      readonly priority?: SupportTicketPriority;
      readonly query?: string;
    },
  ): Promise<SupportTicketPage>;
  get(
    input: TenantInput & {
      readonly ticketId: string;
      readonly ownerUserId?: string;
      readonly adminActorId?: string;
      readonly admin: boolean;
      readonly before?: string;
    },
  ): Promise<SupportTicketView | undefined>;
  create(
    input: CommandInput & {
      readonly ownerUserId: string;
      readonly subject: string;
      readonly category: SupportTicketCategory;
      readonly body: string;
    },
  ): Promise<SupportMutationResult>;
  message(
    input: TicketCommandInput & {
      readonly body: string;
      readonly admin: boolean;
      readonly internal?: boolean;
    },
  ): Promise<SupportMutationResult>;
  update(
    input: TicketCommandInput & {
      readonly status?: SupportTicketStatus;
      readonly priority?: SupportTicketPriority;
      readonly category?: SupportTicketCategory;
      readonly assignedTo?: string | null;
      readonly tags?: readonly string[];
    },
  ): Promise<SupportMutationResult>;
  purgeClosedBatch(
    input: TenantInput & { readonly limit: number; readonly correlationId: string },
  ): Promise<number>;
  closeResolvedBatch(
    input: TenantInput & {
      readonly limit: number;
      readonly correlationId: string;
    },
  ): Promise<number>;
}
export class SupportTicketPermissionError extends Error {
  constructor() {
    super('SUPPORT_PERMISSION_REQUIRED');
    this.name = 'SupportTicketPermissionError';
  }
}
interface TicketRow extends QueryResultRow {
  id: string;
  owner_user_id: string;
  subject: string;
  category: SupportTicketCategory;
  status: SupportTicketStatus;
  priority: SupportTicketPriority;
  assigned_to: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  auto_close_at: string | null;
  version: number;
  closed_at: string | null;
  conversation_purged_at: string | null;
}
interface MessageRow extends QueryResultRow {
  id: string;
  body: string;
  author_role: SupportTicketMessage['authorRole'];
  internal: boolean;
  created_at: string;
}
interface HistoryRow extends QueryResultRow {
  id: string;
  kind: string;
  description: string | null;
  created_at: string;
}
interface ReceiptRow extends QueryResultRow {
  ticket_id: string;
  retired_at: string | null;
  request_hash: string | null;
  result_json: SupportTicketView;
}
const columns =
  'id,owner_user_id,subject,category,status,priority,assigned_to,tags,created_at::text,updated_at::text,resolved_at::text,auto_close_at::text,closed_at::text,conversation_purged_at::text,version';
const timestamp = (value: string): string => new Date(value).toISOString();
const nullableTimestamp = (value: string | null): string | null =>
  value === null ? null : timestamp(value);
function mapTicket(row: TicketRow, includeInternal = true): SupportTicketView {
  return {
    id: row.id,
    subject: row.subject,
    category: row.category,
    status: row.status,
    priority: row.priority,
    assignedTo: includeInternal ? row.assigned_to : null,
    tags: includeInternal ? row.tags : [],
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    resolvedAt: nullableTimestamp(row.resolved_at),
    autoCloseAt: nullableTimestamp(row.auto_close_at),
    closedAt: nullableTimestamp(row.closed_at ?? null),
    conversationPurgedAt: nullableTimestamp(row.conversation_purged_at ?? null),
    version: row.version,
    messages: [],
    history: [],
  };
}
interface Cursor {
  readonly at: string;
  readonly id: string;
}
// Preserve PostgreSQL's microseconds in cursors; public ISO strings have millisecond precision.
const encodeCursor = (at: string, id: string): string =>
  Buffer.from(JSON.stringify({ at, id })).toString('base64url');
export function decodeSupportTicketCursor(value: string): Cursor | undefined {
  if (!/^[A-Za-z0-9_-]{8,512}$/u.test(value)) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('at' in parsed) || !('id' in parsed))
      return undefined;
    if (
      typeof parsed.at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/u.test(
        parsed.at,
      ) ||
      !Number.isFinite(Date.parse(parsed.at)) ||
      typeof parsed.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(parsed.id)
    )
      return undefined;
    return { at: parsed.at, id: parsed.id };
  } catch {
    return undefined;
  }
}
async function hasSupportPermission(
  client: PoolClient,
  tenantId: string,
  userId: string,
  permission: 'support.read' | 'support.manage',
): Promise<boolean> {
  // SHARE holds the checked grant through this transaction and serializes concurrent revocation.
  const row = await queryOne<{ user_id: string }>(
    client,
    `select p.user_id from identity.user_access_profiles p join identity.users u on u.tenant_id=p.tenant_id and u.id=p.user_id
     where p.tenant_id=$1 and p.user_id=$2 and u.status='ACTIVE' and 'admin'=any(p.roles)
     and ($3=any(p.permissions) or ($3='support.read' and 'support.manage'=any(p.permissions))) for share of p,u`,
    [tenantId, userId, permission],
  );
  return row !== undefined;
}
async function requireAdminRead(
  client: PoolClient,
  tenantId: string,
  actorId: string | undefined,
): Promise<void> {
  if (!actorId || !(await hasSupportPermission(client, tenantId, actorId, 'support.read')))
    throw new SupportTicketPermissionError();
}
async function findTicket(
  client: PoolClient,
  tenantId: string,
  id: string,
  lock: boolean | 'share' = false,
  ownerUserId?: string,
): Promise<TicketRow | undefined> {
  return queryOne<TicketRow>(
    client,
    `select ${columns} from support.tickets where tenant_id=$1 and id=$2${ownerUserId ? ' and owner_user_id=$3' : ''}${lock === 'share' ? ' for share' : lock ? ' for update' : ''}`,
    ownerUserId ? [tenantId, id, ownerUserId] : [tenantId, id],
  );
}
async function hydrate(
  client: PoolClient,
  tenantId: string,
  row: TicketRow,
  includeInternal: boolean,
  before?: string,
): Promise<SupportTicketView> {
  const values: unknown[] = [tenantId, row.id];
  let cursorClause = '';
  if (before) {
    const cursor = decodeSupportTicketCursor(before);
    if (!cursor) throw new Error('SUPPORT_CURSOR_INVALID');
    values.push(cursor.at, cursor.id);
    cursorClause = 'and (created_at,id)<($3::timestamptz,$4::uuid)';
  }
  const messages = (
    await client.query<MessageRow>(
      `select id,body,author_role,internal,created_at::text from support.messages
     where tenant_id=$1 and ticket_id=$2 ${includeInternal ? '' : 'and internal=false'} ${cursorClause}
     order by created_at desc,id desc limit 51`,
      values,
    )
  ).rows;
  const page = messages.slice(0, 50);
  const last = page.at(-1);
  const history = (
    await client.query<HistoryRow>(
      `select id,kind,description,created_at::text from support.history where tenant_id=$1 and ticket_id=$2
     ${includeInternal ? '' : 'and internal=false'} order by created_at desc,id desc limit 100`,
      [tenantId, row.id],
    )
  ).rows;
  return {
    ...mapTicket(row, includeInternal),
    messages: page.reverse().map((message) => ({
      id: message.id,
      body: message.body,
      authorRole: message.author_role,
      internal: message.internal,
      createdAt: timestamp(message.created_at),
    })),
    history: history.map((event) => ({
      id: event.id,
      kind: event.kind,
      createdAt: timestamp(event.created_at),
      ...(event.description === null ? {} : { description: event.description }),
    })),
    ...(messages.length > 50 && last
      ? { nextMessageCursor: encodeCursor(last.created_at, last.id) }
      : {}),
  };
}
async function appendAudit(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorId: string | null;
    readonly ticketId: string;
    readonly action: string;
    readonly correlationId: string;
    readonly event: string;
    readonly internal?: boolean;
    readonly oldMetadata?: Record<string, unknown>;
    readonly newMetadata?: Record<string, unknown>;
  },
): Promise<string> {
  const eventId = randomUUID();
  await client.query(
    `insert into support.history(tenant_id,ticket_id,kind,actor_id,internal) values($1,$2,$3,$4,$5)`,
    [input.tenantId, input.ticketId, input.event, input.actorId, input.internal ?? false],
  );
  await client.query(
    `insert into audit.audit_log(tenant_id,actor_id,action,resource_type,resource_id,result,correlation_id,old_value,new_value) values($1,$2,$3,'SUPPORT_TICKET',$4,'SUCCESS',$5,$6::jsonb,$7::jsonb)`,
    [
      input.tenantId,
      input.actorId,
      input.action,
      input.ticketId,
      input.correlationId,
      JSON.stringify(input.oldMetadata ?? null),
      JSON.stringify({ ticketId: input.ticketId, ...input.newMetadata }),
    ],
  );
  await client.query(
    `insert into audit.outbox_events(tenant_id,id,event_type,aggregate_id,correlation_id,payload) values($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      input.tenantId,
      eventId,
      input.event,
      input.ticketId,
      input.correlationId,
      JSON.stringify({ ticketId: input.ticketId }),
    ],
  );
  return eventId;
}
async function notifyOwner(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly ticketId: string;
    readonly userId: string;
    readonly title: string;
    readonly body: string;
    readonly correlationId: string;
    readonly sourceEventId: string;
  },
): Promise<void> {
  // The fixed module-owned template is materialized safely even when two tickets notify concurrently.
  await client.query(
    `insert into notifications.templates(tenant_id,template_key,version,locale,category,channels,title_template,body_template,deep_link_template,active)
    values($1,'support.ticket.activity',1,'ru-RU','SUPPORT',array['IN_APP']::text[],'{{title}}','{{body}}','{{deepLink}}',false)
    on conflict (tenant_id,template_key,version,locale) do nothing`,
    [input.tenantId],
  );
  const template = await queryOne<{ id: string }>(
    client,
    `select id from notifications.templates where tenant_id=$1 and template_key='support.ticket.activity' and version=1 and locale='ru-RU'`,
    [input.tenantId],
  );
  if (!template) throw new Error('SUPPORT_NOTIFICATION_TEMPLATE_WRITE_LOST');
  const deepLink = `/support/${input.ticketId}`;
  const intent = await queryOne<{ id: string }>(
    client,
    `insert into notifications.intents(tenant_id,recipient_user_id,source_event_id,template_id,dedupe_key,render_data,rendered_title,rendered_body,rendered_deep_link,state,completed_at)
     values($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,'DELIVERED',now()) returning id`,
    [
      input.tenantId,
      input.userId,
      input.sourceEventId,
      template.id,
      `support:${input.sourceEventId}`,
      JSON.stringify({ ticketId: input.ticketId }),
      input.title,
      input.body,
      deepLink,
    ],
  );
  if (!intent) throw new Error('SUPPORT_NOTIFICATION_INTENT_WRITE_LOST');
  await client.query(
    `insert into notifications.deliveries(tenant_id,intent_id,channel,state,completed_at) values($1,$2,'IN_APP','DELIVERED',now())`,
    [input.tenantId, intent.id],
  );
  await client.query(
    `insert into notifications.inbox_items(tenant_id,intent_id,user_id,category,title,body,deep_link) values($1,$2,$3,'SUPPORT',$4,$5,$6)`,
    [input.tenantId, intent.id, input.userId, input.title, input.body, deepLink],
  );
  await client.query(
    `insert into audit.outbox_events(tenant_id,event_type,aggregate_id,correlation_id,payload) values($1,'notifications.inbox.created.v1',$2,$3,$4::jsonb)`,
    [
      input.tenantId,
      intent.id,
      input.correlationId,
      JSON.stringify({ intentId: intent.id, recipientUserId: input.userId }),
    ],
  );
}
async function commandReplay(
  client: PoolClient,
  input: CommandInput & { readonly actorId: string },
  admin = false,
): Promise<SupportMutationResult | undefined> {
  // Lock even an absent receipt. A UNIQUE constraint alone cannot prevent duplicate pre-receipt effects.
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
    JSON.stringify([input.tenantId, input.actorId, input.idempotencyKey]),
  ]);
  const observed = await queryOne<ReceiptRow>(
    client,
    `select request_hash,result_json,retired_at,ticket_id from support.commands where tenant_id=$1 and actor_id=$2 and idempotency_key=$3`,
    [input.tenantId, input.actorId, input.idempotencyKey],
  );
  if (!observed) return undefined;
  // Reject another target/body before locking any ticket; reused keys must not create cross-ticket lock ordering.
  if (!observed.retired_at && observed.request_hash !== input.requestHash)
    return { outcome: 'idempotency_conflict' };
  const currentTicket = await findTicket(
    client,
    input.tenantId,
    observed.ticket_id,
    true,
    admin ? undefined : input.actorId,
  );
  if (!currentTicket) return { outcome: 'not_found' };
  const row = await queryOne<ReceiptRow>(
    client,
    `select request_hash,result_json,retired_at,ticket_id from support.commands where tenant_id=$1 and actor_id=$2 and idempotency_key=$3`,
    [input.tenantId, input.actorId, input.idempotencyKey],
  );
  if (!row) throw new Error('SUPPORT_RECEIPT_READ_LOST');
  if (row.retired_at) return { outcome: 'receipt_expired' };
  return row.request_hash !== input.requestHash
    ? { outcome: 'idempotency_conflict' }
    : { outcome: 'applied', ticket: row.result_json, replayed: true };
}
type CommandKind = 'CREATE' | 'USER_MESSAGE' | 'ADMIN_MESSAGE' | 'UPDATE';
async function checkQuota(
  client: PoolClient,
  tenantId: string,
  actorId: string,
  kind: CommandKind,
): Promise<boolean> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
    JSON.stringify([tenantId, actorId, 'support-quota']),
  ]);
  const row = await queryOne<{ count: number }>(
    client,
    `select count(*)::integer as count from support.commands where tenant_id=$1 and actor_id=$2
     and completed_at>now()-interval '1 hour' and command_kind=any($3::text[])`,
    [
      tenantId,
      actorId,
      kind === 'CREATE'
        ? ['CREATE']
        : kind === 'USER_MESSAGE'
          ? ['USER_MESSAGE']
          : ['ADMIN_MESSAGE', 'UPDATE'],
    ],
  );
  return (row?.count ?? 0) < (kind === 'CREATE' ? 5 : kind === 'USER_MESSAGE' ? 30 : 120);
}
async function completeCommand(
  client: PoolClient,
  input: CommandInput & { readonly actorId: string },
  view: SupportTicketView,
  kind: CommandKind,
): Promise<SupportMutationResult> {
  // Commands return compact immutable receipts. The client refreshes canonical thread history by GET.
  const snapshot: SupportTicketView = { ...view, messages: [], history: [] };
  await client.query(
    `insert into support.commands(tenant_id,actor_id,idempotency_key,request_hash,ticket_id,result_version,result_json,command_kind) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [
      input.tenantId,
      input.actorId,
      input.idempotencyKey,
      input.requestHash,
      view.id,
      view.version,
      JSON.stringify(snapshot),
      kind,
    ],
  );
  return { outcome: 'applied', ticket: snapshot, replayed: false };
}
export function createSupportTicketRepository(pool: Pool): SupportTicketRepository {
  return {
    async list(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        if (!input.ownerUserId) await requireAdminRead(client, input.tenantId, input.adminActorId);
        const values: unknown[] = [input.tenantId];
        const clauses: string[] = [];
        if (input.ownerUserId) {
          values.push(input.ownerUserId);
          clauses.push(`owner_user_id=$${values.length}`);
        }
        for (const [column, value] of [
          ['status', input.status],
          ['category', input.category],
          ['priority', input.priority],
        ] as const) {
          if (value) {
            values.push(value);
            clauses.push(`${column}=$${values.length}`);
          }
        }
        if (input.query) {
          values.push(`%${input.query}%`);
          clauses.push(
            input.ownerUserId
              ? `subject ilike $${values.length}`
              : `(subject ilike $${values.length} or exists(select 1 from unnest(tags) as tag where tag ilike $${values.length}))`,
          );
        }
        if (input.cursor) {
          const cursor = decodeSupportTicketCursor(input.cursor);
          if (!cursor) throw new Error('SUPPORT_CURSOR_INVALID');
          values.push(cursor.at, cursor.id);
          clauses.push(
            `(updated_at,id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`,
          );
        }
        values.push(input.limit + 1);
        const rows = (
          await client.query<TicketRow>(
            `select ${columns} from support.tickets where tenant_id=$1 ${clauses.length ? `and ${clauses.join(' and ')}` : ''} order by updated_at desc,id desc limit $${values.length}`,
            values,
          )
        ).rows;
        const page = rows.slice(0, input.limit);
        const last = page.at(-1);
        return {
          items: page.map((item) => mapTicket(item, !input.ownerUserId)),
          ...(rows.length > input.limit && last
            ? { nextCursor: encodeCursor(last.updated_at, last.id) }
            : {}),
        };
      });
    },
    async get(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        if (input.admin) await requireAdminRead(client, input.tenantId, input.adminActorId);
        if (!input.admin && !input.ownerUserId) return undefined;
        const row = await findTicket(
          client,
          input.tenantId,
          input.ticketId,
          'share',
          input.admin ? undefined : input.ownerUserId,
        );
        if (!row) return undefined;
        return hydrate(client, input.tenantId, row, input.admin, input.before);
      });
    },
    async create(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const command = { ...input, actorId: input.ownerUserId };
        const replay = await commandReplay(client, command);
        if (replay) return replay;
        if (!(await checkQuota(client, input.tenantId, input.ownerUserId, 'CREATE')))
          return { outcome: 'rate_limited' };
        const active = await queryOne<{ count: number }>(
          client,
          `select count(*)::integer as count from support.tickets where tenant_id=$1 and owner_user_id=$2 and status<>'CLOSED'`,
          [input.tenantId, input.ownerUserId],
        );
        if ((active?.count ?? 0) >= 10) return { outcome: 'ticket_limit' };
        const id = randomUUID();
        const row = await queryOne<TicketRow>(
          client,
          `insert into support.tickets(tenant_id,id,owner_user_id,subject,category) values($1,$2,$3,$4,$5) returning ${columns}`,
          [input.tenantId, id, input.ownerUserId, input.subject, input.category],
        );
        if (!row) throw new Error('SUPPORT_TICKET_WRITE_LOST');
        await client.query(
          `insert into support.messages(tenant_id,ticket_id,body,author_id,author_role) values($1,$2,$3,$4,'USER')`,
          [input.tenantId, id, input.body, input.ownerUserId],
        );
        await appendAudit(client, {
          ...command,
          ticketId: id,
          action: 'SUPPORT_TICKET_CREATED',
          event: 'support.ticket.created.v1',
        });
        return completeCommand(client, command, mapTicket(row, false), 'CREATE');
      });
    },
    async message(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        if (
          input.admin &&
          !(await hasSupportPermission(client, input.tenantId, input.actorId, 'support.manage'))
        )
          return { outcome: 'forbidden' };
        if (!input.admin && input.internal) return { outcome: 'forbidden' };
        const replay = await commandReplay(client, input, input.admin);
        if (replay) return replay;
        const row = await findTicket(
          client,
          input.tenantId,
          input.ticketId,
          true,
          input.admin ? undefined : input.actorId,
        );
        if (!row) return { outcome: 'not_found' };
        if (row.version !== input.expectedVersion) return { outcome: 'version_conflict' };
        if (
          !(await checkQuota(
            client,
            input.tenantId,
            input.actorId,
            input.admin ? 'ADMIN_MESSAGE' : 'USER_MESSAGE',
          ))
        )
          return { outcome: 'rate_limited' };
        const size = await queryOne<{ count: number }>(
          client,
          `select count(*)::integer as count from support.messages where tenant_id=$1 and ticket_id=$2`,
          [input.tenantId, input.ticketId],
        );
        if ((size?.count ?? 0) >= 1000) return { outcome: 'content_limit' };
        const internal = input.admin && input.internal === true;
        if (
          internal &&
          row.status === 'CLOSED' &&
          row.conversation_purged_at &&
          row.closed_at &&
          Date.parse(row.conversation_purged_at) >= Date.parse(row.closed_at)
        )
          return { outcome: 'conversation_archived' };
        const status = internal ? row.status : input.admin ? 'WAITING_USER' : 'OPEN';
        const updated = await queryOne<TicketRow>(
          client,
          `update support.tickets set status=$4,resolved_at=case when $5 then resolved_at else null end,
           auto_close_at=case when $5 then auto_close_at else null end,version=version+1,updated_at=now()
           where tenant_id=$1 and id=$2 and version=$3 returning ${columns}`,
          [input.tenantId, input.ticketId, input.expectedVersion, status, internal],
        );
        if (!updated) return { outcome: 'version_conflict' };
        await client.query(
          `insert into support.messages(tenant_id,ticket_id,body,author_id,author_role,internal) values($1,$2,$3,$4,$5,$6)`,
          [
            input.tenantId,
            input.ticketId,
            input.body,
            input.actorId,
            input.admin ? 'AGENT' : 'USER',
            internal,
          ],
        );
        const eventId = await appendAudit(client, {
          ...input,
          internal,
          action: 'SUPPORT_TICKET_MESSAGE_SENT',
          event: internal ? 'support.ticket.internal_note.v1' : 'support.ticket.message.v1',
        });
        if (input.admin && !internal)
          await notifyOwner(client, {
            ...input,
            userId: row.owner_user_id,
            sourceEventId: eventId,
            title: 'Ответ поддержки',
            body: 'В вашем обращении появился ответ.',
          });
        return completeCommand(
          client,
          input,
          mapTicket(updated, input.admin),
          input.admin ? 'ADMIN_MESSAGE' : 'USER_MESSAGE',
        );
      });
    },
    async update(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        if (!(await hasSupportPermission(client, input.tenantId, input.actorId, 'support.manage')))
          return { outcome: 'forbidden' };
        const replay = await commandReplay(client, input, true);
        if (replay) return replay;
        const row = await findTicket(client, input.tenantId, input.ticketId, true);
        if (!row) return { outcome: 'not_found' };
        if (row.version !== input.expectedVersion) return { outcome: 'version_conflict' };
        if (!(await checkQuota(client, input.tenantId, input.actorId, 'UPDATE')))
          return { outcome: 'rate_limited' };
        if (
          row.status === 'CLOSED' &&
          row.conversation_purged_at &&
          row.closed_at &&
          Date.parse(row.conversation_purged_at) >= Date.parse(row.closed_at) &&
          (input.status ?? row.status) === 'CLOSED' &&
          ((input.tags !== undefined && JSON.stringify(input.tags) !== JSON.stringify(row.tags)) ||
            (input.assignedTo !== undefined && input.assignedTo !== row.assigned_to))
        )
          return { outcome: 'conversation_archived' };
        if (
          input.assignedTo !== undefined &&
          input.assignedTo !== null &&
          !(await hasSupportPermission(client, input.tenantId, input.assignedTo, 'support.manage'))
        )
          return { outcome: 'forbidden' };
        const updated = await queryOne<TicketRow>(
          client,
          `update support.tickets set status=coalesce($4,status),priority=coalesce($5,priority),category=coalesce($6,category),assigned_to=$7,tags=coalesce($8,tags),
           resolved_at=case when coalesce($4,status)='RESOLVED' then coalesce(resolved_at,now()) else null end,
           auto_close_at=case when coalesce($4,status)='RESOLVED' then coalesce(auto_close_at,now()+interval '72 hours') else null end,
           version=version+1,updated_at=now() where tenant_id=$1 and id=$2 and version=$3 returning ${columns}`,
          [
            input.tenantId,
            input.ticketId,
            input.expectedVersion,
            input.status ?? null,
            input.priority ?? null,
            input.category ?? null,
            input.assignedTo === undefined ? row.assigned_to : input.assignedTo,
            input.tags ?? null,
          ],
        );
        if (!updated) return { outcome: 'version_conflict' };
        const statusChanged = updated.status !== row.status;
        const eventId = await appendAudit(client, {
          ...input,
          action: 'SUPPORT_TICKET_UPDATED',
          oldMetadata: {
            status: row.status,
            priority: row.priority,
            category: row.category,
            assignedTo: row.assigned_to,
            tagsCount: row.tags.length,
            tagsChanged: JSON.stringify(row.tags) !== JSON.stringify(updated.tags),
          },
          newMetadata: {
            status: updated.status,
            priority: updated.priority,
            category: updated.category,
            assignedTo: updated.assigned_to,
            tagsCount: updated.tags.length,
            tagsChanged: JSON.stringify(row.tags) !== JSON.stringify(updated.tags),
          },
          event:
            statusChanged && updated.status === 'RESOLVED'
              ? 'support.ticket.resolved.v1'
              : 'support.ticket.updated.v1',
        });
        if (statusChanged)
          await notifyOwner(client, {
            ...input,
            userId: row.owner_user_id,
            sourceEventId: eventId,
            title: 'Статус обращения изменён',
            body:
              updated.status === 'RESOLVED'
                ? 'Поддержка решила обращение. Ответьте в течение 72 часов, если вопрос остался.'
                : 'Поддержка обновила статус вашего обращения.',
          });
        return completeCommand(client, input, mapTicket(updated, true), 'UPDATE');
      });
    },
    async purgeClosedBatch(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const rows = (
          await client.query<{ id: string }>(
            `select id from support.tickets where tenant_id=$1 and status='CLOSED' and closed_at<=now()-interval '24 months' and (conversation_purged_at is null or conversation_purged_at<closed_at) order by closed_at,id limit $2 for update skip locked`,
            [input.tenantId, input.limit],
          )
        ).rows;
        let purged = 0;
        for (const row of rows) {
          await client.query('delete from support.messages where tenant_id=$1 and ticket_id=$2', [
            input.tenantId,
            row.id,
          ]);
          await client.query(
            `update support.commands c set request_hash=null,retired_at=now(),result_json=jsonb_build_object('id',c.ticket_id,'category',t.category,'status',t.status,'messages','[]'::jsonb,'history','[]'::jsonb) from support.tickets t where c.tenant_id=$1 and c.ticket_id=$2 and t.tenant_id=c.tenant_id and t.id=c.ticket_id and c.retired_at is null`,
            [input.tenantId, row.id],
          );
          const updated = await client.query(
            `update support.tickets set subject='Обращение #'||id::text,tags='{}',assigned_to=null,conversation_purged_at=now(),version=version+1,updated_at=now() where tenant_id=$1 and id=$2 and status='CLOSED' and closed_at<=now()-interval '24 months' and (conversation_purged_at is null or conversation_purged_at<closed_at)`,
            [input.tenantId, row.id],
          );
          if (!updated.rowCount) throw new Error('SUPPORT_RETENTION_STATE_CHANGED');
          await appendAudit(client, {
            ...input,
            actorId: null,
            ticketId: row.id,
            action: 'SUPPORT_TICKET_CONVERSATION_PURGED',
            event: 'support.ticket.conversation_purged.v1',
          });
          purged += 1;
        }
        return purged;
      });
    },
    async closeResolvedBatch(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const rows = (
          await client.query<{ id: string; owner_user_id: string }>(
            `select id,owner_user_id from support.tickets where tenant_id=$1 and status='RESOLVED' and auto_close_at<=now() order by auto_close_at,id limit $2 for update skip locked`,
            [input.tenantId, input.limit],
          )
        ).rows;
        let closed = 0;
        for (const row of rows) {
          const result = await client.query(
            `update support.tickets set status='CLOSED',auto_close_at=null,version=version+1,updated_at=now() where tenant_id=$1 and id=$2 and status='RESOLVED' and auto_close_at<=now()`,
            [input.tenantId, row.id],
          );
          if (!result.rowCount) continue;
          closed += 1;
          const eventId = await appendAudit(client, {
            ...input,
            actorId: null,
            ticketId: row.id,
            action: 'SUPPORT_TICKET_AUTO_CLOSED',
            event: 'support.ticket.closed.v1',
          });
          await notifyOwner(client, {
            ...input,
            ticketId: row.id,
            userId: row.owner_user_id,
            sourceEventId: eventId,
            title: 'Обращение закрыто',
            body: 'Обращение закрыто после 72 часов без ответа. Новый ответ переоткроет его.',
          });
        }
        return closed;
      });
    },
  };
}
