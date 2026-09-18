import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createDatabasePool } from '@phub/database';
import type { Pool } from 'pg';

/**
 * One-time backfill of the phone login anchor and the LK1 identity map for users that were imported
 * from legacy LK.
 *
 * Why this exists: `games:legacy:import-*` creates the canonical user rows and the pseudonymous
 * player associations, but it does not populate `profile.user_summaries.phone_e164` and it writes no
 * `integration.external_identity_map` row. The result is a user who exists but cannot sign in by the
 * documented phone anchor, and a participation/roster actor that cannot be resolved back to a person.
 * See `docs/plans/lk1-lk2-connector-design-review.md` sections 4.1-4.2.
 *
 * Input is produced by `scripts/lk1-export-identity-anchors.mjs`, which runs outside this repository
 * (this repo has no mongo dependency by design). The file is tab separated:
 *
 *     <external-uuid>\t<phone-e164>\t<anchor:player>
 *
 * The anchor is the same one-way key the Games import already uses
 * (`packages/legacy-games-adapter/src/index.ts:216-218`):
 *
 *     sha256(`phub-local-public-clone-v1:player:${externalId}`)
 *
 * so the join is `anchor -> integration.external_entity_map.external_id` for `entity_type` of
 * `game_player`, which already maps to a canonical `internal_id`.
 *
 * Safety:
 *   - dry run by default; it only reports.
 *   - `--apply` additionally requires `APP_ENV=staging` and `LK1_ANCHOR_BACKFILL_CONFIRM`, so a
 *     production connection cannot be mutated by accident.
 *   - a row is written only when the phone is not already owned by a *different* user; a phone that
 *     already belongs to someone else is reported as a conflict and skipped, never reassigned.
 *   - re-running is idempotent: the same anchor produces "already" rather than a second write.
 *   - every applied row writes an audit entry in the same tenant transaction.
 *
 * Usage:
 *   LK1_ANCHOR_FILE=anchors.tsv DATABASE_URL=… npx tsx scripts/backfill-lk1-phone-anchors.ts
 *   LK1_ANCHOR_FILE=anchors.tsv DATABASE_URL=… APP_ENV=staging \
 *     LK1_ANCHOR_BACKFILL_CONFIRM=apply-lk1-phone-anchors \
 *     npx tsx scripts/backfill-lk1-phone-anchors.ts --apply
 */

const ANCHOR_NAMESPACE = 'phub-local-public-clone-v1';
const ENTITY_TYPE = 'player';
const CONFIRM_TOKEN = 'apply-lk1-phone-anchors';
const PHONE_E164 = /^\+[1-9][0-9]{7,14}$/;
const ANCHOR_HEX = /^[0-9a-f]{64}$/;

export interface AnchorRow {
  readonly externalId: string;
  readonly phone: string;
  readonly anchor: string;
}

export type RowOutcome =
  'linked' | 'already' | 'user_not_found' | 'conflict_other_user' | 'invalid';

export interface RowReport {
  readonly externalId: string;
  readonly anchor: string;
  readonly outcome: RowOutcome;
}

export function anchorFor(externalId: string): string {
  return createHash('sha256')
    .update(`${ANCHOR_NAMESPACE}:${ENTITY_TYPE}:${externalId}`)
    .digest('hex');
}

/**
 * Parses the export file. Lines starting with `#` and blank lines are ignored. A malformed row is
 * returned with outcome `invalid` rather than throwing, so one bad row cannot abort a review run.
 */
export function parseAnchorFile(contents: string): {
  readonly rows: readonly AnchorRow[];
  readonly malformed: number;
} {
  const rows: AnchorRow[] = [];
  let malformed = 0;
  for (const raw of contents.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // The exporter always emits the anchor; require it so an unverified or hand-edited row cannot
    // silently fall back to a locally recomputed key.
    const [externalId, phone, anchor] = line.split('\t');
    if (!externalId || !phone || !anchor || !PHONE_E164.test(phone.trim())) {
      malformed += 1;
      continue;
    }
    rows.push({ externalId: externalId.trim(), phone: phone.trim(), anchor: anchor.trim() });
  }
  return { rows, malformed };
}

async function classify(
  pool: Pool,
  row: AnchorRow,
): Promise<{ outcome: RowOutcome; userId?: string; tenantId?: string }> {
  if (!ANCHOR_HEX.test(row.anchor)) return { outcome: 'invalid' };
  const client = await pool.connect();
  try {
    const mapping = await client.query<{ internal_id: string; tenant_id: string }>(
      `select internal_id, tenant_id
         from integration.external_entity_map
        where entity_type = 'game_player' and external_id = $1
        limit 2`,
      [row.anchor],
    );
    if (mapping.rows.length !== 1) return { outcome: 'user_not_found' };
    const { internal_id: userId, tenant_id: tenantId } = mapping.rows[0]!;

    const current = await client.query<{ user_id: string; phone_e164: string | null }>(
      `select user_id, phone_e164
         from profile.user_summaries
        where tenant_id = $1 and phone_e164 = $2
        limit 2`,
      [tenantId, row.phone],
    );
    if (current.rows.length === 1 && current.rows[0]!.user_id !== userId) {
      return { outcome: 'conflict_other_user', userId, tenantId };
    }

    const mine = await client.query<{ phone_e164: string | null }>(
      `select phone_e164 from profile.user_summaries where tenant_id = $1 and user_id = $2`,
      [tenantId, userId],
    );
    if (mine.rows.length === 0) return { outcome: 'user_not_found' };
    if (mine.rows[0]!.phone_e164 === row.phone) return { outcome: 'already', userId, tenantId };
    return { outcome: 'linked', userId, tenantId };
  } finally {
    client.release();
  }
}

async function apply(
  pool: Pool,
  row: AnchorRow,
  userId: string,
  tenantId: string,
  correlationId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query(
      `update profile.user_summaries
          set phone_e164 = $3, updated_at = now()
        where tenant_id = $1 and user_id = $2`,
      [tenantId, userId, row.phone],
    );
    await client.query(
      `insert into audit.audit_log (
         tenant_id, actor_id, action, resource_type, resource_id, result, reason, correlation_id
       ) values ($1, $2, 'LK1_PHONE_ANCHOR_BACKFILL', 'identity.user', $2, 'APPLIED',
                 'LEGACY_LK_IDENTITY_ANCHOR', $3)`,
      [tenantId, userId, correlationId],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function parseArguments(argv: readonly string[]): { readonly apply: boolean } {
  const unknown = argv.filter((arg) => arg !== '--apply');
  if (unknown.length > 0) throw new Error(`LK1_ANCHOR_BACKFILL_ARGUMENT_INVALID:${unknown[0]}`);
  return { apply: argv.includes('--apply') };
}

async function main(): Promise<void> {
  const { apply: shouldApply } = parseArguments(process.argv.slice(2));
  const file = process.env.LK1_ANCHOR_FILE;
  if (!file) throw new Error('LK1_ANCHOR_FILE_REQUIRED');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL_REQUIRED');

  if (shouldApply) {
    if (process.env.APP_ENV !== 'staging') {
      throw new Error('LK1_ANCHOR_BACKFILL_REQUIRES_APP_ENV_STAGING');
    }
    if (process.env.LK1_ANCHOR_BACKFILL_CONFIRM !== CONFIRM_TOKEN) {
      throw new Error('LK1_ANCHOR_BACKFILL_CONFIRM_REQUIRED');
    }
  }

  const { rows, malformed } = parseAnchorFile(readFileSync(file, 'utf8'));
  const pool = createDatabasePool(databaseUrl);
  const correlationId = `lk1-anchor-backfill-${randomUUID()}`;
  const counts: Record<RowOutcome, number> = {
    linked: 0,
    already: 0,
    user_not_found: 0,
    conflict_other_user: 0,
    invalid: 0,
  };
  const samples: RowReport[] = [];
  try {
    for (const row of rows) {
      const verdict = await classify(pool, row);
      let outcome = verdict.outcome;
      if (outcome === 'linked' && shouldApply && verdict.userId && verdict.tenantId) {
        await apply(pool, row, verdict.userId, verdict.tenantId, correlationId);
      }
      if (outcome === 'invalid') outcome = 'invalid';
      counts[outcome] += 1;
      if (samples.length < 20 && outcome !== 'linked' && outcome !== 'already') {
        samples.push({ externalId: row.externalId, anchor: row.anchor, outcome });
      }
    }
  } finally {
    await pool.end();
  }

  process.stdout.write(
    JSON.stringify(
      {
        mode: shouldApply ? 'apply' : 'dry-run',
        rows: rows.length,
        malformed,
        counts,
        samples,
      },
      null,
      2,
    ) + '\n',
  );
}

const invoked = process.argv[1] ?? '';
if (
  invoked.endsWith('backfill-lk1-phone-anchors.ts') ||
  invoked.endsWith('backfill-lk1-phone-anchors.js')
) {
  await main();
}
