import { createHash, randomUUID } from 'node:crypto';

import {
  createDatabasePool,
  createGameRepository,
  createGameRosterRepository,
  withTenantTransaction,
} from '@phub/database';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const databaseName = new URL(connectionString).pathname.replace(/^\//, '');
if (!databaseName.endsWith('_verify')) {
  throw new Error('Games concurrency verification requires an isolated *_verify database');
}

const pool = createDatabasePool(connectionString);
const repository = createGameRosterRepository(pool);
const gameRepository = createGameRepository(pool);
const tenantId = randomUUID();
const organizerId = randomUUID();
const playerA = randomUUID();
const playerB = randomUUID();
const playerC = randomUUID();
const noPaymentGameId = randomUUID();
const splitGameId = randomUUID();
const stationId = randomUUID();
const startsAt = new Date(Date.now() + 86_400_000).toISOString();
const endsAt = new Date(Date.now() + 91_800_000).toISOString();
const cutoffAt = new Date(Date.now() + 82_800_000).toISOString();

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function commandInput(actorUserId: string, gameId: string, name: string) {
  return {
    tenantId,
    actorUserId,
    gameId,
    idempotencyKey: `games-verify-${name}-0001`,
    requestHash: requestHash({ actorUserId, gameId, name }),
    correlationId: `corr-games-verify-${name}-0001`,
  };
}

try {
  await pool.query(
    `insert into identity.tenants (id, tenant_key, display_name)
     values ($1, $2, 'Games roster verification')`,
    [tenantId, `games-verify-${tenantId.slice(0, 8)}`],
  );
  await withTenantTransaction(pool, tenantId, async (client) => {
    await client.query(
      `insert into identity.users (id, tenant_id)
       select user_id, $1
         from unnest($2::uuid[]) users(user_id)`,
      [tenantId, [organizerId, playerA, playerB, playerC]],
    );
    await client.query(
      `insert into profile.user_summaries (tenant_id, user_id, display_name)
       select $1, user_id, display_name
         from unnest($2::uuid[], $3::text[]) users(user_id, display_name)`,
      [
        tenantId,
        [organizerId, playerA, playerB, playerC],
        ['Организатор', 'Игрок A', 'Игрок B', 'Игрок C'],
      ],
    );
    await client.query(
      `insert into locations.profiles (
         tenant_id, id, slug, title, address, publication_status,
         created_by, updated_by, published_at
       ) values ($1, $2, 'games-verify-station', 'Тестовая станция', 'Москва', 'PUBLISHED', $3, $3, now())`,
      [tenantId, stationId, organizerId],
    );
    await client.query(
      `insert into games.games (
         tenant_id, id, organizer_user_id, title, kind, visibility, lifecycle_state,
         station_id, starts_at, ends_at, timezone, capacity, waitlist_enabled,
         join_cutoff_at, payment_mode
       ) values
       ($1, $2, $4, 'No-payment concurrency', 'FRIENDLY', 'PUBLIC', 'SCHEDULED',
        $5, $6, $7, 'Europe/Moscow', 2, true, $8, 'NO_PAYMENT'),
       ($1, $3, $4, 'Split reservation concurrency', 'FRIENDLY', 'PUBLIC', 'SCHEDULED',
        $5, $6, $7, 'Europe/Moscow', 2, true, $8, 'SPLIT')`,
      [tenantId, noPaymentGameId, splitGameId, organizerId, stationId, startsAt, endsAt, cutoffAt],
    );
    await client.query(
      `insert into games.participations (
         tenant_id, game_id, user_id, role, state, payment_state
       ) values
       ($1, $2, $4, 'ORGANIZER', 'ACTIVE', 'NOT_REQUIRED'),
       ($1, $3, $4, 'ORGANIZER', 'ACTIVE', 'NOT_REQUIRED')`,
      [tenantId, noPaymentGameId, splitGameId, organizerId],
    );
  });

  const directInputs = [
    commandInput(playerA, noPaymentGameId, 'direct-a'),
    commandInput(playerB, noPaymentGameId, 'direct-b'),
  ] as const;
  const directResults = await Promise.all(directInputs.map((input) => repository.join(input)));
  const directApplied = directResults.filter((result) => result.outcome === 'applied');
  const directRejected = directResults.filter((result) => result.outcome === 'rejected');
  if (
    directApplied.length !== 1 ||
    directRejected.length !== 1 ||
    directRejected[0]?.code !== 'GAME_FULL'
  ) {
    throw new Error(`Direct join race failed: ${JSON.stringify(directResults)}`);
  }
  const directWinnerIndex = directResults.findIndex((result) => result.outcome === 'applied');
  const directWinnerInput = directInputs[directWinnerIndex];
  if (!directWinnerInput) throw new Error('Direct join winner missing');
  const directReplay = await repository.join(directWinnerInput);
  if (directReplay.outcome !== 'applied' || !directReplay.replayed) {
    throw new Error(`Direct replay failed: ${JSON.stringify(directReplay)}`);
  }
  const directOperation = await repository.getOperation({
    tenantId,
    actorUserId: directWinnerInput.actorUserId,
    operationId: directReplay.commandId,
  });
  if (
    directOperation?.state !== 'COMPLETED' ||
    directOperation.commandType !== 'game.join.v1' ||
    directOperation.result?.commandId !== directReplay.commandId
  ) {
    throw new Error(`Durable operation read failed: ${JSON.stringify(directOperation)}`);
  }

  const rejectedPlayer = directWinnerInput.actorUserId === playerA ? playerB : playerA;
  const waitlistJoin = await repository.joinWaitlist(
    commandInput(rejectedPlayer, noPaymentGameId, 'waitlist-join'),
  );
  if (
    waitlistJoin.outcome !== 'applied' ||
    waitlistJoin.position !== 1 ||
    !waitlistJoin.waitlistEntryId
  ) {
    throw new Error(`Waitlist join failed: ${JSON.stringify(waitlistJoin)}`);
  }
  const directLeave = await repository.leave(
    commandInput(directWinnerInput.actorUserId, noPaymentGameId, 'direct-leave'),
  );
  if (directLeave.outcome !== 'applied') {
    throw new Error(`Direct leave failed: ${JSON.stringify(directLeave)}`);
  }
  const promotionInput = {
    tenantId,
    gameId: noPaymentGameId,
    commandId: randomUUID(),
    idempotencyKey: 'games-verify-promote-0001',
    requestHash: requestHash({
      gameId: noPaymentGameId,
      waitlistEntryId: waitlistJoin.waitlistEntryId,
    }),
    correlationId: 'corr-games-verify-promote-0001',
    waitlistEntryId: waitlistJoin.waitlistEntryId,
  };
  const promotion = await repository.promoteWaitlist(promotionInput);
  const promotionReplay = await repository.promoteWaitlist(promotionInput);
  if (
    promotion.outcome !== 'applied' ||
    promotionReplay.outcome !== 'applied' ||
    !promotionReplay.replayed
  ) {
    throw new Error(`Waitlist promotion failed: ${JSON.stringify({ promotion, promotionReplay })}`);
  }

  const splitResults = await Promise.all([
    repository.join(commandInput(playerA, splitGameId, 'split-a')),
    repository.join(commandInput(playerC, splitGameId, 'split-c')),
  ]);
  const splitApplied = splitResults.filter((result) => result.outcome === 'applied');
  const splitRejected = splitResults.filter((result) => result.outcome === 'rejected');
  if (
    splitApplied.length !== 1 ||
    splitApplied[0]?.viewerRelation !== 'SEAT_RESERVED' ||
    splitRejected.length !== 1 ||
    splitRejected[0]?.code !== 'GAME_FULL'
  ) {
    throw new Error(`Split reservation race failed: ${JSON.stringify(splitResults)}`);
  }
  const splitReservation = splitApplied[0];
  if (splitReservation?.outcome !== 'applied' || !splitReservation.reservationId) {
    throw new Error('Split reservation identifier missing');
  }
  await withTenantTransaction(pool, tenantId, async (client) => {
    await client.query(
      `update games.seat_reservations
          set created_at = now() - interval '2 seconds',
              expires_at = now() - interval '1 second'
        where tenant_id = $1 and game_id = $2 and id = $3`,
      [tenantId, splitGameId, splitReservation.reservationId],
    );
  });
  const expiryInput = {
    tenantId,
    gameId: splitGameId,
    commandId: randomUUID(),
    idempotencyKey: 'games-verify-expiry-0001',
    requestHash: requestHash({
      gameId: splitGameId,
      reservationId: splitReservation.reservationId,
    }),
    correlationId: 'corr-games-verify-expiry-0001',
    reservationId: splitReservation.reservationId,
  };
  const expiry = await repository.expireReservation(expiryInput);
  if (expiry.outcome !== 'applied') {
    throw new Error(`Reservation expiry failed: ${JSON.stringify(expiry)}`);
  }

  const projectionEventId = randomUUID();
  const projection = await gameRepository.projectCardEvent({
    tenantId,
    eventId: projectionEventId,
    gameId: noPaymentGameId,
  });
  const projectionReplay = await gameRepository.projectCardEvent({
    tenantId,
    eventId: projectionEventId,
    gameId: noPaymentGameId,
  });
  const storedProjection = await gameRepository.getCardProjection(tenantId, noPaymentGameId);
  const viewerCards = await gameRepository.listViewerCardProjections({
    tenantId,
    viewerUserId: rejectedPlayer,
    scope: 'UPCOMING',
    limit: 20,
  });
  if (
    projection !== 'applied' ||
    projectionReplay !== 'duplicate' ||
    storedProjection?.basePayload.participants.length !== 2 ||
    storedProjection.basePayload.waitlist.length !== 0 ||
    viewerCards.items.length !== 1 ||
    viewerCards.items[0]?.gameId !== noPaymentGameId
  ) {
    throw new Error(
      `Card projection verification failed: ${JSON.stringify({
        projection,
        projectionReplay,
        storedProjection,
        viewerCards,
      })}`,
    );
  }

  const state = await withTenantTransaction(pool, tenantId, async (client) => {
    const counts = await client.query<{
      active_participants: number;
      active_reservations: number;
      active_waitlist: number;
      promotion_commands: number;
      audit_rows: number;
      outbox_rows: number;
    }>(
      `select
       (select count(*)::integer from games.participations
         where tenant_id = $1 and game_id = $2 and state = 'ACTIVE') as active_participants,
       (select count(*)::integer from games.seat_reservations
         where tenant_id = $1 and game_id = $3 and state = 'ACTIVE') as active_reservations,
       (select count(*)::integer from games.waitlist_entries
         where tenant_id = $1 and game_id = $2 and state = 'ACTIVE') as active_waitlist,
       (select count(*)::integer from games.scheduled_commands
         where tenant_id = $1 and game_id = $2 and command_type = 'game.waitlist.promote.v1')
         as promotion_commands,
       (select count(*)::integer from audit.audit_log
         where tenant_id = $1 and resource_id in ($2, $3)) as audit_rows,
       (select count(*)::integer from audit.outbox_events
         where tenant_id = $1 and aggregate_id in ($2, $3)) as outbox_rows`,
      [tenantId, noPaymentGameId, splitGameId],
    );
    return counts.rows[0];
  });
  if (
    !state ||
    state.active_participants !== 2 ||
    state.active_reservations !== 0 ||
    state.active_waitlist !== 0 ||
    state.promotion_commands !== 1 ||
    state.audit_rows !== 8 ||
    state.outbox_rows !== 11
  ) {
    throw new Error(`Stored roster state mismatch: ${JSON.stringify(state)}`);
  }

  process.stdout.write(
    `${JSON.stringify({
      directResults,
      directReplay,
      directOperation,
      waitlistJoin,
      directLeave,
      promotion,
      promotionReplay,
      splitResults,
      expiry,
      projection,
      projectionReplay,
      storedProjection,
      viewerCards,
      state,
    })}\n`,
  );
} finally {
  await pool.end();
}
