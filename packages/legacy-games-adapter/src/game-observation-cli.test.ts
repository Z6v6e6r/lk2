import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Owned inert driver I/O only. These tests never connect to Mongo or load runtime secrets.
const state = vi.hoisted(() => ({
  fail: '',
  rows: [] as Record<string, unknown>[],
  events: [] as { kind: string; value?: unknown }[],
}));
const uri = 'mongodb://unit.invalid/games';
vi.mock('mongodb', () => ({
  MongoClient: class {
    constructor(value: string, options: unknown) {
      state.events.push({ kind: 'construct', value: { uri: value, options } });
      if (state.fail === 'construct') throw Error('UNIT_PRIVATE_PHONE UNIT_PROVIDER_PAYLOAD');
    }
    connect() {
      state.events.push({ kind: 'connect' });
      if (state.fail === 'connect') throw Error('mongodb://unit.invalid/games UNIT_PRIVATE_PHONE');
      return Promise.resolve();
    }
    close() {
      state.events.push({ kind: 'close' });
      return state.fail === 'close'
        ? Promise.reject(Error('UNIT_PROVIDER_PAYLOAD'))
        : Promise.resolve();
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
                  if (state.fail === 'read')
                    throw Error('UNIT_PRIVATE_PHONE UNIT_PROVIDER_PAYLOAD');
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
                    toArray: () =>
                      Promise.resolve([
                        {
                          tenantKey: 'unit-tenant',
                          legacyGameId: 'unit-game',
                          operationId: '00000000-0000-4000-8000-000000000001',
                          state: 'SUCCEEDED',
                        },
                      ]),
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
import { runGameObservationCli } from './game-observation-cli.js';

const operationId = '00000000-0000-4000-8000-000000000001';
const args = [
  '--game-id',
  'unit-game',
  '--tenant-key',
  'unit-tenant',
  '--operation-id',
  operationId,
];
function io() {
  return { readUri: vi.fn(() => uri as string | undefined), stdout: vi.fn(), stderr: vi.fn() };
}
beforeEach(() => {
  state.fail = '';
  state.events = [];
  // No matching command link, so a selected operation must remain LINK_UNPROVEN.
  state.rows = [
    {
      id: 'unit-game',
      tenantKey: 'unit-tenant',
      status: 'PAID',
      revision: 1,
      organizer: { id: 'unit-organizer', phone: 'UNIT_PRIVATE_PHONE' },
      participantIds: ['unit-player'],
      participantRowCount: 1,
      name: 'UNIT_PRIVATE_NAME',
      token: 'UNIT_PRIVATE_TOKEN',
    },
  ];
});

describe('internal one-game observation CLI', () => {
  it.each([
    [],
    ['--game-id', 'unit-game'],
    ['--game-id', '*', '--tenant-key', 'unit-tenant'],
    ['--game-id', '{"$ne":null}', '--tenant-key', 'unit-tenant'],
    ['--game-id', 'unit-game', '--tenant-key', ''],
    ['--game-id', 'unit-game', '--tenant-key', '$where'],
    [...args, '--game-id', 'other'],
    [...args, '--tenant-null'],
    ['--game-id', 'unit-game', '--tenant-null', '--tenant-null'],
    [...args, '--uri', uri],
    [...args, '--projection', '{"phone":1}'],
    [...args, '--collection', 'other'],
    [...args, '--query', '{}'],
    [...args, '--from', '2099-01-01'],
    [...args, '--timeout-ms', '60000'],
    [...args, '--read-only'],
    [...args, 'mongodb://unit.invalid/games'],
    ['--game-id=unit-game', '--tenant-key', 'unit-tenant'],
    [...args.slice(0, 4), '--operation-id', 'not-a-uuid'],
    [...args.slice(0, 4), '--operation-id', '{"$exists":true}'],
    [...args.slice(0, 4), '--operation-id'],
  ])(
    'rejects malformed or broad selectors before env access and client construction: %j',
    async (...invalid) => {
      const output = io();
      expect(await runGameObservationCli(invalid, output)).toBe(2);
      expect(output.readUri).not.toHaveBeenCalled();
      expect(output.stdout).not.toHaveBeenCalled();
      expect(output.stderr).toHaveBeenCalledExactlyOnceWith(
        'LEGACY_GAME_OBSERVATION_CLI_SELECTOR_INVALID\n',
      );
      expect(state.events).toEqual([]);
    },
  );
  it.each([undefined, '', ' ', 'https://unit.invalid', 'inert-not-a-uri'])(
    'missing/invalid protected config never connects: %j',
    async (value) => {
      const output = io();
      output.readUri.mockReturnValue(value);
      expect(await runGameObservationCli(args, output)).toBe(2);
      expect(output.stdout).not.toHaveBeenCalled();
      expect(output.stderr).toHaveBeenCalledExactlyOnceWith(
        'LEGACY_GAME_OBSERVATION_CLI_CONFIG_UNAVAILABLE\n',
      );
      expect(state.events).toEqual([]);
    },
  );
  it('dispatches the exact selector through the existing observer and prints only its private projection', async () => {
    const output = io();
    expect(await runGameObservationCli(args, output)).toBe(0);
    const result = JSON.parse(output.stdout.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(result).toMatchObject({
      status: 'FOUND',
      source: 'games.lk_games',
      operation: { status: 'UNKNOWN', reason: 'LINK_UNPROVEN' },
      booking: 'UNKNOWN',
      benefit: 'UNKNOWN',
      settlement: 'UNKNOWN',
    });
    expect(output.stderr).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/UNIT_PRIVATE|unit-organizer|unit-player|mongodb/);
    expect(state.events.find((e) => e.kind === 'aggregate')?.value).toMatchObject({
      pipeline: [{ $match: { id: 'unit-game', tenantKey: 'unit-tenant' } }, { $limit: 2 }, {}],
      options: { maxTimeMS: 5000 },
    });
    expect(state.events.find((e) => e.kind === 'construct')?.value).toMatchObject({
      uri,
      options: {
        maxPoolSize: 1,
        retryReads: false,
        readPreference: 'primary',
        readConcern: { level: 'majority' },
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
        socketTimeoutMS: 5000,
      },
    });
    expect(state.events.at(-1)?.kind).toBe('close');
  });
  it('explicit null is BSON-null, not a tenant wildcard; omitted operation makes no ledger read', async () => {
    state.rows[0]!.tenantKey = null;
    const output = io();
    expect(await runGameObservationCli(['--game-id', 'unit-game', '--tenant-null'], output)).toBe(
      0,
    );
    expect(output.stdout.mock.calls[0]![0]).toContain('NOT_SELECTED');
    expect(state.events.find((e) => e.kind === 'aggregate')?.value).toMatchObject({
      pipeline: [{ $match: { id: 'unit-game', tenantKey: { $type: 10 } } }, { $limit: 2 }, {}],
    });
    expect(state.events.filter((e) => e.kind === 'collection')).toEqual([
      { kind: 'collection', value: 'lk_games' },
    ]);
  });
  it('dispatches only the explicitly selected and source-linked bridge operation', async () => {
    state.rows[0]!.legacyCommand = { lastOperationId: operationId };
    const output = io();
    expect(await runGameObservationCli(args, output)).toBe(0);
    expect(output.stdout.mock.calls[0]![0]).toContain('"status":"OBSERVED"');
    expect(state.events.find((e) => e.kind === 'find')?.value).toEqual({
      filter: { tenantKey: 'unit-tenant', legacyGameId: 'unit-game', operationId },
      options: {
        projection: { _id: 0, tenantKey: 1, legacyGameId: 1, operationId: 1, state: 1 },
        maxTimeMS: 5000,
      },
    });
    expect(state.events.find((e) => e.kind === 'limit')?.value).toBe(2);
    expect(state.events.at(-1)?.kind).toBe('close');
    expect(output.stdout.mock.calls[0]![0]).toContain('"settlement":"UNKNOWN"');
  });
  it.each(['construct', 'connect', 'read', 'close'])(
    'redacts driver errors and delegates finally without retry: %s',
    async (fail) => {
      state.fail = fail;
      const output = io();
      expect(await runGameObservationCli(args, output)).toBe(fail === 'close' ? 0 : 1);
      expect(JSON.stringify(output.stdout.mock.calls)).not.toMatch(
        /UNIT_PRIVATE|UNIT_PROVIDER|mongodb/,
      );
      expect(output.stderr).not.toHaveBeenCalled();
      expect(state.events.filter((e) => e.kind === 'construct')).toHaveLength(1);
      expect(state.events.filter((e) => e.kind === 'close')).toHaveLength(
        fail === 'construct' ? 0 : 1,
      );
    },
  );
  it('never prints a raw exception thrown while resolving the injected locator', async () => {
    const output = io();
    output.readUri.mockImplementation(() => {
      throw Error(`${uri} UNIT_PRIVATE_PHONE`);
    });
    expect(await runGameObservationCli(args, output)).toBe(1);
    expect(output.stdout).not.toHaveBeenCalled();
    expect(output.stderr).toHaveBeenCalledExactlyOnceWith(
      'LEGACY_GAME_OBSERVATION_CLI_UNAVAILABLE\n',
    );
    expect(state.events).toEqual([]);
  });
  it.each([
    ['NOT_FOUND', []],
    ['AMBIGUOUS', [{ id: 'unit-game' }, { id: 'unit-game' }]],
  ])('retains %s outcome instead of claiming financial absence', async (status, rows) => {
    state.rows = rows;
    const output = io();
    expect(await runGameObservationCli(args, output)).toBe(status === 'AMBIGUOUS' ? 1 : 0);
    expect(output.stdout.mock.calls[0]![0]).toContain(`"status":"${status}"`);
    expect(output.stdout.mock.calls[0]![0]).toContain('"settlement":"UNKNOWN"');
  });
  it('the actual node/tsx entrypoint fails closed without selectors or protected env', () => {
    const entry = resolve('packages/legacy-games-adapter/src/game-observation-cli.ts');
    for (const selected of [[], args]) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', entry, ...selected], {
        env: { PATH: process.env.PATH },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        selected.length
          ? 'LEGACY_GAME_OBSERVATION_CLI_CONFIG_UNAVAILABLE\n'
          : 'LEGACY_GAME_OBSERVATION_CLI_SELECTOR_INVALID\n',
      );
    }
  });
});
