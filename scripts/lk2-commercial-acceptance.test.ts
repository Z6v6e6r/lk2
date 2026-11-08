import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runAcceptance } from './lk2-commercial-acceptance.js';

const STATION = '11111111-1111-4111-8111-000000000001';
const COURT = '11111111-1111-4111-8111-000000000002';
const ORG_SUB = '11111111-1111-4111-8111-000000000003';
const JOIN_SUB = '11111111-1111-4111-8111-000000000004';
const GAME = '11111111-1111-4111-8111-000000000005';
const OPERATION = '11111111-1111-4111-8111-000000000006';
const NOW = Date.parse('2030-01-01T09:00:00.000Z');
const STARTS_AT = '2030-01-02T12:00:00.000Z';

interface Call {
  method: string;
  path: string;
  key?: string;
  body?: unknown;
  token: string | undefined;
}

function harness(overrides: Partial<Record<string, (call: Call) => unknown>> = {}) {
  const calls: Call[] = [];
  const units = { org: 4, join: 3 };
  let quarterStatus = 'PENDING';
  let joinStatus: string | null = null;
  const routes: Record<string, (call: Call) => unknown> = {
    'GET /game-create-operations/capability': () => [200, { contractVersion: 1, available: true }],
    'GET /game-create-operations/locations': () => [
      200,
      {
        items: [{ stationId: STATION, courtId: COURT, stationTitle: 'Club', courtName: 'Court 1' }],
      },
    ],
    'GET /home': (c) => [
      200,
      {
        subscriptions: [
          c.token === 'org'
            ? { id: ORG_SUB, title: 'Org', status: 'active', remainingUnits: units.org }
            : { id: JOIN_SUB, title: 'Join', status: 'active', remainingUnits: units.join },
        ],
      },
    ],
    'GET /game-create-operations/by-key': (c) => {
      if (quarterStatus === 'PENDING' && !calls.some((x) => x.method === 'POST'))
        return [404, { code: 'NOT_FOUND' }];
      if (quarterStatus === 'PENDING') {
        quarterStatus = 'CONFIRMED';
        units.org -= 1;
      }
      return [200, quarterView(c.key!, quarterStatus)];
    },
    'POST /game-create-operations': (c) => [202, quarterView(c.key!, 'PENDING')],
    [`GET /games/${GAME}`]: (c) => [
      200,
      {
        game: {
          id: GAME,
          revision: 3,
          startsAt: STARTS_AT,
          endsAt: '2030-01-02T13:00:00.000Z',
          viewerRelation:
            c.token === 'org' ? 'ORGANIZER' : joinStatus === 'SUCCEEDED' ? 'PARTICIPANT' : 'NONE',
        },
      },
    ],
    [`GET /games/${GAME}/join-conditions`]: () => [
      200,
      {
        gameId: GAME,
        subscriptionInstanceId: JOIN_SUB,
        eligibility: 'AVAILABLE',
        subscriptionApplied: true,
        requiresPriceConsent: false,
        freeMinutes: 60,
        paidMinutes: 0,
        price: { amountMinor: 0 },
      },
    ],
    [`GET /games/${GAME}/join-operation`]: () => {
      if (!joinStatus) return [404, { code: 'GAME_OPERATION_NOT_FOUND' }];
      if (joinStatus === 'PROCESSING') {
        joinStatus = 'SUCCEEDED';
        units.join -= 1;
      }
      return [200, joinView(joinStatus)];
    },
    [`POST /games/${GAME}/join`]: () => {
      joinStatus = 'PROCESSING';
      return [202, joinView('PROCESSING')];
    },
    ...overrides,
  };
  const fetchImpl = async (url: string, init: RequestInit) => {
    await Promise.resolve();
    const u = new URL(url);
    const path = u.pathname.replace('/user/api/v1/local-padel', '');
    const headers = init.headers as Record<string, string>;
    const call: Call = {
      method: init.method!,
      path,
      ...(headers['Idempotency-Key'] ? { key: headers['Idempotency-Key'] } : {}),
      ...(init.body ? { body: JSON.parse(init.body as string) } : {}),
      token: headers.Authorization?.replace('Bearer ', ''),
    };
    calls.push(call);
    const route = routes[`${call.method} ${path}`];
    const [status, json] = (route ? route(call) : [599, { unrouted: path }]) as [number, unknown];
    return new Response(JSON.stringify(json), { status });
  };
  let clock = NOW;
  let state: Record<string, unknown> = {};
  const logs: string[] = [];
  const run = (argv: string[], env: Record<string, string> = {}) =>
    runAcceptance({
      env: {
        PHUB_ORGANIZER_TOKEN: 'org',
        PHUB_JOINER_TOKEN: 'joiner',
        PHUB_ORGANIZER_SUBSCRIPTION_ID: ORG_SUB,
        PHUB_JOINER_SUBSCRIPTION_ID: JOIN_SUB,
        PHUB_QUARTER_STATION_ID: STATION,
        PHUB_QUARTER_COURT_ID: COURT,
        PHUB_QUARTER_STARTS_AT: STARTS_AT,
        LK2_ACCEPTANCE_WAIT_MS: '60000',
        ...env,
      },
      argv,
      fetchImpl,
      log: (line: string) => logs.push(line),
      sleep: async (ms: number) => {
        await Promise.resolve();
        clock += ms;
      },
      now: () => clock,
      stateStore: {
        load: () => structuredClone(state),
        save: (next: Record<string, unknown>) => {
          state = structuredClone(next);
        },
      },
    });
  return { calls, run, logs, units, getState: () => state };
}

function quarterView(key: string, status: string) {
  return {
    contractVersion: 1,
    request: { stationId: STATION, courtId: COURT, startsAt: STARTS_AT, subscriptionId: ORG_SUB },
    keySha256: createHash('sha256').update(key).digest('hex'),
    operation: { id: OPERATION, draftId: OPERATION, status },
    gameProjection:
      status === 'CONFIRMED'
        ? { status: 'AVAILABLE', gameId: GAME }
        : { status: 'PENDING', gameId: null },
    registration:
      status === 'CONFIRMED'
        ? { status: 'CONFIRMED', asOf: STARTS_AT }
        : { status: 'UNKNOWN', asOf: null },
    reason: null,
  };
}

function joinView(status: string) {
  return {
    operation: {
      id: OPERATION,
      type: 'JOIN_GAME',
      status,
      gameId: GAME,
      commercial: {
        attemptState: status === 'SUCCEEDED' ? 'OWNER_CONFIRMED' : 'OWNER_PENDING',
        receipt: status === 'SUCCEEDED' ? { provider: 'VIVA', status: 'CONFIRMED' } : null,
        reason: null,
      },
    },
  };
}

const statuses = (results: { name: string; status: string }[]) =>
  Object.fromEntries(results.map((r) => [r.name, r.status]));

describe('lk2 commercial acceptance', () => {
  it('refuses any host outside the LK2 contours before a request', async () => {
    const h = harness();
    const out = await h.run([], { PHUB_API_BASE_URL: 'https://padlhub.su' });
    expect(out.failed).toBe(1);
    expect(h.calls).toHaveLength(0);
  });

  it('is read-only by default and checks capability, courts and subscriptions', async () => {
    const h = harness();
    const out = await h.run([], { PHUB_JOIN_GAME_ID: GAME });
    expect(out.failed).toBe(0);
    expect(h.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(statuses(out.results)).toMatchObject({
      'quarter CREATE capability is available': 'PASS',
      'selected court is offered by the owner': 'PASS',
      'organizer subscription is active with remaining units': 'PASS',
      'joiner subscription is active with remaining units': 'PASS',
      'join conditions apply the joiner subscription': 'PASS',
    });
  });

  it('never writes when the capability is closed', async () => {
    const h = harness({
      'GET /game-create-operations/capability': () => [
        200,
        { contractVersion: 1, available: false },
      ],
    });
    const out = await h.run(['--create']);
    expect(out.failed).toBeGreaterThan(0);
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('refuses a non-minute or past start before any write', async () => {
    for (const startsAt of ['2030-01-02T12:00:30.000Z', '2029-12-31T12:00:00.000Z']) {
      const h = harness();
      const out = await h.run(['--create'], { PHUB_QUARTER_STARTS_AT: startsAt });
      expect(statuses(out.results)['CREATE target is explicit']).toBe('FAIL');
      expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
    }
  });

  it('CREATE60 then JOIN60: one key per operation, result returns to the original operation', async () => {
    const h = harness();
    const out = await h.run(['--create', '--join']);
    expect(out.failed).toBe(0);
    expect(statuses(out.results)).toMatchObject({
      'CREATE operation is confirmed by the owner': 'PASS',
      'CREATE result belongs to the original operation': 'PASS',
      'created game is a 60-minute game organized by this user': 'PASS',
      'organizer visit written off once': 'PASS',
      'JOIN operation succeeded with a provider receipt': 'PASS',
      'joiner is a participant': 'PASS',
      'joiner visit written off once': 'PASS',
    });
    const createPosts = h.calls.filter(
      (c) => c.method === 'POST' && c.path === '/game-create-operations',
    );
    expect(createPosts).toHaveLength(1);
    expect(createPosts[0]!.body).toEqual({
      stationId: STATION,
      courtId: COURT,
      startsAt: STARTS_AT,
      subscriptionId: ORG_SUB,
    });
    const createKeys = new Set(
      h.calls
        .filter((c) => c.path.startsWith('/game-create-operations') && c.key)
        .map((c) => c.key),
    );
    expect(createKeys.size).toBe(1);
    const joinPost = h.calls.filter((c) => c.method === 'POST' && c.path === `/games/${GAME}/join`);
    expect(joinPost).toHaveLength(1);
    expect(joinPost[0]!.body).toEqual({ expectedRevision: 3, subscriptionInstanceId: JOIN_SUB });
    expect(joinPost[0]!.token).toBe('joiner');
  });

  it('a rerun after a lost response reads the saved operation and does not POST again', async () => {
    const h = harness();
    await h.run(['--create']);
    const before = h.calls.filter((c) => c.method === 'POST').length;
    const out = await h.run(['--create']);
    expect(h.calls.filter((c) => c.method === 'POST').length).toBe(before);
    expect(statuses(out.results)['CREATE operation is confirmed by the owner']).toBe('PASS');
  });

  it('an UNKNOWN create is reconciled with the same key and body, never re-created', async () => {
    let reads = 0;
    const h = harness({
      'POST /game-create-operations': (c) => [202, quarterView(c.key!, 'UNKNOWN')],
      'GET /game-create-operations/by-key': (c) => {
        reads += 1;
        return reads === 1 ? [404, {}] : [200, quarterView(c.key!, 'UNKNOWN')];
      },
      [`POST /game-create-operations/${OPERATION}/reconcile`]: (c) => [
        200,
        quarterView(c.key!, 'CONFIRMED'),
      ],
    });
    const out = await h.run(['--create']);
    const posts = h.calls.filter((c) => c.method === 'POST');
    expect(posts.map((p) => p.path)).toEqual([
      '/game-create-operations',
      `/game-create-operations/${OPERATION}/reconcile`,
    ]);
    expect(posts[1]!.key).toBe(posts[0]!.key);
    expect(posts[1]!.body).toEqual(posts[0]!.body);
    expect(statuses(out.results)['CREATE operation is confirmed by the owner']).toBe('PASS');
  });

  it('a refused create fails without polling', async () => {
    const h = harness({
      'POST /game-create-operations': () => [409, { code: 'GAME_QUARTER_CREATE_IDENTITY_CHANGED' }],
    });
    const out = await h.run(['--create']);
    expect(statuses(out.results)['CREATE accepted by the API']).toBe('FAIL');
    expect(h.calls.filter((c) => c.path === '/game-create-operations/by-key')).toHaveLength(1);
  });

  it('JOIN stops when the owner asks for a price consent', async () => {
    const h = harness({
      [`GET /games/${GAME}/join-conditions`]: () => [
        200,
        {
          subscriptionInstanceId: JOIN_SUB,
          eligibility: 'AVAILABLE',
          subscriptionApplied: true,
          requiresPriceConsent: true,
        },
      ],
    });
    const out = await h.run(['--join'], { PHUB_JOIN_GAME_ID: GAME });
    expect(statuses(out.results)['JOIN needs no surcharge']).toBe('FAIL');
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('refuses the same token for organizer and joiner', async () => {
    const h = harness();
    const out = await h.run([], { PHUB_JOINER_TOKEN: 'org' });
    expect(out.failed).toBe(1);
    expect(h.calls).toHaveLength(0);
  });
});
