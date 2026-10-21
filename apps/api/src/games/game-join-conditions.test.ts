import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, PadlHubApiClient } from '@phub/api-sdk';
import {
  createJoinConditionsFixture,
  evaluatePinnedLk1JoinFixture,
} from './game-join-conditions.test-fixture.js';
import { registerGameJoinConditionsRoutes } from './game-join-conditions-routes.js';
import {
  createLk1GamePricePreviewRead,
  readGameJoinConditions,
  type GameJoinConditionsActor,
  type GameJoinConditionsOwner,
  type Lk1GamePreviewSelection,
} from './game-join-conditions.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = Date.now();
const actor: GameJoinConditionsActor = {
  tenantKey: 'synthetic',
  correlationId: 'synthetic-correlation',
  tenantId: id(1),
  userId: id(2),
  sessionId: id(3),
  gameId: id(4),
  expectedRevision: 8,
  subscriptionInstanceId: id(5),
};
const selection: Lk1GamePreviewSelection = {
  ...actor,
  revision: 8,
  sourceVersion: 'synthetic-owner-snapshot-1',
  legacyGameId: 'pay_synthetic-existing-game',
  providerClientId: id(7),
  providerTenantKey: 'iSkq6G',
  legacySubscriptionId: id(6),
  startsAt: '2099-09-21T07:00:00+03:00',
  durationMinutes: 90,
  authorization: 'Bearer synthetic-user-context',
  providerMode: 'MOCK',
};
const quote = {
  subscriptionId: selection.legacySubscriptionId,
  selectionKey: JSON.stringify(['EXISTING_GAME', selection.legacyGameId, selection.startsAt, 90]),
  status: 'AVAILABLE',
  basePriceMinor: 300_000,
  amountMinor: 70_000,
  freeMinutes: 60,
  paidMinutes: 30,
  reasonCode: null,
  evaluatedAt: now,
  expiresAt: now + 30_000,
};
function owner(body: unknown = { quotes: [quote] }) {
  return {
    resolveSelection: vi
      .fn<GameJoinConditionsOwner['resolveSelection']>()
      .mockResolvedValue(selection),
    readPreview: vi.fn<GameJoinConditionsOwner['readPreview']>().mockResolvedValue(body),
  };
}
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('one owner-resolved existing JOIN advisory', () => {
  it('accepts MAX_SAFE_INTEGER revision and refuses overflow before owner work', async () => {
    const app = Fastify();
    apps.push(app);
    const current = owner();
    current.resolveSelection.mockImplementation((input) =>
      Promise.resolve({ ...selection, ...input, revision: input.expectedRevision }),
    );
    registerGameJoinConditionsRoutes(app, {
      owner: current,
      authenticatedTenantHandlers: [
        async (request) => {
          await Promise.resolve();
          request.tenantId = actor.tenantId;
          request.padlHubClaims = {
            sub: actor.userId,
            sid: actor.sessionId,
            tenants: [actor.tenantId],
            roles: ['client'],
            permissions: ['games.play'],
          };
        },
      ],
    });
    const prefix = `/user/api/v1/synthetic/games/${actor.gameId}/join-conditions?subscriptionInstanceId=${actor.subscriptionInstanceId}&expectedRevision=`;
    expect(
      (await app.inject({ method: 'GET', url: prefix + String(Number.MAX_SAFE_INTEGER) }))
        .statusCode,
    ).toBe(200);
    expect((await app.inject({ method: 'GET', url: prefix + '9007199254740992' })).statusCode).toBe(
      400,
    );
    expect(current.readPreview).toHaveBeenCalledTimes(1);
  });
  it('limits an authenticated principal before owner work even if the token changes', async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(rateLimit, { global: false });
    const current = owner();
    current.resolveSelection.mockImplementation((input) =>
      Promise.resolve({ ...selection, ...input }),
    );
    registerGameJoinConditionsRoutes(app, {
      owner: current,
      authenticatedTenantHandlers: [
        async (request) => {
          await Promise.resolve();
          request.tenantId = actor.tenantId;
          request.padlHubClaims = {
            sub: actor.userId,
            sid: actor.sessionId,
            tenants: [actor.tenantId],
            roles: ['client'],
            permissions: ['games.play'],
          };
        },
      ],
    });
    const url = `/user/api/v1/synthetic/games/${actor.gameId}/join-conditions?expectedRevision=8&subscriptionInstanceId=${actor.subscriptionInstanceId}`;
    for (let index = 0; index < 10; index += 1)
      expect(
        (
          await app.inject({
            method: 'GET',
            url,
            headers: { authorization: `Bearer synthetic-${index}` },
          })
        ).statusCode,
      ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url,
          headers: { authorization: 'Bearer synthetic-new-token' },
        })
      ).statusCode,
    ).toBe(429);
    expect(current.readPreview).toHaveBeenCalledTimes(10);
  });
  it('opens the advisory transport circuit after bounded failures without retrying', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('synthetic transport failure'));
    const read = createLk1GamePricePreviewRead('https://lk1.synthetic.invalid', transport);
    for (let index = 0; index < 3; index += 1)
      await expect(
        read(selection, new AbortController().signal, 'synthetic'),
      ).rejects.toBeDefined();
    await expect(read(selection, new AbortController().signal, 'synthetic')).rejects.toMatchObject({
      code: 'GAME_JOIN_CONDITIONS_CIRCUIT_OPEN',
    });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('cancels oversized and non-success owner response bodies', async () => {
    for (const status of [200, 503]) {
      const cancel = vi.fn();
      let chunks = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          chunks += 1;
          controller.enqueue(new Uint8Array(32769));
        },
        cancel,
      });
      const response = new Response(body, { status });
      const transport = vi.fn<typeof fetch>().mockResolvedValue(response);
      const preview = createLk1GamePricePreviewRead('https://lk1.synthetic.invalid', transport);
      await expect(
        preview(selection, new AbortController().signal, 'synthetic'),
      ).rejects.toBeDefined();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(chunks).toBeLessThanOrEqual(2);
    }
  });

  it('preserves owning amount, canonical IDs and truthful unconfirmed provenance', async () => {
    const result = await readGameJoinConditions(owner(), actor, 'synthetic-correlation', {
      now: () => now,
    });
    expect(result).toMatchObject({
      gameId: actor.gameId,
      revision: 8,
      ownerRevision: null,
      subscriptionInstanceId: actor.subscriptionInstanceId,
      eligibility: 'AVAILABLE',
      subscriptionApplied: true,
      providerMode: 'MOCK',
      price: { status: 'ADVISORY', amountMinor: 70_000, confirmed: false },
      freeMinutes: 60,
      paidMinutes: 30,
    });
    expect(JSON.stringify(result)).not.toContain(selection.legacyGameId);
    expect(JSON.stringify(result)).not.toContain(selection.legacySubscriptionId);
    expect(JSON.stringify(result)).not.toContain('Bearer');
  });
  it('preserves explicit denial and missing price without advertising zero', async () => {
    const result = await readGameJoinConditions(
      owner({
        quotes: [
          {
            ...quote,
            status: 'UNAVAILABLE',
            reasonCode: 'SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE',
            amountMinor: null,
            freeMinutes: 0,
            paidMinutes: 0,
          },
        ],
      }),
      actor,
      'synthetic-correlation',
      { now: () => now },
    );
    expect(result.price).toEqual({
      status: 'MISSING',
      amountMinor: null,
      currency: 'RUB',
      confirmed: false,
    });
    expect(result.subscriptionApplied).toBe(false);
    expect(result.reasonCode).toBe('SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE');
  });
  it('rejects an available quote with missing price; it never becomes zero', async () => {
    await expect(
      readGameJoinConditions(
        owner({ quotes: [{ ...quote, amountMinor: null }] }),
        actor,
        'synthetic-correlation',
        { now: () => now },
      ),
    ).rejects.toMatchObject({
      code: 'GAME_JOIN_CONDITIONS_RESPONSE_INVALID',
    });
  });
  it.each(['tenantId', 'userId', 'sessionId', 'gameId', 'subscriptionInstanceId'] as const)(
    'rejects a foreign %s before upstream reads',
    async (field) => {
      const current = owner();
      current.resolveSelection.mockResolvedValue({ ...selection, [field]: id(99) });
      await expect(
        readGameJoinConditions(current, actor, 'synthetic-correlation'),
      ).rejects.toMatchObject({
        code: 'GAME_JOIN_CONDITIONS_MAPPING_UNAVAILABLE',
      });
      expect(current.readPreview).not.toHaveBeenCalled();
    },
  );
  it('rejects absent/ambiguous owned selection before upstream reads', async () => {
    const current = owner();
    current.resolveSelection.mockResolvedValue(null);
    await expect(
      readGameJoinConditions(current, actor, 'synthetic-correlation'),
    ).rejects.toMatchObject({
      code: 'GAME_JOIN_CONDITIONS_MAPPING_UNAVAILABLE',
    });
    expect(current.readPreview).not.toHaveBeenCalled();
  });
  it.each([
    { ...quote, expiresAt: now - 1 },
    { ...quote, subscriptionId: id(99) },
    { ...quote, selectionKey: 'other' },
    { ...quote, amountMinor: -1 },
    { ...quote, expiresAt: now + 90_000 },
    { ...quote, evaluatedAt: now + 6000 },
    { ...quote, amountMinor: 0, status: 'UNAVAILABLE', reasonCode: 'SUBSCRIPTION_EXPIRED' },
  ])('rejects expired, mismatched or invalid owner quote %#', async (invalid) => {
    await expect(
      readGameJoinConditions(owner({ quotes: [invalid] }), actor, 'synthetic-correlation', {
        now: () => now,
      }),
    ).rejects.toMatchObject({ code: 'GAME_JOIN_CONDITIONS_RESPONSE_INVALID' });
  });
  it('rejects duplicate quote rows', async () => {
    await expect(
      readGameJoinConditions(owner({ quotes: [quote, quote] }), actor, 'synthetic-correlation', {
        now: () => now,
      }),
    ).rejects.toMatchObject({ code: 'GAME_JOIN_CONDITIONS_RESPONSE_INVALID' });
  });
  it('rejects revision or source-version drift during evaluation', async () => {
    for (const drift of [{ revision: 9 }, { sourceVersion: 'next-owner-snapshot' }]) {
      const current = owner();
      current.resolveSelection
        .mockResolvedValueOnce(selection)
        .mockResolvedValueOnce({ ...selection, ...drift });
      await expect(
        readGameJoinConditions(current, actor, 'synthetic-correlation', { now: () => now }),
      ).rejects.toMatchObject({ code: 'GAME_JOIN_CONDITIONS_REVISION_CHANGED', status: 409 });
    }
  });
  it('bounds the whole owner operation and aborts without retries', async () => {
    const current = owner();
    current.readPreview.mockImplementation(() => new Promise(() => {}));
    await expect(
      readGameJoinConditions(current, actor, 'synthetic-correlation', { timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: 'GAME_JOIN_CONDITIONS_TIMEOUT' });
    expect(current.readPreview).toHaveBeenCalledTimes(1);
    expect(current.readPreview.mock.calls[0]?.[1].aborted).toBe(true);
  });
  it('uses only the fixed existing advisory path and server selection', async () => {
    const capture = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ quotes: [quote] }));
    const read = createLk1GamePricePreviewRead('https://lk1.synthetic.invalid', capture);
    await read(selection, new AbortController().signal, 'synthetic-correlation');
    const [url, init] = capture.mock.calls[0]!;
    expect(url instanceof Request ? url.url : url instanceof URL ? url.href : url).toBe(
      'https://lk1.synthetic.invalid/lk/subscriptions/game-price-preview',
    );
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    expect(JSON.parse(init!.body as string)).toEqual({
      target: {
        targetKind: 'EXISTING_GAME',
        gameId: selection.legacyGameId,
        startsAt: selection.startsAt,
        durationMinutes: 90,
      },
      subscriptionIds: [selection.legacySubscriptionId],
    });
    expect(Object.keys(JSON.parse(init!.body as string) as object)).toEqual([
      'target',
      'subscriptionIds',
    ]);
  });
  it('runs actual loopback API -> SDK; absent dependency fails closed and caller price is rejected', async () => {
    const app = Fastify();
    apps.push(app);
    const current = owner();
    current.resolveSelection.mockImplementation((input) =>
      Promise.resolve({ ...selection, ...input }),
    );
    registerGameJoinConditionsRoutes(app, {
      owner: current,
      authenticatedTenantHandlers: [
        async (request) => {
          await Promise.resolve();
          request.tenantId = actor.tenantId;
          request.padlHubClaims = {
            sub: actor.userId,
            sid: actor.sessionId,
            tenants: [actor.tenantId],
            roles: ['client'],
            permissions: ['games.play'],
          };
        },
      ],
    });
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = new PadlHubApiClient({
      baseUrl: url,
      tenantKey: 'synthetic',
      platform: 'web',
      appVersion: 'synthetic',
      initialAccessToken: 'synthetic-local-access',
    });
    const result = await client.getGameJoinConditions(actor.gameId, actor);
    expect(result.price.amountMinor).toBe(70_000);
    expect(current.readPreview).toHaveBeenCalledTimes(1);
    const rejected = await app.inject({
      method: 'GET',
      url: `/user/api/v1/synthetic/games/${actor.gameId}/join-conditions?expectedRevision=8&subscriptionInstanceId=${actor.subscriptionInstanceId}&amountMinor=0`,
    });
    expect(rejected.statusCode).toBe(400);
    expect(current.readPreview).toHaveBeenCalledTimes(1);
    const disabled = Fastify();
    apps.push(disabled);
    registerGameJoinConditionsRoutes(disabled, {
      authenticatedTenantHandlers: [
        async (request) => {
          await Promise.resolve();
          request.tenantId = actor.tenantId;
          request.padlHubClaims = {
            sub: actor.userId,
            sid: actor.sessionId,
            tenants: [actor.tenantId],
            roles: ['client'],
            permissions: ['games.play'],
          };
        },
      ],
    });
    const response = await disabled.inject({
      method: 'GET',
      url: `/user/api/v1/synthetic/games/${actor.gameId}/join-conditions?expectedRevision=8&subscriptionInstanceId=${actor.subscriptionInstanceId}`,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ code: string }>().code).toBe('GAME_JOIN_CONDITIONS_DISABLED');
    expect(ApiClientError).toBeDefined();
  });
  const evaluatorPath = process.env.LK1_JOIN_EVALUATOR_SOURCE;
  it.runIf(evaluatorPath)(
    'uses the hash-pinned existing LK1 owner evaluator for the handed HUB variant',
    async () => {
      const decision = evaluatePinnedLk1JoinFixture(evaluatorPath!);
      expect(decision).toMatchObject({
        eligible: true,
        benefit: { finalPriceMinor: 70_000 },
        subscriptionVisitCount: 1,
      });
      const result = await readGameJoinConditions(
        createJoinConditionsFixture(decision.benefit.finalPriceMinor).owner,
        actor,
        'synthetic-source-correlation',
        { now: () => now },
      );
      expect(result.price.amountMinor).toBe(70_000);
      expect(result.providerMode).toBe('MOCK');
    },
  );
});
