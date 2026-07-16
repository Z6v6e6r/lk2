interface HomeDashboardInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly phoneLast4: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly now?: Date;
}

function addMilliseconds(date: Date, milliseconds: number): string {
  return new Date(date.getTime() + milliseconds).toISOString();
}

function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] || displayName;
}

/**
 * Synthetic local read model used only with VIVA_MODE=mock. It deliberately
 * mirrors the public HomeDashboard contract without importing an integration
 * identifier or making a client choose a backing source.
 */
export function buildMockHomeDashboard(input: HomeDashboardInput) {
  const now = input.now ?? new Date();
  const canManageTournaments =
    input.roles.some((role) => ['admin', 'manager'].includes(role)) ||
    input.permissions.includes('tournaments.manage');

  return {
    snapshot: {
      version: `home-v1-${now.getTime()}`,
      generatedAt: now.toISOString(),
      staleAt: addMilliseconds(now, 60_000),
      source: 'LOCAL_MOCK' as const,
    },
    profile: {
      userId: input.userId,
      displayName: input.displayName,
      firstName: firstName(input.displayName),
      avatarUrl: null,
      phoneLast4: input.phoneLast4,
      balanceMinor: 245_000,
      currency: 'RUB',
      level: { label: 'C+', value: 3.8, assessmentRequired: false },
    },
    counters: {
      unreadChats: 3,
      upcomingEvents: 2,
      activeSubscriptions: 1,
    },
    quickActions: [
      {
        id: 'play' as const,
        title: 'Найти игру',
        subtitle: 'Открытые игры рядом',
        route: '/games',
        tone: 'violet' as const,
      },
      {
        id: 'group_training' as const,
        title: 'Тренировки',
        subtitle: 'Группы по уровню',
        route: '/trainings',
        tone: 'lime' as const,
      },
      {
        id: 'tournament' as const,
        title: 'Турниры',
        subtitle: 'Сетка и регистрация',
        route: '/tournaments',
        tone: 'mint' as const,
      },
      {
        id: 'individual_training' as const,
        title: 'С тренером',
        subtitle: 'Индивидуальная запись',
        route: '/coaches',
        tone: 'sand' as const,
      },
    ],
    upcoming: [
      {
        id: '751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
        kind: 'game' as const,
        title: 'Название игры',
        startsAt: addMilliseconds(now, 26 * 60 * 60 * 1_000),
        venue: 'ПаделХАБ · корт 2',
        status: 'confirmed' as const,
        route: '/games/751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
      },
      {
        id: '081d6c55-aad7-459f-a350-8f905a0532d6',
        kind: 'training' as const,
        title: 'Название игры #2',
        startsAt: addMilliseconds(now, 74 * 60 * 60 * 1_000),
        venue: 'ПаделХАБ · корт 4',
        status: 'confirmed' as const,
        route: '/trainings/081d6c55-aad7-459f-a350-8f905a0532d6',
      },
    ],
    subscriptions: [
      {
        id: '24793a5a-0931-4a76-8600-267015be0ac9',
        title: 'Лето · Падел · Спорт',
        status: 'active' as const,
        remainingUnits: 8,
        validUntil: addMilliseconds(now, 60 * 24 * 60 * 60 * 1_000),
        route: '/subscriptions/24793a5a-0931-4a76-8600-267015be0ac9',
      },
    ],
    communities: [
      {
        id: '42c05c91-da23-4dc5-bf97-3d136a2d12bd',
        title: 'Padel Friends',
        description: 'Игры, встречи и новые партнёры',
        memberCount: 124,
        role: 'member' as const,
        unreadCount: 2,
        accent: '#B9A1FF',
        logoUrl: null,
        route: '/communities/42c05c91-da23-4dc5-bf97-3d136a2d12bd',
      },
      {
        id: 'c522103f-05aa-4ef1-a3a4-645d9a78b397',
        title: 'Команда Север',
        description: 'Собираемся по будням после работы',
        memberCount: 38,
        role: 'admin' as const,
        unreadCount: 1,
        accent: '#C9F66F',
        logoUrl: null,
        route: '/communities/c522103f-05aa-4ef1-a3a4-645d9a78b397',
      },
      {
        id: '92e25178-32e4-4fed-8964-5e758f858b0e',
        title: 'Турнирный клуб',
        description: 'Рейтинговые матчи и турниры',
        memberCount: 86,
        role: 'member' as const,
        unreadCount: 0,
        accent: '#8EDDC4',
        logoUrl: null,
        route: '/communities/92e25178-32e4-4fed-8964-5e758f858b0e',
      },
    ],
    promotion: {
      id: '391e45be-5941-4668-81bc-b2ce1d73b200',
      eyebrow: 'Акция',
      title: 'Лето. Падел. Дружба.',
      description: 'Летняя серия игр, турниров и специальных предложений.',
      actionLabel: 'Все акции',
      route: '/promotions',
      tone: 'lime' as const,
      imageUrl: null,
    },
    locations: [
      {
        id: 'a8df730b-6a67-41a5-8772-48bca84f73bc',
        title: 'Селигерская',
        courtCount: 5,
        imageUrl: null,
        route: '/locations/a8df730b-6a67-41a5-8772-48bca84f73bc',
      },
      {
        id: '90c31493-c42f-4b9d-b627-8ab8928e89d2',
        title: 'Терехово',
        courtCount: 12,
        imageUrl: null,
        route: '/locations/90c31493-c42f-4b9d-b627-8ab8928e89d2',
      },
    ],
    additionalLinks: [
      { id: 'promotions' as const, title: 'Все акции', route: '/promotions' },
      {
        id: 'gift_certificates' as const,
        title: 'Подарочные сертификаты',
        route: '/gift-certificates',
      },
      { id: 'offers' as const, title: 'Предложения', route: '/offers' },
    ],
    capabilities: {
      canCreateGame: true,
      canManageTournaments,
      canViewCommunities: true,
    },
  };
}
