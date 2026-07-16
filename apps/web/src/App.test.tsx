// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';
import type {
  AuthGateway,
  AuthenticatedSession,
  HomeDashboard,
  UserProfile,
  UserUpcomingBookings,
} from './auth-gateway.js';

const session: AuthenticatedSession = {
  context: {
    user: {
      id: '00000000-0000-4000-8000-000000000001',
      displayName: 'Анна Петрова',
      phoneMasked: '+7 *** ***-**-01',
    },
    tenant: {
      id: '00000000-0000-4000-8000-000000000002',
      key: 'padlhub',
      name: 'ПаделХАБ',
    },
    roles: ['client'],
    permissions: ['profile.read'],
  },
};

const homeDashboard: HomeDashboard = {
  snapshot: {
    version: 'home-v1-test',
    generatedAt: '2026-07-15T09:00:00.000Z',
    staleAt: '2026-07-15T09:01:00.000Z',
    source: 'LOCAL_MOCK',
  },
  profile: {
    userId: session.context.user.id,
    displayName: session.context.user.displayName,
    firstName: 'Анна',
    avatarUrl: null,
    phoneLast4: '0001',
    balanceMinor: 54000,
    currency: 'RUB',
    level: { label: 'C+', value: 3.8, assessmentRequired: false },
  },
  counters: { unreadChats: 2, upcomingEvents: 1, activeSubscriptions: 1 },
  quickActions: [
    {
      id: 'play',
      title: 'Найти игру',
      subtitle: 'Открытые игры рядом',
      route: '/games',
      tone: 'violet',
    },
  ],
  upcoming: [
    {
      id: '751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
      kind: 'game',
      title: 'Американо · уровень C',
      startsAt: '2026-07-16T18:00:00.000Z',
      venue: 'ПаделХАБ · корт 2',
      status: 'confirmed',
      route: '/games/751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
    },
  ],
  subscriptions: [
    {
      id: '24793a5a-0931-4a76-8600-267015be0ac9',
      title: 'Лето · Падел · Спорт',
      status: 'active',
      remainingUnits: 8,
      validUntil: '2026-09-15T00:00:00.000Z',
      route: '/subscriptions/24793a5a-0931-4a76-8600-267015be0ac9',
    },
  ],
  communities: [
    {
      id: '42c05c91-da23-4dc5-bf97-3d136a2d12bd',
      title: 'Padel Friends',
      description: 'Игры, встречи и новые партнёры',
      memberCount: 124,
      role: 'member',
      unreadCount: 2,
      accent: '#B9A1FF',
      logoUrl: null,
      route: '/communities/42c05c91-da23-4dc5-bf97-3d136a2d12bd',
    },
  ],
  promotion: null,
  locations: [
    {
      id: 'a8df730b-6a67-41a5-8772-48bca84f73bc',
      title: 'Селигерская',
      courtCount: 5,
      imageUrl: null,
      route: '/locations/a8df730b-6a67-41a5-8772-48bca84f73bc',
    },
  ],
  additionalLinks: [
    { id: 'promotions', title: 'Все акции', route: '/promotions' },
    {
      id: 'gift_certificates',
      title: 'Подарочные сертификаты',
      route: '/gift-certificates',
    },
    { id: 'offers', title: 'Предложения', route: '/offers' },
  ],
  capabilities: {
    canCreateGame: true,
    canManageTournaments: false,
    canViewCommunities: true,
  },
};

const userProfile: UserProfile = homeDashboard.profile;
const upcomingBookings: UserUpcomingBookings = {
  version: homeDashboard.snapshot.version,
  generatedAt: homeDashboard.snapshot.generatedAt,
  staleAt: homeDashboard.snapshot.staleAt,
  items: homeDashboard.upcoming,
};

function createGateway(overrides: Partial<AuthGateway> = {}): AuthGateway {
  return {
    restoreSession: vi.fn().mockResolvedValue(null),
    requestCode: vi.fn().mockResolvedValue({
      challengeId: 'challenge-1',
      maskedPhone: '+7 *** ***-**-01',
      expiresAt: '2026-07-11T12:05:00.000Z',
      resendAt: '2026-07-11T12:01:00.000Z',
    }),
    verifyCode: vi.fn().mockResolvedValue(session),
    startVivaOAuth: vi.fn().mockResolvedValue(undefined),
    getVivaAccessToken: vi.fn().mockReturnValue(undefined),
    refreshVivaAccessToken: vi.fn().mockResolvedValue('viva-access-token'),
    getRoutingPlan: vi.fn().mockResolvedValue({
      revision: '1',
      mode: 'PADLHUB_ONLY',
      issuedAt: '2026-07-15T08:00:00.000Z',
      expiresAt: '2099-07-15T08:01:00.000Z',
      operations: [],
    }),
    getUserProfile: vi.fn().mockResolvedValue(userProfile),
    getUpcomingBookings: vi.fn().mockResolvedValue(upcomingBookings),
    getHomeDashboard: vi.fn().mockResolvedValue(homeDashboard),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

async function openPhoneLogin(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Войти по номеру телефона' }));
}

describe('PadlHub web authentication', () => {
  it('restores an HttpOnly-cookie-backed session before showing protected home', async () => {
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(screen.getByRole('status')).toHaveTextContent('Проверяем сессию');
    expect(await screen.findByRole('heading', { name: 'Анна Петрова' })).toBeVisible();
    expect(screen.getAllByText('ПаделХАБ').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Сообщества' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'VK ID или Mail.ru' })).not.toBeInTheDocument();
    expect(gateway.restoreSession).toHaveBeenCalledOnce();
    expect(gateway.getHomeDashboard).toHaveBeenCalledOnce();
  });

  it('loads the profile route through the profile gateway without requesting Home', async () => {
    window.history.replaceState({}, '', '/profile');
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Анна Петрова' })).toBeVisible();
    expect(screen.getByText('540 ₽')).toBeVisible();
    expect(screen.getByText('Рейтинг 3,8')).toBeVisible();
    expect(gateway.getUserProfile).toHaveBeenCalledWith(session.context.user.id);
    expect(gateway.getHomeDashboard).not.toHaveBeenCalled();
  });

  it('loads the bookings route as a separate PadlHub aggregate without requesting Home', async () => {
    window.history.replaceState({}, '', '/bookings');
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Мои записи' })).toBeVisible();
    expect(screen.getByText('Американо · уровень C')).toBeVisible();
    expect(screen.getByText('Подтверждено')).toBeVisible();
    expect(gateway.getUpcomingBookings).toHaveBeenCalledOnce();
    expect(gateway.getHomeDashboard).not.toHaveBeenCalled();
    expect(gateway.getUserProfile).not.toHaveBeenCalled();
  });

  it('does not fall through from a known section route to Home', async () => {
    window.history.replaceState({}, '', '/promotions');
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Акции' })).toBeVisible();
    expect(screen.getByText('Раздел подключается к API ПаделХАБ.')).toBeVisible();
    expect(gateway.getHomeDashboard).not.toHaveBeenCalled();
    expect(gateway.getUpcomingBookings).not.toHaveBeenCalled();
    expect(gateway.getUserProfile).not.toHaveBeenCalled();
  });

  it('shows a not-found screen for an unknown protected route without requesting Home', async () => {
    window.history.replaceState({}, '', '/unknown');
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('heading', { name: 'Страница не найдена' })).toBeVisible();
    expect(gateway.getHomeDashboard).not.toHaveBeenCalled();
    expect(gateway.getUpcomingBookings).not.toHaveBeenCalled();
    expect(gateway.getUserProfile).not.toHaveBeenCalled();
  });

  it('logs in with a normalized phone and a four-digit code', async () => {
    const gateway = createGateway();
    const user = userEvent.setup();

    render(<App gateway={gateway} tenantKey="padlhub" />);

    await openPhoneLogin(user);
    const phone = await screen.findByRole('textbox', { name: 'Номер телефона' });
    await user.clear(phone);
    await user.type(phone, '+7 999 000-00-01');
    await user.click(screen.getByRole('button', { name: 'Получить код' }));

    expect(gateway.requestCode).toHaveBeenCalledWith('+79990000001');
    const code = await screen.findByRole('textbox', { name: 'Код из СМС' });
    expect(code).toHaveFocus();
    await user.type(code, '0000');
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(gateway.verifyCode).toHaveBeenCalledWith({ challengeId: 'challenge-1', code: '0000' });
    expect(await screen.findByRole('heading', { name: 'Анна Петрова' })).toBeVisible();
  });

  it('clears protected UI after logout', async () => {
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });
    const user = userEvent.setup();

    render(<App gateway={gateway} tenantKey="padlhub" />);

    await screen.findByRole('heading', { name: 'Анна Петрова' });
    await user.click(screen.getByRole('button', { name: 'Выйти' }));

    expect(gateway.logout).toHaveBeenCalledOnce();
    expect(await screen.findByRole('heading', { name: 'Войти в личный кабинет' })).toBeVisible();
    expect(screen.queryByText('Анна Петрова')).not.toBeInTheDocument();
  });

  it('keeps protected UI when server logout fails', async () => {
    const gateway = createGateway({
      restoreSession: vi.fn().mockResolvedValue(session),
      logout: vi.fn().mockRejectedValue(new Error('network unavailable')),
    });
    const user = userEvent.setup();

    render(<App gateway={gateway} tenantKey="padlhub" />);
    await screen.findByRole('heading', { name: 'Анна Петрова' });
    await user.click(screen.getByRole('button', { name: 'Выйти' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('сессия осталась активной');
    expect(screen.getByRole('heading', { name: 'Анна Петрова' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Выйти' })).toBeEnabled();
  });

  it('keeps the OTP screen accessible and explains a rejected code', async () => {
    const gateway = createGateway({
      verifyCode: vi.fn().mockRejectedValue({ code: 'AUTH_CODE_INVALID' }),
    });
    const user = userEvent.setup();

    render(<App gateway={gateway} tenantKey="padlhub" />);

    await openPhoneLogin(user);
    const phone = await screen.findByRole('textbox', { name: 'Номер телефона' });
    await user.clear(phone);
    await user.type(phone, '+79990000001');
    await user.click(screen.getByRole('button', { name: 'Получить код' }));
    const code = await screen.findByRole('textbox', { name: 'Код из СМС' });
    await user.type(code, '1111');
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Код не подошёл');
    expect(screen.getByRole('heading', { name: 'Введите код' })).toBeVisible();
    expect(code).toHaveValue('');
    expect(code).toHaveAttribute('aria-invalid', 'true');
  });

  it('falls back to phone login when session restoration is unavailable', async () => {
    const gateway = createGateway({
      restoreSession: vi.fn().mockRejectedValue(new Error('network unavailable')),
    });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось проверить сессию');
    expect(screen.getByRole('heading', { name: 'Войти в личный кабинет' })).toBeVisible();
  });

  it('requires both legal acceptances before beginning Viva OAuth', async () => {
    const gateway = createGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} tenantKey="padlhub" />);

    const vkButton = await screen.findByRole('button', { name: 'VK ID или Mail.ru' });
    await user.click(vkButton);
    expect(await screen.findByRole('alert')).toHaveTextContent('Подтвердите публичную оферту');
    expect(gateway.startVivaOAuth).not.toHaveBeenCalled();

    await user.click(screen.getByRole('checkbox', { name: /публичной оферты/i }));
    await user.click(screen.getByRole('checkbox', { name: /обработку персональных данных/i }));
    await user.click(vkButton);
    expect(gateway.startVivaOAuth).toHaveBeenCalledWith({
      provider: 'vkid',
      acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
    });
  });
});
