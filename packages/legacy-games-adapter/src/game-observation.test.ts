import { beforeEach, describe, expect, it, vi } from 'vitest';

// Inert repository-port checks; no Mongo connection, fixture DB, auth or provider call.
const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  commands: [] as Record<string, unknown>[],
  fail: '',
  events: [] as { kind: string; value?: unknown }[],
}));
vi.mock('mongodb', () => ({
  MongoClient: class {
    constructor(_uri: string, options: unknown) {
      state.events.push({ kind: 'construct', value: options });
      if (state.fail === 'construct') throw Error('Synthetic sensitive constructor detail');
    }
    connect() {
      state.events.push({ kind: 'connect' });
      if (state.fail === 'connect') throw Error('Synthetic sensitive detail');
      return Promise.resolve();
    }
    close() {
      state.events.push({ kind: 'close' });
      return Promise.resolve();
    }
    db(name: string) {
      state.events.push({ kind: 'db', value: name });
      return {
        collection(name: string) {
          state.events.push({ kind: 'collection', value: name });
          return {
            aggregate(pipeline: unknown, options: unknown) {
              state.events.push({ kind: 'aggregate', value: { pipeline, options } });
              return {
                toArray() {
                  if (state.fail === 'game') throw Error('Synthetic read error');
                  return Promise.resolve(state.rows);
                },
              };
            },
            find(filter: unknown, options: unknown) {
              state.events.push({ kind: 'find', value: { filter, options } });
              return {
                limit(n: number) {
                  state.events.push({ kind: 'limit', value: n });
                  return {
                    toArray() {
                      if (state.fail === 'command') throw Error('Synthetic permission error');
                      return Promise.resolve(state.commands);
                    },
                  };
                },
              };
            },
          };
        },
      };
    }
  },
}));
import { LegacyGamesMongoAdapter } from './index.js';

const operationId = '00000000-0000-4000-8000-000000000001';
const exerciseId = '00000000-0000-4000-8000-000000000002';
const input = { tenantKey: 'test-tenant', gameId: 'test-game', operationId };
const observer = (options = {}) =>
  new LegacyGamesMongoAdapter({ uri: 'inert-unit-input', ...options });
beforeEach(() => {
  state.fail = '';
  state.events = [];
  state.rows = [
    {
      id: input.gameId,
      tenantKey: input.tenantKey,
      revision: 8,
      status: 'PAID',
      archived: false,
      updatedAt: '2099-10-12T07:00:00Z',
      metadata: { gameFormat: 'doubles', vivaExerciseId: exerciseId },
      booking: { vivaExerciseId: exerciseId },
      organizer: { id: 'organizer' },
      participantRowCount: 2,
      participantIds: ['organizer', 'player'],
      legacyCommand: { lastOperationId: operationId },
    },
  ];
  state.commands = [
    { tenantKey: input.tenantKey, legacyGameId: input.gameId, operationId, state: 'SUCCEEDED' },
  ];
});

describe('single-ID private game observation', () => {
  it('uses exact fixed collections, primary majority and bounded projected reads; money remains UNKNOWN', async () => {
    const result = await observer().readGameObservation(input);
    expect(result).toMatchObject({
      status: 'FOUND',
      source: 'games.lk_games',
      game: { revision: 8, sourceState: 'PAID', capacity: 4, participantRowCount: 2 },
      operation: { status: 'OBSERVED', sourceState: 'SUCCEEDED' },
      booking: 'UNKNOWN',
      benefit: 'UNKNOWN',
      settlement: 'UNKNOWN',
    });
    expect(result.observedAt).toMatch(/^\d{4}-/);
    expect(result.operation.observedAt).toMatch(/^\d{4}-/);
    expect(result.game?.participantKeys).toHaveLength(2);
    expect(result.game?.participantKeys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(state.events.find((e) => e.kind === 'construct')?.value).toMatchObject({
      readPreference: 'primary',
      readConcern: { level: 'majority' },
      retryReads: false,
      maxPoolSize: 1,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 5000,
    });
    const read = state.events.find((e) => e.kind === 'aggregate')?.value as {
      pipeline: Record<string, unknown>[];
      options: unknown;
    };
    expect(read.pipeline[0]).toEqual({ $match: { id: input.gameId, tenantKey: input.tenantKey } });
    expect(read.pipeline[1]).toEqual({ $limit: 2 });
    expect(read.options).toEqual({ maxTimeMS: 5000 });
    expect(JSON.stringify(read.pipeline[2])).not.toMatch(
      /phone|name|photo|payment|token|requestHash|idempotencyKey/i,
    );
    expect(state.events.find((e) => e.kind === 'find')?.value).toEqual({
      filter: { tenantKey: input.tenantKey, legacyGameId: input.gameId, operationId },
      options: {
        projection: { _id: 0, tenantKey: 1, legacyGameId: 1, operationId: 1, state: 1 },
        maxTimeMS: 5000,
      },
    });
    expect(state.events.find((e) => e.kind === 'limit')?.value).toBe(2);
    expect(state.events.at(-1)?.kind).toBe('close');
  });
  it('rejects operator injection, missing tenant, source override and unbounded timeout before constructing a client', async () => {
    for (const invalid of [
      { ...input, gameId: { $ne: null } },
      { ...input, gameId: '$where' },
      { ...input, gameId: { toString: () => input.gameId } },
      { ...input, tenantKey: undefined },
      { ...input, operationId: { $ne: null } },
    ]) {
      await expect(observer().readGameObservation(invalid as typeof input)).rejects.toThrow(
        'LEGACY_GAME_OBSERVATION_ID_INVALID',
      );
    }
    for (const options of [
      { dbName: 'other' },
      { collectionName: 'other' },
      { timeoutMs: 0 },
      { timeoutMs: 5001 },
      { timeoutMs: NaN },
    ]) {
      await expect(observer(options).readGameObservation(input)).rejects.toThrow(
        /LEGACY_GAME_OBSERVATION_(SOURCE|TIMEOUT)_INVALID/,
      );
    }
    expect(state.events).toEqual([]);
  });
  it('null tenant is explicit BSON-null, never a missing-tenant wildcard', async () => {
    state.rows[0]!.tenantKey = null;
    state.commands[0]!.tenantKey = null;
    expect((await observer().readGameObservation({ ...input, tenantKey: null })).status).toBe(
      'FOUND',
    );
    expect(state.events.find((e) => e.kind === 'aggregate')?.value).toMatchObject({
      pipeline: [{ $match: { id: input.gameId, tenantKey: { $type: 10 } } }, { $limit: 2 }, {}],
    });
  });
  it('missing, duplicate, wrong game/tenant rows disclose no game and never read an operation', async () => {
    for (const rows of [
      [],
      [state.rows[0]!, state.rows[0]!],
      [{ ...state.rows[0], id: 'other' }],
      [{ ...state.rows[0], tenantKey: 'other' }],
      [{ id: input.gameId }],
    ]) {
      state.rows = rows;
      state.events = [];
      const result = await observer().readGameObservation(input);
      expect(result.game).toBeNull();
      expect(['NOT_FOUND', 'AMBIGUOUS']).toContain(result.status);
      expect(state.events.some((e) => e.kind === 'find')).toBe(false);
    }
  });
  it('operation must be selected and exactly linked; no automatic ledger search', async () => {
    const unselected = await observer().readGameObservation({
      tenantKey: input.tenantKey,
      gameId: input.gameId,
    });
    expect(unselected.operation.reason).toBe('NOT_SELECTED');
    delete state.rows[0]!.legacyCommand;
    expect((await observer().readGameObservation(input)).operation.reason).toBe('LINK_UNPROVEN');
    expect(state.events.some((e) => e.kind === 'find')).toBe(false);
  });
  it('wrong, absent, duplicate and unknown command state remain UNKNOWN', async () => {
    const command = state.commands[0]!;
    for (const commands of [
      [],
      [command, command],
      [{ ...command, tenantKey: 'other' }],
      [{ ...command, operationId: exerciseId }],
      [{ ...command, legacyGameId: 'other' }],
      [{ ...command, state: 'UNRECOGNIZED' }],
    ]) {
      state.commands = commands;
      const result = await observer().readGameObservation(input);
      expect(result.status).toBe('FOUND');
      expect(result.operation.status).toBe('UNKNOWN');
      expect(result.operation.sourceState).toBeNull();
    }
  });
  it('connect/read/constructor errors are redacted without retries; permission error retains separate game observation', async () => {
    for (const fail of ['construct', 'connect', 'game', 'command']) {
      state.fail = fail;
      state.events = [];
      const result = await observer().readGameObservation(input);
      expect(result.status).toBe(fail === 'command' ? 'FOUND' : 'UNAVAILABLE');
      expect(result.operation.status).toBe('UNKNOWN');
      expect(JSON.stringify(result)).not.toMatch(/sensitive|permission|inert-unit/);
      expect(state.events.filter((e) => e.kind === 'construct')).toHaveLength(1);
      expect(state.events.filter((e) => e.kind === 'close')).toHaveLength(
        fail === 'construct' ? 0 : 1,
      );
    }
  });
  it('does not expose extra fields even if the driver returns them; capacity/association conflict is unknown', async () => {
    Object.assign(state.rows[0]!, {
      name: 'PRIVATE_FIXTURE_LABEL',
      phone: 'PRIVATE_FIXTURE_PHONE',
      token: 'PRIVATE_FIXTURE_SECRET',
      capacity: 2,
      participantIds: Array(20).fill('player'),
      booking: { vivaExerciseId: operationId },
    });
    state.rows[0]!.organizer = {
      id: 'organizer',
      name: 'PRIVATE_FIXTURE_LABEL',
      phone: 'PRIVATE_FIXTURE_PHONE',
    };
    const result = await observer().readGameObservation(input);
    expect(result.game?.capacity).toBeNull();
    expect(result.game?.exerciseAssociationKey).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_FIXTURE|organizer"|player"/);
    expect(result.game?.participantKeys).toHaveLength(1);
  });
});
