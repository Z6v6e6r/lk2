import type { Pool } from 'pg';
import type * as VivaAdapter from '@phub/viva-adapter';
import type * as JoinConditions from './game-join-conditions.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGameJoinConditionsRuntime } from './game-join-conditions-runtime.js';
import { readGameJoinConditions, type GameJoinConditionsActor } from './game-join-conditions.js';

const harness = vi.hoisted(() => ({
  createRepository: vi.fn(),
  resolve: vi.fn(),
  createReader: vi.fn(),
  readOwned: vi.fn(),
  createPreview: vi.fn(),
  preview: vi.fn(),
}));
vi.mock('../../../../packages/database/src/game-join-conditions-context-repository.js', () => ({
  createGameJoinConditionsContextRepository: harness.createRepository,
}));
vi.mock('@phub/viva-adapter', async (original) => ({
  ...(await original<typeof VivaAdapter>()),
  createOwnedHubSubscriptionReader: harness.createReader,
}));
vi.mock('./game-join-conditions.js', async (original) => ({
  ...(await original<typeof JoinConditions>()),
  createLk1GamePricePreviewRead: harness.createPreview,
}));

type Config = Parameters<typeof createGameJoinConditionsRuntime>[0]['config'];
const config: Config = {
  GAMES_READ_ENABLED: true,
  VIVA_DIRECT_READ_ENABLED: true,
  VIVA_OAUTH_ENABLED: true,
  VIVA_MODE: 'production',
  VIVA_AUTH_TENANT_KEY: 'iSkq6G',
  VIVA_END_USER_API_URL: 'https://api.vivacrm.ru/end-user/api',
  LEGACY_GAMES_PUBLIC_BASE_URL: 'https://padlhub.su',
};
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor: GameJoinConditionsActor = {
  tenantKey: 'synthetic',
  correlationId: 'synthetic-runtime',
  tenantId: id(1),
  userId: id(2),
  sessionId: id(3),
  gameId: id(4),
  subscriptionInstanceId: id(5),
  expectedRevision: 8,
};
const context = {
  revision: 8,
  sourceVersion: 'synthetic-owner-version',
  providerTenantKey: 'iSkq6G',
  legacyGameId: 'pay_synthetic-existing-game',
  providerClientId: id(7),
  providerSubscriptionId: id(6),
  startsAt: '2099-09-21T07:00:00+03:00',
  durationMinutes: 90,
};
const connect = vi.fn();
const pool = { connect } as unknown as Pool;
const issueVivaAccessToken = vi.fn().mockResolvedValue({
  accessToken: 'synthetic-user-context',
  expiresAt: '2099-09-21T07:00:00Z',
  profilePhotoGrant: 'synthetic-unused-grant',
});
const build = (changes: Partial<Config> = {}) =>
  createGameJoinConditionsRuntime({
    config: { ...config, ...changes },
    pool,
    authService: { issueVivaAccessToken },
  });

beforeEach(() => {
  vi.clearAllMocks();
  harness.createRepository.mockReturnValue({ resolve: harness.resolve });
  harness.resolve.mockResolvedValue(context);
  harness.createReader.mockReturnValue(harness.readOwned);
  harness.readOwned.mockResolvedValue({ fingerprint: 'synthetic-proof' });
  harness.createPreview.mockReturnValue(harness.preview);
  harness.preview.mockImplementation(() =>
    Promise.resolve({
      quotes: [
        {
          subscriptionId: context.providerSubscriptionId,
          selectionKey: JSON.stringify([
            'EXISTING_GAME',
            context.legacyGameId,
            context.startsAt,
            90,
          ]),
          status: 'AVAILABLE',
          basePriceMinor: 300000,
          amountMinor: 70000,
          freeMinutes: 60,
          paidMinutes: 30,
          reasonCode: null,
          evaluatedAt: Date.now(),
          expiresAt: Date.now() + 30000,
        },
      ],
    }),
  );
  issueVivaAccessToken.mockResolvedValue({
    accessToken: 'synthetic-user-context',
    expiresAt: '2099-09-21T07:00:00Z',
    profilePhotoGrant: 'synthetic-unused-grant',
  });
});

describe('existing-game advisory runtime composition', () => {
  it.each([
    { GAMES_READ_ENABLED: false },
    { VIVA_DIRECT_READ_ENABLED: false },
    { VIVA_OAUTH_ENABLED: false },
    { VIVA_MODE: 'mock' },
    { VIVA_AUTH_TENANT_KEY: 'synthetic-other-tenant' },
  ] satisfies Partial<Config>[])('stays disabled when one required gate fails %#', (changes) => {
    expect(build(changes)).toBeUndefined();
    expect(harness.createRepository).not.toHaveBeenCalled();
    expect(harness.createReader).not.toHaveBeenCalled();
    expect(harness.createPreview).not.toHaveBeenCalled();
    expect(issueVivaAccessToken).not.toHaveBeenCalled();
  });

  for (const key of ['VIVA_END_USER_API_URL', 'LEGACY_GAMES_PUBLIC_BASE_URL'] as const) {
    const base = config[key];
    const withUser = new URL(base);
    withUser.username = 'synthetic';
    it.each([
      'https://untrusted.synthetic.invalid',
      `${base}/other`,
      `${base}?synthetic=1`,
      `${base}#synthetic`,
      base.replace('https:', 'http:'),
      base.replace('.ru', '.ru:8443').replace('.su', '.su:8443'),
      withUser.href,
    ])(`refuses an untrusted bearer destination in ${key}: %s`, (value) => {
      expect(build({ [key]: value })).toBeUndefined();
      expect(harness.createRepository).not.toHaveBeenCalled();
      expect(issueVivaAccessToken).not.toHaveBeenCalled();
    });
  }

  it.each(['sandbox', 'production'] as const)(
    'composes lazily for %s and exact trusted URLs',
    (mode) => {
      expect(
        build({
          VIVA_MODE: mode,
          VIVA_END_USER_API_URL: `${config.VIVA_END_USER_API_URL}/`,
          LEGACY_GAMES_PUBLIC_BASE_URL: `${config.LEGACY_GAMES_PUBLIC_BASE_URL}/`,
        }),
      ).toBeDefined();
      expect(harness.createRepository).toHaveBeenCalledWith(pool, 'iSkq6G');
      expect(harness.createReader).toHaveBeenCalledWith({
        apiBaseUrl: `${config.VIVA_END_USER_API_URL}/`,
        providerTenantKey: 'iSkq6G',
      });
      expect(harness.createPreview).toHaveBeenCalledWith(`${config.LEGACY_GAMES_PUBLIC_BASE_URL}/`);
      expect(connect).not.toHaveBeenCalled();
      expect(harness.resolve).not.toHaveBeenCalled();
      expect(harness.readOwned).not.toHaveBeenCalled();
      expect(harness.preview).not.toHaveBeenCalled();
      expect(issueVivaAccessToken).not.toHaveBeenCalled();
    },
  );

  it('refreshes once per advisory while re-reading context and ownership twice', async () => {
    const owner = build();
    if (!owner) throw new Error('expected synthetic runtime');
    expect(
      (await readGameJoinConditions(owner, actor, actor.correlationId)).price.amountMinor,
    ).toBe(70000);
    expect(issueVivaAccessToken).toHaveBeenCalledTimes(1);
    expect(issueVivaAccessToken).toHaveBeenCalledWith({
      tenantId: actor.tenantId,
      tenantKey: actor.tenantKey,
      userId: actor.userId,
      sessionId: actor.sessionId,
      correlationId: actor.correlationId,
    });
    expect(harness.resolve).toHaveBeenCalledTimes(2);
    expect(harness.readOwned).toHaveBeenCalledTimes(2);
    expect(harness.preview).toHaveBeenCalledTimes(1);
    await readGameJoinConditions(owner, actor, actor.correlationId);
    expect(issueVivaAccessToken).toHaveBeenCalledTimes(2);
  });

  it('does not repeat a failed broker promise within the same request or call providers', async () => {
    issueVivaAccessToken.mockRejectedValue(new Error('synthetic-token-refusal'));
    const owner = build();
    if (!owner) throw new Error('expected synthetic runtime');
    const signal = new AbortController().signal;
    await expect(owner.resolveSelection(actor, signal)).rejects.toThrow('synthetic-token-refusal');
    await expect(owner.resolveSelection(actor, signal)).rejects.toThrow('synthetic-token-refusal');
    expect(issueVivaAccessToken).toHaveBeenCalledTimes(1);
    expect(harness.readOwned).not.toHaveBeenCalled();
    expect(harness.preview).not.toHaveBeenCalled();
  });

  it('never shares a cached token with another actor on the same request signal', async () => {
    const owner = build();
    if (!owner) throw new Error('expected synthetic runtime');
    const signal = new AbortController().signal;
    await owner.resolveSelection(actor, signal);
    await expect(owner.resolveSelection({ ...actor, userId: id(20) }, signal)).rejects.toThrow(
      'JOIN_SELECTION_ACTOR_CHANGED',
    );
    expect(issueVivaAccessToken).toHaveBeenCalledTimes(1);
    expect(harness.readOwned).toHaveBeenCalledTimes(1);
  });

  it('refuses stale DB context before reaching the token broker', async () => {
    harness.resolve.mockResolvedValue({ ...context, revision: 9 });
    const owner = build();
    if (!owner) throw new Error('expected synthetic runtime');
    expect(await owner.resolveSelection(actor, new AbortController().signal)).toBeNull();
    expect(issueVivaAccessToken).not.toHaveBeenCalled();
    expect(harness.readOwned).not.toHaveBeenCalled();
  });
});
