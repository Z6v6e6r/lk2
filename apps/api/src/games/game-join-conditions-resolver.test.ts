import { describe, expect, it } from 'vitest';
import {
  createJoinConditionsFixture,
  fixtureActor,
  fixtureId,
} from './game-join-conditions.test-fixture.js';
import { readGameJoinConditions } from './game-join-conditions.js';

const actor = {
  ...fixtureActor,
  tenantKey: 'synthetic',
  correlationId: 'synthetic',
  expectedRevision: 8,
};
const read = (fixture: ReturnType<typeof createJoinConditionsFixture>, input = actor) =>
  readGameJoinConditions(fixture.owner, input, input.correlationId);

describe('production resolver with inert SQL and provider transports', () => {
  it('proves the existing Spring page contract without inventing number/hasNext fields', async () => {
    const fixture = createJoinConditionsFixture();
    fixture.setPage({ totalElements: 1, totalPages: 1, last: true });
    expect((await read(fixture)).price.amountMinor).toBe(70000);
  });
  it('refuses more than 1000 instances and inconsistent page counts', async () => {
    const many = createJoinConditionsFixture();
    many.setEntries(1001);
    await expect(read(many)).rejects.toMatchObject({
      code: 'JOIN_SELECTION_SUBSCRIPTIONS_INCOMPLETE',
    });
    const pages = createJoinConditionsFixture();
    pages.setPage({ totalElements: 1, totalPages: 0, last: true });
    await expect(read(pages)).rejects.toMatchObject({
      code: 'JOIN_SELECTION_SUBSCRIPTIONS_INCOMPLETE',
    });
  });

  it('sets a local query timeout and releases the read snapshot on timeout', async () => {
    const fixture = createJoinConditionsFixture();
    fixture.setDbTimeout();
    await expect(read(fixture)).rejects.toMatchObject({ code: '57014' });
    expect(
      fixture.calls.some((call) =>
        call.sql?.includes("set_config('statement_timeout', '1500ms', true)"),
      ),
    ).toBe(true);
    expect(fixture.calls.at(-1)?.sql).toBe('rollback');
  });
  it.each([
    {},
    { totalElements: 1, number: 0, totalPages: -1, last: true, hasNext: false },
    { totalElements: 2, number: 0, totalPages: 1, last: true, hasNext: false },
    { totalElements: 1, number: 0, totalPages: 2, last: false, hasNext: true },
  ])('refuses missing or incomplete pagination %#', async (page) => {
    const fixture = createJoinConditionsFixture();
    fixture.setPage(page);
    await expect(read(fixture)).rejects.toMatchObject({
      code: 'JOIN_SELECTION_SUBSCRIPTIONS_INCOMPLETE',
    });
    expect(fixture.calls.some((call) => call.kind === 'LK1_ADVISORY_READ')).toBe(false);
  });
  it('refuses duplicate provider instances and a foreign bearer profile', async () => {
    const duplicate = createJoinConditionsFixture();
    duplicate.setDuplicate();
    await expect(read(duplicate)).rejects.toBeDefined();
    const foreign = createJoinConditionsFixture();
    foreign.setProfile(fixtureId(99));
    await expect(read(foreign)).rejects.toMatchObject({ code: 'JOIN_SELECTION_FOREIGN_ACTOR' });
  });
  it('refuses activation later the same Moscow day and microsecond widening', async () => {
    const future = createJoinConditionsFixture();
    future.setSubscription({ activationDate: new Date(Date.now() + 60_000).toISOString() });
    await expect(read(future)).rejects.toMatchObject({
      code: 'JOIN_SELECTION_VARIANT_UNAVAILABLE',
    });
    const now = Date.now();
    const micro = createJoinConditionsFixture();
    micro.setSubscription({
      activationDate: new Date(now + 60_000).toISOString().replace('Z', '001Z'),
    });
    await expect(read(micro)).rejects.toMatchObject({ code: 'JOIN_SELECTION_VARIANT_UNAVAILABLE' });
  });
  it('refuses actual production context and owned-record drift after price preview', async () => {
    const game = createJoinConditionsFixture();
    game.afterPreview(() => {
      game.row.revision = 9;
    });
    await expect(read(game)).rejects.toMatchObject({
      code: 'GAME_JOIN_CONDITIONS_REVISION_CHANGED',
    });
    const subscription = createJoinConditionsFixture();
    subscription.afterPreview(() => subscription.setSubscription({ visitsLeft: 99 }));
    await expect(read(subscription)).rejects.toMatchObject({
      code: 'GAME_JOIN_CONDITIONS_REVISION_CHANGED',
    });
  });

  it('resolves raw/hash pair and uniquely owned annual instance before and after evaluation', async () => {
    const fixture = createJoinConditionsFixture();
    const result = await read(fixture);
    expect(result).toMatchObject({
      price: { amountMinor: 70000, confirmed: false },
      providerMode: 'MOCK',
      revision: 8,
    });
    expect(fixture.calls.filter((call) => call.kind === 'GET')).toHaveLength(4);
    expect(fixture.calls.filter((call) => call.kind === 'LK1_ADVISORY_READ')).toHaveLength(1);
    const sql = fixture.calls.filter((call) => call.kind === 'SQL_READ');
    expect(sql.map((call) => call.sql).filter((sql) => sql === 'begin read only')).toHaveLength(2);
    expect(sql.map((call) => call.sql).filter((sql) => sql === 'rollback')).toHaveLength(2);
    expect(sql.every((call) => !/insert|update|delete/i.test(call.sql!))).toBe(true);
    expect(
      fixture.calls
        .filter((call) => call.kind === 'GET')
        .every((call) => call.path?.startsWith('/end-user/api/v1/iSkq6G/')),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain('pay_synthetic');
    expect(JSON.stringify(result)).not.toContain(fixtureId(6));
  });
  it.each(['tenantId', 'userId', 'sessionId', 'gameId', 'subscriptionInstanceId'] as const)(
    'refuses foreign %s without provider reads',
    async (field) => {
      const fixture = createJoinConditionsFixture();
      await expect(read(fixture, { ...actor, [field]: fixtureId(99) })).rejects.toMatchObject({
        code: 'GAME_JOIN_CONDITIONS_MAPPING_UNAVAILABLE',
      });
      expect(fixture.calls.every((call) => call.kind === 'SQL_READ')).toBe(true);
    },
  );
  it.each(['extra', 'hash', 'version', 'sync'] as const)(
    'refuses ambiguous or stale alias %s',
    async (kind) => {
      const fixture = createJoinConditionsFixture();
      if (kind === 'extra')
        fixture.row.aliases.push({ ...fixture.row.aliases[0]!, id: 'pay_other' });
      if (kind === 'hash') fixture.row.aliases[1]!.id = 'a'.repeat(64);
      if (kind === 'version') fixture.row.aliases[0]!.version = 'old';
      if (kind === 'sync') fixture.row.aliases[0]!.status = 'pending';
      await expect(read(fixture)).rejects.toMatchObject({
        code: 'GAME_JOIN_CONDITIONS_MAPPING_UNAVAILABLE',
      });
      expect(fixture.calls.every((call) => call.kind === 'SQL_READ')).toBe(true);
    },
  );
  it.each([
    { clientId: fixtureId(99) },
    { productId: fixtureId(99) },
    { templateId: fixtureId(99) },
    { purchaseDate: '2026-08-31' },
    { purchaseAt: '2026-09-06' },
    { purchaseDate: 'invalid' },
    { visitsLeft: 0 },
    { status: 'FINISHED' },
    { variant: 'UNLIMITED' },
    { isFrozen: true },
    { expirationDate: '2099-09-20' },
    { clientSubscriptionId: fixtureId(99) },
  ])(
    'refuses foreign, ambiguous or ineligible subscription %# before price read',
    async (value) => {
      const fixture = createJoinConditionsFixture();
      fixture.setSubscription(value);
      await expect(read(fixture)).rejects.toBeDefined();
      expect(fixture.calls.some((call) => call.kind === 'LK1_ADVISORY_READ')).toBe(false);
    },
  );
  it('matches Moscow purchase-date boundary and rejects invalid calendar days', async () => {
    const fixture = createJoinConditionsFixture();
    fixture.setSubscription({
      purchaseDate: '2026-08-31T21:10:00Z',
      purchaseAt: '2026-09-01T00:10:00+03:00',
    });
    expect((await read(fixture)).price.amountMinor).toBe(70000);
    const invalid = createJoinConditionsFixture();
    invalid.setSubscription({ purchaseDate: '2026-09-31' });
    await expect(read(invalid)).rejects.toBeDefined();
  });
});
