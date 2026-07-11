// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';
import type { AuthGateway, AuthenticatedSession } from './auth-gateway.js';

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
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('PadlHub web authentication', () => {
  it('restores an HttpOnly-cookie-backed session before showing protected home', async () => {
    const gateway = createGateway({ restoreSession: vi.fn().mockResolvedValue(session) });

    render(<App gateway={gateway} tenantKey="padlhub" />);

    expect(screen.getByRole('status')).toHaveTextContent('Проверяем сессию');
    expect(await screen.findByRole('heading', { name: 'Анна Петрова' })).toBeVisible();
    expect(screen.getByText('ПаделХАБ', { selector: 'dd' })).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Номер телефона' })).not.toBeInTheDocument();
    expect(gateway.restoreSession).toHaveBeenCalledOnce();
  });

  it('logs in with a normalized phone and a four-digit code', async () => {
    const gateway = createGateway();
    const user = userEvent.setup();

    render(<App gateway={gateway} tenantKey="padlhub" />);

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
    expect(await screen.findByRole('heading', { name: 'Вход по номеру' })).toBeVisible();
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
    expect(screen.getByRole('textbox', { name: 'Номер телефона' })).toHaveFocus();
  });
});
