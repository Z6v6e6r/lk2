import type { Pool, QueryResultRow } from 'pg';

import { withTenantTransaction } from './connection.js';

/** Integration-only source system for games imported from LK1 (Viva/Mongo snapshots). */
const LK1_EXTERNAL_SYSTEM = 'LK_LEGACY_SNAPSHOT';

/**
 * LK2 stores two kinds of legacy game aliases under the same mapping key: the provider game id LK1
 * itself uses (`pay_…`, `slot_…`) and a pseudonymous 64-hex association hash derived inside the
 * legacy adapter. Only the former identifies a record in LK1's `lk_games`, so sending the hash makes
 * the import fail with `LK1_GAME_NOT_FOUND` and the score never arrives.
 */
const PSEUDONYMOUS_ALIAS = /^[0-9a-f]{64}$/u;

/**
 * Chooses the alias LK1 can actually resolve. Deterministic for stable behaviour across replays:
 * the pseudonymous hash is dropped and the remaining aliases are ordered.
 */
export function selectLk1GameId(aliases: readonly string[]): string | null {
  const usable = [...new Set(aliases.filter((alias) => alias.length > 0))]
    .filter((alias) => !PSEUDONYMOUS_ALIAS.test(alias))
    .sort();
  return usable[0] ?? null;
}

/**
 * The identity LK1 needs to accept a result for a game it owns. LK2 keeps per-set scores and its
 * own confirmation quorum; LK1 stores one score per game and identifies the submitter by phone, so
 * this read supplies the legacy game id and the phone of the participant who confirmed the result.
 */
export interface Lk1ResultHandoff {
  readonly tenantId: string;
  readonly gameId: string;
  readonly resultId: string;
  readonly resultRevision: number;
  /** LK1 game identifier; null when the game exists only in LK2, so LK1 has nothing to import. */
  readonly lk1GameId: string | null;
  /** Phone of the confirming participant; null when the profile carries no phone. Never logged. */
  readonly submitterPhoneE164: string | null;
  /** LK1 client id of the submitter, so LK1 can place them without a phone. Null when unknown. */
  readonly submitterClientId: string | null;
  /**
   * The two pairings from LK2's own result. LK1 games created from the split widget keep no phones
   * and no teams of their own, so the composition must travel with the result or LK1 cannot tell
   * which side a score belongs to. Each member carries the identifiers LK1 can match: its own client
   * id when the legacy mapping knows it, and the phone when the profile has one. Null when either
   * side cannot be identified at all.
   */
  readonly teams: {
    readonly teamA: readonly Lk1TeamMember[];
    readonly teamB: readonly Lk1TeamMember[];
  } | null;
  readonly confirmedAt: string;
}

/** One participant of a pairing as LK1 is able to recognise them. */
export interface Lk1TeamMember {
  /** LK1 client id of the player (`lk_games.participants[].id`), when the legacy mapping knows it. */
  readonly clientId: string | null;
  /** E.164 phone of the player, when the LK2 profile carries one. Never logged. */
  readonly phone: string | null;
}

export interface Lk1ResultBridgeRepository {
  loadHandoff(input: {
    readonly tenantId: string;
    readonly resultId: string;
  }): Promise<Lk1ResultHandoff | undefined>;
}

interface HandoffRow extends QueryResultRow {
  readonly game_id: string;
  readonly submitter_user_id: string;
  readonly result_id: string;
  readonly revision: number;
  readonly confirmed_at: Date | string;
  readonly lk1_game_aliases: readonly string[] | null;
  readonly submitter_phone: string | null;
  readonly score_payload: unknown;
}

interface RosterPhoneRow extends QueryResultRow {
  readonly user_id: string;
  readonly phone_e164: string | null;
}

interface RosterClientRow extends QueryResultRow {
  readonly internal_id: string;
  readonly external_id: string;
}

/** LK1 client ids are UUIDs; the same mapping table also holds pseudonymous hashes. */
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * LK2 records teams per set; LK1 keeps one score per game, so the first set's pairing is the
 * composition that belongs with the score LK1 stores.
 */
function firstSetTeams(scorePayload: unknown): {
  readonly teamAUserIds: readonly string[];
  readonly teamBUserIds: readonly string[];
} | null {
  if (typeof scorePayload !== 'object' || scorePayload === null) return null;
  const sets: unknown = (scorePayload as { readonly sets?: unknown }).sets;
  if (!Array.isArray(sets) || sets.length === 0) return null;
  const first: unknown = sets[0];
  if (typeof first !== 'object' || first === null) return null;
  const teamA = (first as { readonly teamAUserIds?: unknown }).teamAUserIds;
  const teamB = (first as { readonly teamBUserIds?: unknown }).teamBUserIds;
  if (!Array.isArray(teamA) || !Array.isArray(teamB)) return null;
  if (teamA.length === 0 || teamB.length === 0) return null;
  return {
    teamAUserIds: teamA.filter((id): id is string => typeof id === 'string'),
    teamBUserIds: teamB.filter((id): id is string => typeof id === 'string'),
  };
}

const HANDOFF_SQL = `
  select r.game_id, r.id as result_id, r.revision, r.confirmed_at,
         submission.score_payload,
         coalesce(r.confirmed_by_user_id, submission.submitted_by_user_id) as submitter_user_id,
         (
           select array_agg(mapping.external_id)
             from integration.external_entity_map mapping
            where mapping.tenant_id = r.tenant_id
              and mapping.internal_id = r.game_id
              and mapping.external_system = '${LK1_EXTERNAL_SYSTEM}'
              and mapping.entity_type = 'game'
         ) as lk1_game_aliases,
         summary.phone_e164 as submitter_phone
    from games.results r
    left join games.result_submissions submission
      on submission.tenant_id = r.tenant_id
     and submission.id = r.submission_id
    left join profile.user_summaries summary
      on summary.tenant_id = r.tenant_id
     and summary.user_id = coalesce(r.confirmed_by_user_id, submission.submitted_by_user_id)
   where r.tenant_id = $1 and r.id = $2 and r.state = 'CONFIRMED'
`;

const ROSTER_PHONES_SQL = `
  select user_id, phone_e164
    from profile.user_summaries
   where tenant_id = $1 and user_id = any($2::uuid[])
`;

const ROSTER_CLIENTS_SQL = `
  select internal_id, external_id
    from integration.external_entity_map
   where tenant_id = $1
     and entity_type = 'game_player'
     and external_system = '${LK1_EXTERNAL_SYSTEM}'
     and internal_id = any($2::uuid[])
`;

export function createLk1ResultBridgeRepository(pool: Pool): Lk1ResultBridgeRepository {
  return {
    loadHandoff(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const { rows } = await client.query<HandoffRow>(HANDOFF_SQL, [
          input.tenantId,
          input.resultId,
        ]);
        const row = rows[0];
        if (!row) return undefined;
        const pairing = firstSetTeams(row.score_payload);
        let teams: Lk1ResultHandoff['teams'] = null;
        let submitterClientId: string | null = null;
        if (pairing) {
          const userIds = [...new Set([...pairing.teamAUserIds, ...pairing.teamBUserIds])];
          const phones = await client.query<RosterPhoneRow>(ROSTER_PHONES_SQL, [
            input.tenantId,
            userIds,
          ]);
          const clients = await client.query<RosterClientRow>(ROSTER_CLIENTS_SQL, [
            input.tenantId,
            userIds,
          ]);
          const phoneOf = new Map(
            phones.rows
              .filter((phone) => typeof phone.phone_e164 === 'string' && phone.phone_e164 !== '')
              .map((phone) => [phone.user_id, phone.phone_e164 as string]),
          );
          const clientOf = new Map<string, string>();
          for (const mapping of clients.rows) {
            if (!CLIENT_ID.test(mapping.external_id)) continue;
            const chosen = clientOf.get(mapping.internal_id);
            if (!chosen || mapping.external_id < chosen) {
              clientOf.set(mapping.internal_id, mapping.external_id);
            }
          }
          const member = (userId: string): Lk1TeamMember => ({
            clientId: clientOf.get(userId) ?? null,
            phone: phoneOf.get(userId) ?? null,
          });
          const teamA = pairing.teamAUserIds.map(member);
          const teamB = pairing.teamBUserIds.map(member);
          submitterClientId = clientOf.get(row.submitter_user_id) ?? null;
          const identified = (members: readonly Lk1TeamMember[]) =>
            members.length > 0 &&
            members.every((entry) => entry.clientId !== null || entry.phone !== null);
          if (identified(teamA) && identified(teamB)) teams = { teamA, teamB };
        }
        return {
          tenantId: input.tenantId,
          gameId: row.game_id,
          resultId: row.result_id,
          resultRevision: row.revision,
          lk1GameId: selectLk1GameId(row.lk1_game_aliases ?? []),
          submitterPhoneE164: row.submitter_phone,
          submitterClientId,
          teams,
          confirmedAt: new Date(row.confirmed_at).toISOString(),
        };
      });
    },
  };
}
