import {
  GIFT_CERTIFICATE_CATALOG_DRAFT_SAVED_EVENT,
  GIFT_CERTIFICATE_CATALOG_PUBLISHED_EVENT,
  buildPublicGiftCertificateCatalog,
  giftCertificateAdminCatalogStateSchema,
  giftCertificateCatalogInputSchema,
  giftCertificateCatalogViewSchema,
  giftCertificatePublicationIssues,
  type GiftCertificateAdminCatalogState,
  type GiftCertificateCatalogInput,
  type GiftCertificateCatalogView,
  type PublicGiftCertificateCatalog,
} from '@phub/gift-certificates';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export type GiftCertificateCatalogCommandResult =
  | {
      readonly outcome: 'applied';
      readonly catalog: GiftCertificateCatalogView;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'draft_missing' }
  | { readonly outcome: 'version_conflict'; readonly current: GiftCertificateCatalogView }
  | { readonly outcome: 'publication_incomplete'; readonly missing: readonly string[] };

export interface GiftCertificateCatalogRepository {
  getAdminState(tenantId: string): Promise<GiftCertificateAdminCatalogState>;
  getPublic(tenantId: string, now?: string): Promise<PublicGiftCertificateCatalog | undefined>;
  saveDraft(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly expectedRevision: number | null;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly correlationId: string;
    readonly catalog: GiftCertificateCatalogInput;
  }): Promise<GiftCertificateCatalogCommandResult>;
  publishDraft(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly catalogId: string;
    readonly expectedRevision: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly correlationId: string;
  }): Promise<GiftCertificateCatalogCommandResult>;
}

interface CatalogRow extends QueryResultRow {
  readonly id: string;
  readonly catalog_number: number;
  readonly status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  readonly title: string;
  readonly public_enabled: boolean;
  readonly available_from: Date | string | null;
  readonly available_to: Date | string | null;
  readonly flow_steps: unknown;
  readonly validity_start: 'ISSUE' | 'ACTIVATION';
  readonly validity_days: number;
  readonly activation_deadline_days: number | null;
  readonly scheduled_delivery_enabled: boolean;
  readonly email_attachment_enabled: boolean;
  readonly revision: number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly published_at: Date | string | null;
  readonly archived_at: Date | string | null;
}

interface DesignRow extends QueryResultRow {
  readonly id: string;
  readonly design_key: string;
  readonly audience: 'FOR_HER' | 'FOR_HIM' | 'UNIVERSAL';
  readonly title: string;
  readonly description: string | null;
  readonly image_url: string;
  readonly alt_text: string;
  readonly code_x_percent: string | number;
  readonly code_y_percent: string | number;
  readonly amount_x_percent: string | number;
  readonly amount_y_percent: string | number;
  readonly active: boolean;
  readonly sort_order: number;
}

interface DenominationRow extends QueryResultRow {
  readonly id: string;
  readonly amount_minor: string | number;
  readonly currency: 'RUB';
  readonly active: boolean;
  readonly sort_order: number;
}

interface CommandRow extends QueryResultRow {
  readonly command_type: 'SAVE_DRAFT' | 'PUBLISH_DRAFT';
  readonly request_hash: string;
  readonly result_payload: unknown;
}

interface CatalogNumberRow extends QueryResultRow {
  readonly catalog_number: number;
}

const CATALOG_COLUMNS = `
  id, catalog_number, status, title, public_enabled,
  available_from, available_to, flow_steps,
  validity_start, validity_days, activation_deadline_days,
  scheduled_delivery_enabled, email_attachment_enabled,
  revision, created_at, updated_at, published_at, archived_at
`;

function timestamp(value: Date | string): string {
  return new Date(value).toISOString();
}

function nullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : timestamp(value);
}

async function loadCatalog(
  client: PoolClient,
  tenantId: string,
  row: CatalogRow,
): Promise<GiftCertificateCatalogView> {
  const designResult = await client.query<DesignRow>(
    `select id, design_key, audience, title, description, image_url, alt_text,
            code_x_percent, code_y_percent, amount_x_percent, amount_y_percent,
            active, sort_order
       from gift_certificates.designs
      where tenant_id = $1 and catalog_id = $2
      order by sort_order, design_key, id`,
    [tenantId, row.id],
  );
  const denominationResult = await client.query<DenominationRow>(
    `select id, amount_minor, currency, active, sort_order
       from gift_certificates.denominations
      where tenant_id = $1 and catalog_id = $2
      order by sort_order, amount_minor, id`,
    [tenantId, row.id],
  );
  return giftCertificateCatalogViewSchema.parse({
    id: row.id,
    catalogNumber: row.catalog_number,
    status: row.status,
    revision: row.revision,
    title: row.title,
    publicEnabled: row.public_enabled,
    availableFrom: nullableTimestamp(row.available_from),
    availableTo: nullableTimestamp(row.available_to),
    flowSteps: row.flow_steps,
    policy: {
      validityStart: row.validity_start,
      validityDays: row.validity_days,
      activationDeadlineDays: row.activation_deadline_days,
      scheduledDeliveryEnabled: row.scheduled_delivery_enabled,
      emailAttachmentEnabled: row.email_attachment_enabled,
    },
    designs: designResult.rows.map((design) => ({
      id: design.id,
      key: design.design_key,
      audience: design.audience,
      title: design.title,
      description: design.description,
      imageUrl: design.image_url,
      alt: design.alt_text,
      codeXPercent: Number(design.code_x_percent),
      codeYPercent: Number(design.code_y_percent),
      amountXPercent: Number(design.amount_x_percent),
      amountYPercent: Number(design.amount_y_percent),
      active: design.active,
      sortOrder: design.sort_order,
    })),
    denominations: denominationResult.rows.map((denomination) => ({
      id: denomination.id,
      amountMinor: Number(denomination.amount_minor),
      currency: denomination.currency,
      active: denomination.active,
      sortOrder: denomination.sort_order,
    })),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    publishedAt: nullableTimestamp(row.published_at),
    archivedAt: nullableTimestamp(row.archived_at),
  });
}

async function currentCommand(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string;
  },
): Promise<CommandRow | undefined> {
  return queryOne<CommandRow>(
    client,
    `select command_type, request_hash, result_payload
       from gift_certificates.admin_commands
      where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3
      for update`,
    [input.tenantId, input.actorUserId, input.idempotencyKey],
  );
}

function replayCommand(
  command: CommandRow | undefined,
  commandType: CommandRow['command_type'],
  requestHash: string,
): GiftCertificateCatalogCommandResult | undefined {
  if (!command) return undefined;
  if (command.command_type !== commandType || command.request_hash !== requestHash) {
    return { outcome: 'idempotency_conflict' };
  }
  return {
    outcome: 'applied',
    catalog: giftCertificateCatalogViewSchema.parse(command.result_payload),
    replayed: true,
  };
}

async function storeCommand(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string;
    readonly commandType: CommandRow['command_type'];
    readonly requestHash: string;
    readonly catalog: GiftCertificateCatalogView;
  },
): Promise<void> {
  await client.query(
    `insert into gift_certificates.admin_commands (
       tenant_id, actor_user_id, idempotency_key, command_type,
       request_hash, catalog_id, result_revision, result_payload
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      input.idempotencyKey,
      input.commandType,
      input.requestHash,
      input.catalog.id,
      input.catalog.revision,
      JSON.stringify(input.catalog),
    ],
  );
}

function safeAuditValue(catalog: GiftCertificateCatalogView): Record<string, unknown> {
  return {
    catalogNumber: catalog.catalogNumber,
    status: catalog.status,
    revision: catalog.revision,
    publicEnabled: catalog.publicEnabled,
    designCount: catalog.designs.length,
    denominationCount: catalog.denominations.length,
    validityStart: catalog.policy.validityStart,
    validityDays: catalog.policy.validityDays,
  };
}

async function recordChange(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly action: 'GIFT_CERTIFICATE_CATALOG_DRAFT_SAVED' | 'GIFT_CERTIFICATE_CATALOG_PUBLISHED';
    readonly eventType:
      | typeof GIFT_CERTIFICATE_CATALOG_DRAFT_SAVED_EVENT
      | typeof GIFT_CERTIFICATE_CATALOG_PUBLISHED_EVENT;
    readonly catalog: GiftCertificateCatalogView;
    readonly previous?: GiftCertificateCatalogView;
  },
): Promise<void> {
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id,
       result, correlation_id, old_value, new_value
     ) values ($1, $2, $3, 'GIFT_CERTIFICATE_CATALOG', $4,
               'SUCCESS', $5, $6::jsonb, $7::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      input.action,
      input.catalog.id,
      input.correlationId,
      input.previous ? JSON.stringify(safeAuditValue(input.previous)) : null,
      JSON.stringify(safeAuditValue(input.catalog)),
    ],
  );
  await client.query(
    `insert into audit.outbox_events (
       tenant_id, event_type, aggregate_id, correlation_id, payload
     ) values ($1, $2, $3, $4, $5::jsonb)`,
    [
      input.tenantId,
      input.eventType,
      input.catalog.id,
      input.correlationId,
      JSON.stringify({
        catalogId: input.catalog.id,
        catalogNumber: input.catalog.catalogNumber,
        revision: input.catalog.revision,
      }),
    ],
  );
}

async function replaceDraftChildren(
  client: PoolClient,
  tenantId: string,
  catalogId: string,
  input: GiftCertificateCatalogInput,
): Promise<void> {
  await client.query(
    'delete from gift_certificates.designs where tenant_id = $1 and catalog_id = $2',
    [tenantId, catalogId],
  );
  await client.query(
    'delete from gift_certificates.denominations where tenant_id = $1 and catalog_id = $2',
    [tenantId, catalogId],
  );
  for (const design of input.designs) {
    await client.query(
      `insert into gift_certificates.designs (
         tenant_id, catalog_id, design_key, audience, title, description,
         image_url, alt_text, code_x_percent, code_y_percent,
         amount_x_percent, amount_y_percent, active, sort_order
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        tenantId,
        catalogId,
        design.key,
        design.audience,
        design.title,
        design.description,
        design.imageUrl,
        design.alt,
        design.codeXPercent,
        design.codeYPercent,
        design.amountXPercent,
        design.amountYPercent,
        design.active,
        design.sortOrder,
      ],
    );
  }
  for (const denomination of input.denominations) {
    await client.query(
      `insert into gift_certificates.denominations (
         tenant_id, catalog_id, amount_minor, currency, active, sort_order
       ) values ($1, $2, $3, $4, $5, $6)`,
      [
        tenantId,
        catalogId,
        denomination.amountMinor,
        denomination.currency,
        denomination.active,
        denomination.sortOrder,
      ],
    );
  }
}

function catalogParameters(input: GiftCertificateCatalogInput): readonly unknown[] {
  return [
    input.title,
    input.publicEnabled,
    input.availableFrom,
    input.availableTo,
    JSON.stringify(input.flowSteps),
    input.policy.validityStart,
    input.policy.validityDays,
    input.policy.activationDeadlineDays,
    input.policy.scheduledDeliveryEnabled,
    input.policy.emailAttachmentEnabled,
  ];
}

export function createGiftCertificateCatalogRepository(
  pool: Pool,
): GiftCertificateCatalogRepository {
  return {
    getAdminState(tenantId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<CatalogRow>(
          `select ${CATALOG_COLUMNS}
             from gift_certificates.catalog_versions
            where tenant_id = $1 and status in ('DRAFT', 'PUBLISHED')
            order by case status when 'DRAFT' then 0 else 1 end, catalog_number desc`,
          [tenantId],
        );
        let draft: GiftCertificateCatalogView | null = null;
        let published: GiftCertificateCatalogView | null = null;
        for (const row of result.rows) {
          const catalog = await loadCatalog(client, tenantId, row);
          if (catalog.status === 'DRAFT') draft = catalog;
          if (catalog.status === 'PUBLISHED') published = catalog;
        }
        return giftCertificateAdminCatalogStateSchema.parse({ draft, published });
      });
    },

    getPublic(tenantId, now = new Date().toISOString()) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<CatalogRow>(
          client,
          `select ${CATALOG_COLUMNS}
             from gift_certificates.catalog_versions
            where tenant_id = $1
              and status = 'PUBLISHED'
              and public_enabled = true
              and (available_from is null or available_from <= $2::timestamptz)
              and (available_to is null or available_to > $2::timestamptz)`,
          [tenantId, now],
        );
        if (!row) return undefined;
        const catalog = await loadCatalog(client, tenantId, row);
        if (giftCertificatePublicationIssues(catalog).length > 0) return undefined;
        return buildPublicGiftCertificateCatalog(catalog);
      });
    },

    saveDraft(input) {
      const catalogInput = giftCertificateCatalogInputSchema.parse(input.catalog);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `gift-catalog:${input.tenantId}`,
        ]);
        const replay = replayCommand(
          await currentCommand(client, input),
          'SAVE_DRAFT',
          input.requestHash,
        );
        if (replay) return replay;

        const existingRow = await queryOne<CatalogRow>(
          client,
          `select ${CATALOG_COLUMNS}
             from gift_certificates.catalog_versions
            where tenant_id = $1 and status = 'DRAFT'
            for update`,
          [input.tenantId],
        );
        const previous = existingRow
          ? await loadCatalog(client, input.tenantId, existingRow)
          : undefined;
        if (previous && input.expectedRevision !== previous.revision) {
          return { outcome: 'version_conflict', current: previous };
        }
        if (!previous && input.expectedRevision !== null) return { outcome: 'draft_missing' };

        const parameters = catalogParameters(catalogInput);
        let storedRow: CatalogRow | undefined;
        if (existingRow) {
          storedRow = await queryOne<CatalogRow>(
            client,
            `update gift_certificates.catalog_versions set
               title = $3,
               public_enabled = $4,
               available_from = $5,
               available_to = $6,
               flow_steps = $7::jsonb,
               validity_start = $8,
               validity_days = $9,
               activation_deadline_days = $10,
               scheduled_delivery_enabled = $11,
               email_attachment_enabled = $12,
               revision = revision + 1,
               updated_by = $13,
               updated_at = now()
             where tenant_id = $1 and id = $2 and status = 'DRAFT'
             returning ${CATALOG_COLUMNS}`,
            [input.tenantId, existingRow.id, ...parameters, input.actorUserId],
          );
        } else {
          const numberRow = await queryOne<CatalogNumberRow>(
            client,
            `select coalesce(max(catalog_number), 0)::integer + 1 as catalog_number
               from gift_certificates.catalog_versions
              where tenant_id = $1`,
            [input.tenantId],
          );
          storedRow = await queryOne<CatalogRow>(
            client,
            `insert into gift_certificates.catalog_versions (
               tenant_id, catalog_number, status, title, public_enabled,
               available_from, available_to, flow_steps,
               validity_start, validity_days, activation_deadline_days,
               scheduled_delivery_enabled, email_attachment_enabled,
               created_by, updated_by
             ) values (
               $1, $2, 'DRAFT', $3, $4, $5, $6, $7::jsonb,
               $8, $9, $10, $11, $12, $13, $13
             ) returning ${CATALOG_COLUMNS}`,
            [input.tenantId, numberRow?.catalog_number ?? 1, ...parameters, input.actorUserId],
          );
        }
        if (!storedRow) throw new Error('GIFT_CERTIFICATE_CATALOG_WRITE_LOST');
        await replaceDraftChildren(client, input.tenantId, storedRow.id, catalogInput);
        const catalog = await loadCatalog(client, input.tenantId, storedRow);
        await storeCommand(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          idempotencyKey: input.idempotencyKey,
          commandType: 'SAVE_DRAFT',
          requestHash: input.requestHash,
          catalog,
        });
        await recordChange(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          correlationId: input.correlationId,
          action: 'GIFT_CERTIFICATE_CATALOG_DRAFT_SAVED',
          eventType: GIFT_CERTIFICATE_CATALOG_DRAFT_SAVED_EVENT,
          catalog,
          ...(previous ? { previous } : {}),
        });
        return { outcome: 'applied', catalog, replayed: false };
      });
    },

    publishDraft(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `gift-catalog:${input.tenantId}`,
        ]);
        const replay = replayCommand(
          await currentCommand(client, input),
          'PUBLISH_DRAFT',
          input.requestHash,
        );
        if (replay) return replay;

        const draftRow = await queryOne<CatalogRow>(
          client,
          `select ${CATALOG_COLUMNS}
             from gift_certificates.catalog_versions
            where tenant_id = $1 and id = $2 and status = 'DRAFT'
            for update`,
          [input.tenantId, input.catalogId],
        );
        if (!draftRow) return { outcome: 'draft_missing' };
        const draft = await loadCatalog(client, input.tenantId, draftRow);
        if (draft.revision !== input.expectedRevision) {
          return { outcome: 'version_conflict', current: draft };
        }
        const missing = giftCertificatePublicationIssues(draft);
        if (missing.length > 0) return { outcome: 'publication_incomplete', missing };

        await client.query(
          `update gift_certificates.catalog_versions set
             status = 'ARCHIVED',
             published_at = null,
             archived_at = now(),
             updated_by = $2,
             updated_at = now()
           where tenant_id = $1 and status = 'PUBLISHED'`,
          [input.tenantId, input.actorUserId],
        );
        const publishedRow = await queryOne<CatalogRow>(
          client,
          `update gift_certificates.catalog_versions set
             status = 'PUBLISHED',
             revision = revision + 1,
             published_at = now(),
             archived_at = null,
             updated_by = $3,
             updated_at = now()
           where tenant_id = $1 and id = $2 and status = 'DRAFT'
           returning ${CATALOG_COLUMNS}`,
          [input.tenantId, input.catalogId, input.actorUserId],
        );
        if (!publishedRow) throw new Error('GIFT_CERTIFICATE_CATALOG_PUBLISH_LOST');
        const catalog = await loadCatalog(client, input.tenantId, publishedRow);
        await storeCommand(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          idempotencyKey: input.idempotencyKey,
          commandType: 'PUBLISH_DRAFT',
          requestHash: input.requestHash,
          catalog,
        });
        await recordChange(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          correlationId: input.correlationId,
          action: 'GIFT_CERTIFICATE_CATALOG_PUBLISHED',
          eventType: GIFT_CERTIFICATE_CATALOG_PUBLISHED_EVENT,
          catalog,
          previous: draft,
        });
        return { outcome: 'applied', catalog, replayed: false };
      });
    },
  };
}
