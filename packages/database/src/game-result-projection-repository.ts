import type { GameResultSetInput } from '@phub/games';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { withTenantTransaction } from './connection.js';

export interface ConfirmedGameResultProjection {
  readonly tenantId: string;
  readonly gameId: string;
  readonly resultId: string;
  readonly resultRevision: number;
  readonly kind: 'FRIENDLY' | 'RATING' | 'PRIVATE' | 'COACH_GAME';
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly venueName: string | null;
  readonly participantUserIds: readonly string[];
  readonly sets: readonly GameResultSetInput[];
}

export interface GameResultProjectionRepository {
  loadConfirmedResult(input: {
    readonly tenantId: string;
    readonly resultId: string;
  }): Promise<ConfirmedGameResultProjection | undefined>;
  projectConfirmedResultEvent(input: {
    readonly tenantId: string;
    readonly eventId: string;
    readonly resultId: string;
  }): Promise<'applied' | 'duplicate' | 'result_not_found'>;
}

interface ResultFactRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly game_id: string;
  readonly result_id: string;
  readonly result_revision: number;
  readonly kind: ConfirmedGameResultProjection['kind'];
  readonly title: string;
  readonly starts_at: Date | string;
  readonly ends_at: Date | string;
  readonly venue_name: string | null;
  readonly set_number: number;
  readonly team_a_score: number;
  readonly team_b_score: number;
  readonly user_id: string;
  readonly team: 'A' | 'B';
  readonly slot: 1 | 2;
}

const RESULT_FACTS_SQL = `
  select r.tenant_id, r.game_id, r.id as result_id, r.revision as result_revision,
         g.kind, g.title, g.starts_at, g.ends_at,
         nullif(cp.base_payload -> 'station' ->> 'name', '') as venue_name,
         s.set_number, s.team_a_score, s.team_b_score,
         p.user_id, p.team, p.slot
    from games.results r
    join games.games g
      on g.tenant_id = r.tenant_id and g.id = r.game_id
    join games.result_sets s
      on s.tenant_id = r.tenant_id and s.result_id = r.id
    join games.result_set_players p
      on p.tenant_id = s.tenant_id
     and p.result_id = s.result_id
     and p.set_number = s.set_number
    left join games.card_projections cp
      on cp.tenant_id = g.tenant_id and cp.game_id = g.id
   where r.tenant_id = $1 and r.id = $2 and r.state = 'CONFIRMED'
   order by s.set_number, p.team, p.slot
`;

function timestamp(value: Date | string): string {
  return new Date(value).toISOString();
}

function mapConfirmedResult(
  rows: readonly ResultFactRow[],
): ConfirmedGameResultProjection | undefined {
  const first = rows[0];
  if (!first) return undefined;
  const sets = new Map<
    number,
    {
      setNumber: number;
      teamAUserIds: string[];
      teamBUserIds: string[];
      teamA: number;
      teamB: number;
    }
  >();
  for (const row of rows) {
    const set = sets.get(row.set_number) ?? {
      setNumber: row.set_number,
      teamAUserIds: [],
      teamBUserIds: [],
      teamA: row.team_a_score,
      teamB: row.team_b_score,
    };
    (row.team === 'A' ? set.teamAUserIds : set.teamBUserIds).push(row.user_id);
    sets.set(row.set_number, set);
  }
  const mappedSets: GameResultSetInput[] = [...sets.values()].map((set) => {
    if (set.teamAUserIds.length !== 2 || set.teamBUserIds.length !== 2) {
      throw new Error('GAME_RESULT_SET_ROSTER_INCOMPLETE');
    }
    return {
      setNumber: set.setNumber,
      teamAUserIds: [set.teamAUserIds[0]!, set.teamAUserIds[1]!],
      teamBUserIds: [set.teamBUserIds[0]!, set.teamBUserIds[1]!],
      teamA: set.teamA,
      teamB: set.teamB,
    };
  });
  return {
    tenantId: first.tenant_id,
    gameId: first.game_id,
    resultId: first.result_id,
    resultRevision: first.result_revision,
    kind: first.kind,
    title: first.title,
    startsAt: timestamp(first.starts_at),
    endsAt: timestamp(first.ends_at),
    venueName: first.venue_name,
    participantUserIds: [
      ...new Set(mappedSets.flatMap((set) => [...set.teamAUserIds, ...set.teamBUserIds])),
    ],
    sets: mappedSets,
  };
}

async function loadWithClient(
  client: PoolClient,
  input: { readonly tenantId: string; readonly resultId: string },
): Promise<ConfirmedGameResultProjection | undefined> {
  const result = await client.query<ResultFactRow>(RESULT_FACTS_SQL, [
    input.tenantId,
    input.resultId,
  ]);
  return mapConfirmedResult(result.rows);
}

async function projectPlayerFacts(
  client: PoolClient,
  result: ConfirmedGameResultProjection,
): Promise<void> {
  for (const set of result.sets) {
    for (const [team, userIds, scoreFor, scoreAgainst] of [
      ['A', set.teamAUserIds, set.teamA, set.teamB],
      ['B', set.teamBUserIds, set.teamB, set.teamA],
    ] as const) {
      for (let index = 0; index < userIds.length; index += 1) {
        await client.query(
          `insert into games.player_set_facts (
             tenant_id, game_id, result_id, result_revision, set_number,
             user_id, teammate_user_id, team, score_for, score_against, outcome, occurred_at
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           on conflict (tenant_id, result_id, set_number, user_id) do nothing`,
          [
            result.tenantId,
            result.gameId,
            result.resultId,
            result.resultRevision,
            set.setNumber,
            userIds[index],
            userIds[index === 0 ? 1 : 0],
            team,
            scoreFor,
            scoreAgainst,
            scoreFor > scoreAgainst ? 'WON' : 'LOST',
            result.endsAt,
          ],
        );
      }
    }
  }
}

async function projectActivityHistory(
  client: PoolClient,
  result: ConfirmedGameResultProjection,
): Promise<void> {
  const sourceRevision = `game-result:${result.resultId}:v${result.resultRevision}`;
  const details = JSON.stringify({
    resultId: result.resultId,
    resultRevision: result.resultRevision,
    sets: result.sets,
  });
  for (const userId of result.participantUserIds) {
    await client.query(
      `insert into booking.activity_history_projection (
         tenant_id, user_id, id, kind, status, occurred_at, starts_at, ends_at,
         title, venue_name, route, game_id, details, source_revision, synced_at
       ) values ($1, $2, $3, 'GAME', 'COMPLETED', $4, $5, $6,
                 $7, $8, $9, $3, $10::jsonb, $11, now())
       on conflict (tenant_id, user_id, id) do update
         set status = excluded.status,
             occurred_at = excluded.occurred_at,
             starts_at = excluded.starts_at,
             ends_at = excluded.ends_at,
             title = excluded.title,
             venue_name = excluded.venue_name,
             route = excluded.route,
             game_id = excluded.game_id,
             details = excluded.details,
             source_revision = excluded.source_revision,
             synced_at = excluded.synced_at,
             updated_at = now()`,
      [
        result.tenantId,
        userId,
        result.gameId,
        result.endsAt,
        result.startsAt,
        result.endsAt,
        result.title,
        result.venueName,
        `/games/${result.gameId}`,
        details,
        sourceRevision,
      ],
    );
  }
}

export function createGameResultProjectionRepository(pool: Pool): GameResultProjectionRepository {
  return {
    loadConfirmedResult(input) {
      return withTenantTransaction(pool, input.tenantId, (client) => loadWithClient(client, input));
    },

    projectConfirmedResultEvent(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const consumerName = 'games-result-history-projector-v1';
        const inbox = await client.query(
          `insert into audit.inbox_events (consumer_name, event_id, tenant_id)
           values ($1, $2, $3)
           on conflict (consumer_name, event_id) do nothing
           returning event_id`,
          [consumerName, input.eventId, input.tenantId],
        );
        if (inbox.rowCount === 0) return 'duplicate';
        const result = await loadWithClient(client, input);
        if (!result) {
          // A confirmed-result event can arrive before its source rows are visible. Keep the
          // broker redelivery eligible to claim the same event instead of committing a duplicate
          // fence that would leave player history permanently stale.
          await client.query(
            `delete from audit.inbox_events
              where consumer_name = $1 and event_id = $2 and processed_at is null`,
            [consumerName, input.eventId],
          );
          return 'result_not_found';
        }
        await projectPlayerFacts(client, result);
        await projectActivityHistory(client, result);
        await client.query(
          `update audit.inbox_events set processed_at = now()
            where consumer_name = $1 and event_id = $2`,
          [consumerName, input.eventId],
        );
        return 'applied';
      });
    },
  };
}
