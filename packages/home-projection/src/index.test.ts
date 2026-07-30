import { describe, expect, it } from 'vitest';

import {
  buildHomeBase,
  buildHomeProjection,
  HOME_COMMUNITY_SUMMARY_LIMIT,
  HOME_PROJECTION_COMPONENT_EVENT,
  homeBaseSchema,
  homeDashboardSchema,
  homeProjectionEventSchema,
  homeProjectionComponentPayloadSchema,
  normalizeHomeDashboardPayload,
  normalizeHomeBaseFreshness,
  normalizeHomeProjectionComponentPayload,
  type HomeProjectionComponentPayload,
} from './index.js';

const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const homeCommunities = Array.from({ length: HOME_COMMUNITY_SUMMARY_LIMIT + 1 }, (_, index) => {
  const suffix = String(index + 1).padStart(12, '0');
  const id = `10000000-0000-4000-8000-${suffix}`;
  return {
    id,
    title: `Сообщество ${index + 1}`,
    logoUrl: null,
    isVerified: index % 2 === 0,
    unreadChatCount: index,
    route: `/communities/${id}`,
  };
});

const components: readonly HomeProjectionComponentPayload[] = [
  {
    userId,
    component: 'profile',
    componentRevision: '4',
    value: {
      userId,
      displayName: 'Алексей Петров',
      firstName: 'Алексей',
      lastName: 'Петров',
      avatarUrl: null,
      phoneLast4: '3190',
      balanceMinor: 245_000,
      currency: 'RUB',
      level: { label: 'C+', value: 3.8, assessmentRequired: false },
    },
  },
  {
    userId,
    component: 'messaging',
    componentRevision: '7',
    value: { unreadChats: 3 },
  },
  {
    userId,
    component: 'upcoming',
    componentRevision: '12',
    value: [
      {
        id: '751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
        kind: 'game',
        title: 'Игра',
        startsAt: '2026-07-16T12:00:00.000Z',
        venue: 'ПаделХАБ',
        status: 'confirmed',
        route: '/games/751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
      },
    ],
  },
  {
    userId,
    component: 'subscriptions',
    componentRevision: '2',
    value: [
      {
        id: '24793a5a-0931-4a76-8600-267015be0ac9',
        title: 'Клубная',
        status: 'active',
        remainingUnits: 8,
        validUntil: '2026-09-01T00:00:00.000Z',
        route: '/subscriptions/24793a5a-0931-4a76-8600-267015be0ac9',
      },
    ],
  },
  { userId, component: 'communities', componentRevision: '1', value: [] },
  {
    userId,
    component: 'promotion',
    componentRevision: '3',
    value: { rotationEnabled: false, intervalSeconds: 6, items: [] },
  },
  { userId, component: 'locations', componentRevision: '1', value: [] },
  {
    userId,
    component: 'navigation',
    componentRevision: '1',
    value: {
      quickActions: [{ id: 'play', title: 'Игры', route: '/games', tone: 'violet' }],
      additionalLinks: [{ id: 'promotions', title: 'Все акции', route: '/promotions' }],
    },
  },
  {
    userId,
    component: 'capabilities',
    componentRevision: '5',
    value: {
      canCreateGame: true,
      canManageTournaments: false,
      canViewCommunities: true,
    },
  },
];

describe('Home projection contract and builder', () => {
  it('keeps the partial Home base explicit and excludes unavailable Viva aggregates', () => {
    const parsed = homeBaseSchema.parse({
      snapshot: {
        version: 'home-base-v1-1',
        generatedAt: '2026-07-15T12:00:00.000Z',
        source: 'LOCAL_PROJECTION',
        completeness: 'PARTIAL',
      },
      viewerUserId: userId,
      quickActions: [],
      communities: {
        status: 'READY',
        revision: '3',
        observedAt: '2026-07-15T11:59:00.000Z',
        staleAt: '2026-07-15T12:04:00.000Z',
        value: [],
      },
      promotions: { status: 'UNAVAILABLE' },
      locations: [],
      additionalLinks: [],
      capabilities: {
        canCreateGame: true,
        canManageTournaments: false,
        canViewCommunities: true,
      },
    });

    expect(parsed.snapshot.completeness).toBe('PARTIAL');
    expect(parsed).not.toHaveProperty('profile');
    expect(parsed).not.toHaveProperty('upcoming');
    expect(parsed).not.toHaveProperty('subscriptions');
    expect(parsed).not.toHaveProperty('counters');
  });

  it('keeps ten community summaries in Home and rejects an eleventh', () => {
    const component = {
      userId,
      component: 'communities' as const,
      componentRevision: '9',
    };
    expect(
      homeProjectionComponentPayloadSchema.safeParse({
        ...component,
        value: homeCommunities.slice(0, HOME_COMMUNITY_SUMMARY_LIMIT),
      }).success,
    ).toBe(true);
    expect(
      homeProjectionComponentPayloadSchema.safeParse({
        ...component,
        value: homeCommunities,
      }).success,
    ).toBe(false);

    const homeBase = buildHomeBase({
      viewerUserId: userId,
      sourceRevision: '10',
      generatedAt: new Date('2026-07-15T12:00:00.000Z'),
      ttlSeconds: 300,
      quickActions: [],
      locations: [],
      additionalLinks: [],
      capabilities: {
        canCreateGame: true,
        canManageTournaments: false,
        canViewCommunities: true,
      },
      communities: {
        revision: '9',
        observedAt: new Date('2026-07-15T11:59:00.000Z'),
        value: homeCommunities.slice(0, HOME_COMMUNITY_SUMMARY_LIMIT),
      },
    });
    expect(homeBase.communities).toMatchObject({
      status: 'READY',
      value: homeCommunities.slice(0, HOME_COMMUNITY_SUMMARY_LIMIT),
    });
    expect(() =>
      buildHomeBase({
        viewerUserId: userId,
        sourceRevision: '11',
        generatedAt: new Date('2026-07-15T12:00:00.000Z'),
        ttlSeconds: 300,
        quickActions: [],
        locations: [],
        additionalLinks: [],
        capabilities: {
          canCreateGame: true,
          canManageTournaments: false,
          canViewCommunities: true,
        },
        communities: {
          revision: '10',
          observedAt: new Date('2026-07-15T11:59:00.000Z'),
          value: homeCommunities,
        },
      }),
    ).toThrow();
  });

  it('keeps optional HomeBase freshness bound to its source observation', () => {
    const homeBase = buildHomeBase({
      viewerUserId: userId,
      sourceRevision: '8',
      generatedAt: new Date('2026-07-15T12:00:00.000Z'),
      ttlSeconds: 300,
      quickActions: [],
      locations: [],
      additionalLinks: [],
      capabilities: {
        canCreateGame: true,
        canManageTournaments: false,
        canViewCommunities: true,
      },
      communities: {
        revision: '3',
        observedAt: new Date('2026-07-15T11:59:00.000Z'),
        value: [],
      },
    });

    expect(homeBase.communities).toMatchObject({
      status: 'READY',
      revision: '3',
      observedAt: '2026-07-15T11:59:00.000Z',
      staleAt: '2026-07-15T12:04:00.000Z',
    });
    expect(
      normalizeHomeBaseFreshness(homeBase, new Date('2026-07-15T12:05:00.000Z'), 300).communities,
    ).toMatchObject({ status: 'STALE', revision: '3' });
    expect(
      normalizeHomeBaseFreshness(homeBase, new Date('2026-07-15T12:10:00.000Z'), 300).communities,
    ).toEqual({ status: 'UNAVAILABLE' });
  });

  it('waits until every server-owned component is present', () => {
    expect(
      buildHomeProjection({
        components: components.filter((component) => component.component !== 'subscriptions'),
        sourceRevision: '1',
        generatedAt: new Date('2026-07-15T12:00:00.000Z'),
        ttlSeconds: 300,
      }),
    ).toEqual({ ready: false, missing: ['subscriptions'] });
  });

  it('builds one complete projection and derives bounded counters', () => {
    const result = buildHomeProjection({
      components,
      sourceRevision: '9',
      generatedAt: new Date('2026-07-15T12:00:00.000Z'),
      ttlSeconds: 300,
    });

    expect(result).toMatchObject({
      ready: true,
      dashboard: {
        snapshot: {
          version: 'home-v1-9',
          source: 'LOCAL_PROJECTION',
          staleAt: '2026-07-15T12:05:00.000Z',
        },
        counters: { unreadChats: 3, upcomingEvents: 1, activeSubscriptions: 1 },
        promotion: null,
        promotions: { rotationEnabled: false, intervalSeconds: 6, items: [] },
      },
    });
  });

  it('rejects an event whose aggregate does not match the PadlHub user', () => {
    const parsed = homeProjectionEventSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      type: HOME_PROJECTION_COMPONENT_EVENT,
      aggregateId: '22222222-2222-4222-8222-222222222222',
      tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
      occurredAt: '2026-07-15T12:00:00.000Z',
      correlationId: 'home-projector-test',
      payload: components[0],
    });

    expect(parsed.success).toBe(false);
  });

  it('reads persisted legacy community summaries during the expand/migrate rollout', () => {
    const legacyCommunity = {
      id: '42c05c91-da23-4dc5-bf97-3d136a2d12bd',
      title: 'Старое сообщество',
      description: 'Поле старого контракта',
      memberCount: 124,
      role: 'member',
      unreadCount: 2,
      accent: '#B9A1FF',
      route: '/communities/42c05c91-da23-4dc5-bf97-3d136a2d12bd',
    };
    const dashboard = buildHomeProjection({
      components,
      sourceRevision: '10',
      generatedAt: new Date('2026-07-15T12:00:00.000Z'),
      ttlSeconds: 300,
    });
    expect(dashboard.ready).toBe(true);
    if (!dashboard.ready) return;

    const normalizedDashboard = homeDashboardSchema.parse(
      normalizeHomeDashboardPayload({ ...dashboard.dashboard, communities: [legacyCommunity] }),
    );
    expect(normalizedDashboard.communities).toEqual([
      {
        id: legacyCommunity.id,
        title: legacyCommunity.title,
        logoUrl: null,
        isVerified: false,
        unreadChatCount: 2,
        route: legacyCommunity.route,
      },
    ]);

    const normalizedComponent = homeProjectionComponentPayloadSchema.parse(
      normalizeHomeProjectionComponentPayload({
        userId,
        component: 'communities',
        componentRevision: '1',
        value: [legacyCommunity],
      }),
    );
    expect(normalizedComponent.value).toEqual(normalizedDashboard.communities);
  });

  it('expands an older single promotion into a non-rotating deck', () => {
    const legacyPromotion = {
      id: '391e45be-5941-4668-81bc-b2ce1d73b200',
      eyebrow: 'Акция',
      title: 'Летняя акция',
      description: 'Старый одиночный баннер.',
      actionLabel: 'Подробнее',
      route: '/promotions/summer',
      tone: 'lime',
      imageUrl: null,
    };
    const normalizedComponent = homeProjectionComponentPayloadSchema.parse(
      normalizeHomeProjectionComponentPayload({
        userId,
        component: 'promotion',
        componentRevision: '3',
        value: legacyPromotion,
      }),
    );
    expect(normalizedComponent.value).toEqual({
      hero: { rotationEnabled: false, intervalSeconds: 6, items: [legacyPromotion] },
      standard: { rotationEnabled: false, intervalSeconds: 6, items: [legacyPromotion] },
    });
  });

  it('adds only the confirmed viewer to a legacy upcoming item without a roster', () => {
    const result = buildHomeProjection({
      components,
      sourceRevision: '11',
      generatedAt: new Date('2026-07-15T12:00:00.000Z'),
      ttlSeconds: 300,
    });
    expect(result.ready).toBe(true);
    if (!result.ready) return;

    const normalized = homeDashboardSchema.parse(normalizeHomeDashboardPayload(result.dashboard));
    expect(normalized.upcoming[0]?.participants).toEqual([
      {
        profileId: userId,
        displayName: 'Алексей Петров',
        firstName: 'Алексей',
        lastName: 'Петров',
        nickname: null,
        avatarUrl: null,
        level: 'C+',
      },
    ]);
  });
});
