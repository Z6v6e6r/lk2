import { readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import { expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { createGameJoinConditionsContextRepository } from '../../../../packages/database/src/game-join-conditions-context-repository.js';
import { createOwnedHubSubscriptionReader } from '../../../../packages/viva-adapter/src/game-subscription-selection.js';
import { createGameJoinConditionsOwner } from './game-join-conditions-owner.js';
import { createLk1GamePricePreviewRead } from './game-join-conditions.js';

export const fixtureId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const fixtureActor = {
  tenantId: fixtureId(1),
  userId: fixtureId(2),
  sessionId: fixtureId(3),
  gameId: fixtureId(4),
  subscriptionInstanceId: fixtureId(5),
};
export function createJoinConditionsFixture(amountMinor = 70_000, ttlMs = 30_000) {
  const raw = 'pay_synthetic_existing_game';
  const version = 'synthetic-owner-source-1';
  const alias = (id: string) => ({
    id,
    version,
    status: 'synced',
    error: null,
    syncedAt: '2026-10-07T10:00:00Z',
  });
  const row = {
    revision: 8,
    source_version: version,
    provider_tenant_key: 'iSkq6G',
    provider_client_id: fixtureId(7),
    provider_subscription_id: fixtureId(6),
    starts_at: '2099-09-21T04:00:00Z',
    ends_at: '2099-09-21T05:30:00Z',
    aliases: [
      alias(raw),
      alias(createHash('sha256').update(`phub-local-public-clone-v1:game:${raw}`).digest('hex')),
    ],
  };
  let subscription: Record<string, unknown> = {
    subscriptionId: fixtureId(6),
    productId: 'db7a5250-7369-4f43-8ac5-9111be24bc74',
    clientId: fixtureId(7),
    status: 'ACTIVE',
    variant: 'BY_VISITS',
    visitsLeft: 100,
    purchaseDate: '2026-09-05T06:40:26',
    activationDate: '2026-09-07T12:22:12',
    expirationDate: '2100-09-07',
  };
  let quotesOverride: unknown = null;
  let denial: string | null = null;
  let dbMissing = false;
  let dbTimeout = false;
  let profileId = fixtureId(7);
  let page: Record<string, unknown> = {
    totalElements: 1,
    number: 0,
    totalPages: 1,
    last: true,
    hasNext: false,
  };
  let duplicate = false;
  let afterPreview: (() => void) | undefined;
  const calls: { kind: string; path?: string; sql?: string; values?: readonly unknown[] }[] = [];
  const pool = {
    async connect() {
      await Promise.resolve();
      let open = true;
      return {
        async query(sql: string, values: readonly unknown[] = []) {
          await Promise.resolve();
          calls.push({ kind: 'SQL_READ', sql, values });
          if (sql.includes('select game.revision')) {
            if (dbTimeout)
              throw Object.assign(new Error('synthetic statement timeout'), { code: '57014' });
            const expected = [
              fixtureActor.tenantId,
              fixtureActor.userId,
              fixtureActor.sessionId,
              fixtureActor.gameId,
              fixtureActor.subscriptionInstanceId,
              'iSkq6G',
            ];
            return {
              rows:
                !dbMissing && values.every((value, index) => value === expected[index])
                  ? [structuredClone(row)]
                  : [],
            };
          }
          return { rows: [] };
        },
        release() {
          if (!open) throw new Error('double release');
          open = false;
        },
      };
    },
  } as unknown as Pool;
  const providerFetch: typeof fetch = async (url, init) => {
    await Promise.resolve();
    const path = new URL(url instanceof Request ? url.url : url instanceof URL ? url.href : url)
      .pathname;
    calls.push({ kind: String(init?.method), path });
    if (init?.method !== 'GET') throw new Error('provider writes prohibited');
    if (path.endsWith('/profile')) return Response.json({ id: profileId });
    if (path.endsWith('/subscriptions'))
      return Response.json({
        content: duplicate ? [subscription, subscription] : [subscription],
        ...page,
      });
    throw new Error('unknown provider path');
  };
  const previewFetch: typeof fetch = async (url, init) => {
    await Promise.resolve();
    const path = new URL(url instanceof Request ? url.url : url instanceof URL ? url.href : url)
      .pathname;
    calls.push({ kind: 'LK1_ADVISORY_READ', path });
    if (path !== '/lk/subscriptions/game-price-preview' || init?.method !== 'POST')
      throw new Error('business path prohibited');
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as {
      target: { gameId: string; startsAt: string; durationMinutes: number };
      subscriptionIds: string[];
    };
    const timestamp = Date.now();
    afterPreview?.();
    return Response.json(
      quotesOverride ?? {
        quotes: [
          {
            subscriptionId: body.subscriptionIds[0],
            selectionKey: JSON.stringify([
              'EXISTING_GAME',
              body.target.gameId,
              body.target.startsAt,
              body.target.durationMinutes,
            ]),
            status: denial ? 'UNAVAILABLE' : 'AVAILABLE',
            basePriceMinor: 300_000,
            amountMinor: denial ? null : amountMinor,
            freeMinutes: denial ? 0 : 60,
            paidMinutes: denial ? 0 : 30,
            reasonCode: denial,
            evaluatedAt: timestamp,
            expiresAt: timestamp + ttlMs,
          },
        ],
      },
    );
  };
  const owner = createGameJoinConditionsOwner({
    contextRepository: createGameJoinConditionsContextRepository(pool, 'iSkq6G'),
    getAccessToken: () => Promise.resolve('synthetic-user-context'),
    readOwnedSubscription: createOwnedHubSubscriptionReader({
      apiBaseUrl: 'https://viva.synthetic.invalid/end-user/api',
      providerTenantKey: 'iSkq6G',
      fetchImplementation: providerFetch,
    }),
    readPreview: createLk1GamePricePreviewRead('https://lk1.synthetic.invalid', previewFetch),
    providerMode: 'MOCK',
  });
  return {
    owner,
    calls,
    row,
    setDbTimeout() {
      dbTimeout = true;
    },
    setProfile(value: string) {
      profileId = value;
    },
    setPage(value: Record<string, unknown>) {
      page = value;
    },
    setDuplicate() {
      duplicate = true;
      page.totalElements = 2;
    },
    afterPreview(value: () => void) {
      afterPreview = value;
    },
    setSubscription(value: Record<string, unknown>) {
      subscription = { ...subscription, ...value };
    },
    setDenial(reason: string) {
      denial = reason;
    },
    setQuotes(value: unknown) {
      quotesOverride = value;
    },
    setDbMissing() {
      dbMissing = true;
    },
  };
}

export function evaluatePinnedLk1JoinFixture(path: string) {
  const source = readFileSync(path, 'utf8');
  expect(createHash('sha256').update(source).digest('hex')).toBe(
    '404fc3c087820bc28f794702ead9ddfba4eba62ca72c834729356441fc552243',
  );
  const product = 'db7a5250-7369-4f43-8ac5-9111be24bc74';
  const message = {
    _managedSubscriptionPolicyInput: {
      evaluatedAt: new Date().toISOString(),
      action: 'JOIN_GAME',
      lk1Policy: {
        maxActiveBookings: 8,
        freeGameMinutesPerDay: 60,
        gameOverageDiscountPercent: 30,
        groupTrainingDiscountPercent: 50,
        tournamentDiscountPercent: 50,
      },
      lk1ProductBinding: {
        policyProductId: product,
        ownedProductId: product,
        clientSubscriptionId: fixtureId(6),
      },
      target: {
        resolutionSource: 'SERVER',
        category: 'GAME',
        stationId: fixtureId(8),
        eventId: 'pay_synthetic_existing_game',
        externalEventTypeId: 4588,
        durationMinutes: 90,
        startsAt: '2099-09-21T07:00:00+03:00',
        basePriceMinor: 300_000,
        currency: 'RUB',
        priceSource: 'VIVA_EXISTING_TARIFF',
      },
      usage: {
        activeServiceScope: 'SUBSCRIPTION_BENEFIT_ONLY',
        dailyBucketLocalDate: '2099-09-21',
        activeServices: 0,
        usedOrReservedFreeMinutesToday: 0,
      },
    },
    _managedSubscriptionPolicyDecision: undefined as unknown,
  };
  const evaluate = compileFunction(source, ['msg']) as (msg: typeof message) => unknown;
  evaluate(message);
  const decision = message._managedSubscriptionPolicyDecision as {
    eligible: boolean;
    benefit: { finalPriceMinor: number };
    subscriptionVisitCount: number;
    gameMinutes: { freeMinutes: number; paidOverageMinutes: number };
  };

  return decision;
}
