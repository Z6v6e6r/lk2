import type { Pool, QueryResultRow } from 'pg';

import { withTenantTransaction } from './connection.js';
import type { Contact, ContactSourceKind, ContactType } from './contact-repository.js';

export interface ContactReader {
  /** The caller must bind both identifiers to its verified server-side principal. */
  listForUser(tenantId: string, userId: string): Promise<readonly Contact[]>;
}

interface ContactRow extends QueryResultRow {
  readonly id: string;
  readonly user_id: string;
  readonly type: ContactType;
  readonly normalized_value: string;
  readonly source_kind: ContactSourceKind;
  readonly source_updated_at: Date | null;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** Runtime read capability: no contact commands, receipts, audit or outbox writes. */
export function createContactReader(pool: Pool): ContactReader {
  return {
    listForUser(tenantId, userId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<ContactRow>(
          `select id, user_id, type, normalized_value, source_kind, source_updated_at,
                  version, created_at, updated_at
             from profile.contacts
            where tenant_id = $1 and user_id = $2 order by created_at, id`,
          [tenantId, userId],
        );
        return result.rows.map((row) => ({
          id: row.id,
          userId: row.user_id,
          type: row.type,
          normalizedValue: row.normalized_value,
          sourceKind: row.source_kind,
          sourceUpdatedAt: row.source_updated_at,
          version: row.version,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }));
      });
    },
  };
}
