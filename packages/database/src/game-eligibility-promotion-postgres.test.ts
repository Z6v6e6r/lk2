import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenantTransaction } from './connection.js';
import { createGameRepository } from './game-repository.js';
import { createGameRosterRepository } from './game-roster-repository.js';

const connectionString = process.env.GAME_ELIGIBILITY_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;

describePostgres('waitlist invitation revalidation on PostgreSQL', () => {
  const pool = new Pool({ connectionString, max: 4 });
  const games = createGameRepository(pool);
  const roster = createGameRosterRepository(pool);
  afterAll(async () => pool.end());

  it.each(['valid', 'revoked', 'expired', 'exhausted'] as const)(
    'retains OFF invitation and revalidates %s invitation after BLOCK activation',
    async (invitationState) => {
      const tenantId = randomUUID();
      const organizerId = randomUUID();
      const playerId = randomUUID();
      const waitingId = randomUUID();
      const nextPlayerId = randomUUID();
      const stationId = randomUUID();
      const invitationId = randomUUID();
      await pool.query(
        'insert into identity.tenants (id, tenant_key, display_name) values ($1, $2, $3)',
        [tenantId, `eligibility-${tenantId}`, 'Eligibility fixture'],
      );
      await withTenantTransaction(pool, tenantId, async (client) => {
        await client.query(
          "insert into identity.users (tenant_id, id, status) select $1, id, 'ACTIVE' from unnest($2::uuid[]) id",
          [tenantId, [organizerId, playerId, waitingId, nextPlayerId]],
        );
        await client.query(
          "insert into locations.profiles (tenant_id, id, slug, title, publication_status, created_by, updated_by, published_at) values ($1, $2, $3, 'Test station', 'PUBLISHED', $4, $4, now())",
          [tenantId, stationId, `eligibility-${stationId}`, organizerId],
        );
        await client.query(
          "insert into eligibility.level_policies (tenant_id, sport_code, activity_type, mode, version) values ($1, 'PADEL', 'GAME', 'OFF', 1)",
          [tenantId],
        );
      });
      const command = () => {
        const id = randomUUID();
        return {
          idempotencyKey: id,
          requestHash: createHash('sha256').update(id).digest('hex'),
          correlationId: id,
        };
      };
      const startsAt = new Date(Date.now() + 86_400_000);
      const created = await games.create({
        tenantId,
        actorUserId: organizerId,
        ...command(),
        title: 'Invitation promotion fixture',
        kind: 'FRIENDLY',
        visibility: 'PUBLIC',
        stationId,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
        timezone: 'Europe/Moscow',
        capacity: 2,
        waitlistEnabled: true,
        joinCutoffAt: new Date(startsAt.getTime() - 1_800_000).toISOString(),
        paymentMode: 'NO_PAYMENT',
      });
      expect(created.outcome).toBe('applied');
      if (created.outcome !== 'applied') throw new Error('GAME_FIXTURE_FAILED');
      const gameId = created.gameId;
      await withTenantTransaction(pool, tenantId, (client) =>
        client.query(
          "insert into eligibility.personal_invitations (tenant_id, id, activity_type, activity_id, invitation_type, recipient_player_id, expires_at, created_by) values ($1, $2, 'GAME', $3, 'PERSONAL', $4, now() + interval '2 days', $5)",
          [tenantId, invitationId, gameId, waitingId, organizerId],
        ),
      );
      await expect(
        roster.join({ tenantId, actorUserId: playerId, gameId, ...command() }),
      ).resolves.toMatchObject({ outcome: 'applied' });
      const waiting = await roster.joinWaitlist({
        tenantId,
        actorUserId: waitingId,
        gameId,
        invitationId,
        ...command(),
      });
      expect(waiting.outcome).toBe('applied');
      if (waiting.outcome !== 'applied' || !waiting.waitlistEntryId)
        throw new Error('WAITLIST_FIXTURE_FAILED');
      const next = await roster.joinWaitlist({
        tenantId,
        actorUserId: nextPlayerId,
        gameId,
        ...command(),
      });
      expect(next.outcome).toBe('applied');
      if (next.outcome !== 'applied' || !next.waitlistEntryId)
        throw new Error('NEXT_WAITLIST_FIXTURE_FAILED');
      await withTenantTransaction(pool, tenantId, async (client) => {
        const saved = await client.query<{ personal_invitation_id: string | null }>(
          'select personal_invitation_id from games.waitlist_entries where tenant_id = $1 and id = $2',
          [tenantId, waiting.waitlistEntryId],
        );
        expect(saved.rows[0]?.personal_invitation_id).toBe(invitationId);
        const invite = await client.query<{ use_count: number }>(
          'select use_count from eligibility.personal_invitations where tenant_id = $1 and id = $2',
          [tenantId, invitationId],
        );
        expect(invite.rows[0]?.use_count).toBe(0);
        await client.query(
          "insert into eligibility.canonical_levels (tenant_id, sport_code, code, title, rank, sort_order, scale_version) values ($1, 'PADEL', 'C', 'C', 3, 3, 1)",
          [tenantId],
        );
        await client.query(
          "update games.games set level_from = 'C', level_to = 'C' where tenant_id = $1 and id = $2",
          [tenantId, gameId],
        );
        await client.query(
          'update eligibility.level_policies set active = false where tenant_id = $1',
          [tenantId],
        );
        await client.query(
          "insert into eligibility.level_policies (tenant_id, sport_code, activity_type, mode, version) values ($1, 'PADEL', 'GAME', 'BLOCK', 2)",
          [tenantId],
        );
        if (invitationState === 'revoked')
          await client.query(
            "update eligibility.personal_invitations set status = 'REVOKED', revoked_at = now() where tenant_id = $1 and id = $2",
            [tenantId, invitationId],
          );
        if (invitationState === 'expired')
          await client.query(
            "update eligibility.personal_invitations set created_at = now() - interval '2 days', expires_at = now() - interval '1 day' where tenant_id = $1 and id = $2",
            [tenantId, invitationId],
          );
        if (invitationState === 'exhausted')
          await client.query(
            'update eligibility.personal_invitations set use_count = max_uses where tenant_id = $1 and id = $2',
            [tenantId, invitationId],
          );
      });
      await expect(
        roster.leave({ tenantId, actorUserId: playerId, gameId, ...command() }),
      ).resolves.toMatchObject({ outcome: 'applied' });
      const promotion = {
        tenantId,
        gameId,
        commandId: randomUUID(),
        waitlistEntryId: waiting.waitlistEntryId,
        ...command(),
      };
      await expect(roster.promoteWaitlist(promotion)).resolves.toMatchObject({
        outcome: 'applied',
        replayed: false,
      });
      await expect(roster.promoteWaitlist(promotion)).resolves.toMatchObject({
        outcome: 'applied',
        replayed: true,
      });
      await withTenantTransaction(pool, tenantId, async (client) => {
        const entry = await client.query<{ state: string }>(
          'select state from games.waitlist_entries where tenant_id = $1 and id = $2',
          [tenantId, waiting.waitlistEntryId],
        );
        expect(entry.rows[0]?.state).toBe(invitationState === 'valid' ? 'PROMOTED' : 'EXPIRED');
        const invite = await client.query<{ use_count: number }>(
          'select use_count from eligibility.personal_invitations where tenant_id = $1 and id = $2',
          [tenantId, invitationId],
        );
        expect(invite.rows[0]?.use_count).toBe(
          invitationState === 'valid' || invitationState === 'exhausted' ? 1 : 0,
        );
        const participants = await client.query(
          "select id from games.participations where tenant_id = $1 and game_id = $2 and user_id = $3 and state = 'ACTIVE'",
          [tenantId, gameId, waitingId],
        );
        expect(participants.rowCount).toBe(invitationState === 'valid' ? 1 : 0);
        if (invitationState !== 'valid') {
          const scheduled = await client.query<{ payload: unknown }>(
            "select payload from games.scheduled_commands where tenant_id = $1 and game_id = $2 and command_type = 'game.waitlist.promote.v1'",
            [tenantId, gameId],
          );
          expect(
            scheduled.rows.some((row) =>
              JSON.stringify(row.payload).includes(next.waitlistEntryId!),
            ),
          ).toBe(true);
        }
      });
    },
  );
});
