/**
 * QA scenario 1 — tournament/game join capacity race.
 *
 * Where capacity actually lives (verified, not assumed):
 *   - persistence: `games.capacity smallint not null check (capacity between 2 and 4)`
 *     (packages/database/migrations/0023_games_foundation.sql:21) — there is no `max_players`
 *     column anywhere in LK2.
 *   - domain gate: `assertCanJoinGameFacts()` in this package rejects a join when
 *     `activeParticipantCount + activeReservationCount >= capacity` with `GAME_FULL`.
 *   - serialisation: `game-roster-repository.join()` evaluates that gate inside a transaction
 *     that first locks the game row (`select ... from games.games ... for update`), so concurrent
 *     joins for one game queue behind each other. That is the layer that prevents overfill.
 *
 * This file executes the domain gate for real and models the lock-then-count-then-reject contract
 * with a serialising executor. It is NOT the overfill proof: the authoritative concurrent proof is
 * `packages/database/src/game-capacity-race-postgres.test.ts`, which runs real parallel PostgreSQL
 * transactions and skips cleanly when no disposable database is supplied.
 */
import { describe, expect, it } from 'vitest';

import { assertCanJoinGameFacts, GameDomainError, type GameRosterCommandFacts } from './index.js';

const NOW = '2026-11-18T09:00:00.000Z';
const STARTS_AT = '2026-11-20T09:00:00.000Z';
const CUTOFF = '2026-11-20T08:30:00.000Z';

function facts(overrides: Partial<GameRosterCommandFacts> = {}): GameRosterCommandFacts {
  return {
    lifecycleState: 'SCHEDULED',
    startsAt: STARTS_AT,
    joinCutoffAt: CUTOFF,
    capacity: 4,
    activeParticipantCount: 0,
    activeReservationCount: 0,
    waitlistEnabled: true,
    viewerRelation: 'NONE',
    ...overrides,
  };
}

function codeOf(run: () => void): string {
  try {
    run();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof GameDomainError ? error.code : 'UNEXPECTED_ERROR';
  }
}

/**
 * Reproduces the repository's serialisation contract: every join attempt runs exclusively, and the
 * capacity gate is evaluated against occupancy observed *inside* the critical section. A join the
 * gate rejects never increments occupancy.
 */
class SerialisedCapacityGate {
  private tail: Promise<unknown> = Promise.resolve();
  private occupied: number;
  public readonly admitted: string[] = [];

  public constructor(
    private readonly capacity: number,
    initialOccupied: number,
  ) {
    this.occupied = initialOccupied;
  }

  public join(viewer: string): Promise<'applied' | 'GAME_FULL'> {
    const run = (): 'applied' | 'GAME_FULL' => {
      const code = codeOf(() =>
        assertCanJoinGameFacts(
          facts({
            capacity: this.capacity,
            activeParticipantCount: this.occupied,
          }),
          NOW,
        ),
      );
      if (code === 'NO_ERROR') {
        this.occupied += 1;
        this.admitted.push(viewer);
        return 'applied';
      }
      expect(code).toBe('GAME_FULL');
      return 'GAME_FULL';
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  public get occupancy(): number {
    return this.occupied;
  }
}

describe('scenario 1: capacity gate admits exactly the free seats', () => {
  it('admits a join at capacity-1 and refuses the join that would land on capacity', () => {
    expect(codeOf(() => assertCanJoinGameFacts(facts({ activeParticipantCount: 3 }), NOW))).toBe(
      'NO_ERROR',
    );
    expect(codeOf(() => assertCanJoinGameFacts(facts({ activeParticipantCount: 4 }), NOW))).toBe(
      'GAME_FULL',
    );
  });

  it('treats active seat reservations as occupied seats', () => {
    expect(
      codeOf(() =>
        assertCanJoinGameFacts(
          facts({ activeParticipantCount: 2, activeReservationCount: 1 }),
          NOW,
        ),
      ),
    ).toBe('NO_ERROR');
    expect(
      codeOf(() =>
        assertCanJoinGameFacts(
          facts({ activeParticipantCount: 2, activeReservationCount: 2 }),
          NOW,
        ),
      ),
    ).toBe('GAME_FULL');
  });

  it('refuses facts that already exceed capacity instead of silently accepting them', () => {
    expect(
      codeOf(() =>
        assertCanJoinGameFacts(
          facts({ activeParticipantCount: 4, activeReservationCount: 1 }),
          NOW,
        ),
      ),
    ).toBe('GAME_CAPACITY_INVARIANT_VIOLATION');
  });
});

describe('scenario 1: concurrent joins against the serialised gate never overfill', () => {
  it('admits exactly one of six concurrent joins when one seat is free', async () => {
    const gate = new SerialisedCapacityGate(4, 3);
    const outcomes = await Promise.all(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((viewer) => gate.join(viewer)),
    );
    expect(outcomes.filter((outcome) => outcome === 'applied')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'GAME_FULL')).toHaveLength(5);
    expect(gate.occupancy).toBe(4);
    expect(gate.admitted).toHaveLength(1);
  });

  it('admits exactly two of eight concurrent joins when two seats are free', async () => {
    const gate = new SerialisedCapacityGate(4, 2);
    const outcomes = await Promise.all(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((viewer) => gate.join(viewer)),
    );
    expect(outcomes.filter((outcome) => outcome === 'applied')).toHaveLength(2);
    expect(gate.occupancy).toBe(4);
  });

  it('admits nobody when the game is already at capacity', async () => {
    const gate = new SerialisedCapacityGate(2, 2);
    const outcomes = await Promise.all(['a', 'b', 'c'].map((viewer) => gate.join(viewer)));
    expect(outcomes.every((outcome) => outcome === 'GAME_FULL')).toBe(true);
    expect(gate.occupancy).toBe(2);
  });
});
