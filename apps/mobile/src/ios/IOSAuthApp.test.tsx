// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PadlHubApiClient } from '@phub/api-sdk';
import { IOSAuthApp } from './IOSAuthApp.js';
import { IOSSession } from './session.js';

afterEach(cleanup);
const config = {
  apiBaseUrl: 'https://lk2.padlhub.su',
  tenantKey: 'local-padel',
  appVersion: '1',
  appBuild: '1',
};
function client(fetchImplementation: typeof fetch): IOSSession {
  return new IOSSession(
    config,
    new PadlHubApiClient({
      baseUrl: config.apiBaseUrl,
      tenantKey: config.tenantKey,
      platform: 'ios',
      appVersion: '1',
      fetchImplementation,
    }),
  );
}

describe('iOS phone sign-in', () => {
  it('requires both consents, normalizes the phone, limits OTP to four digits and has no OAuth controls', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ code: 'AUTH_SESSION_REVOKED' }, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({
          challengeId: '11111111-1111-4111-8111-111111111111',
          expiresAt: '2099-01-01T00:00:00Z',
        }),
      );
    const session = client(fetcher);
    await session.restore();
    render(<IOSAuthApp session={session} />);
    expect(screen.queryByText('Yandex')).toBeNull();
    expect(screen.queryByText('VK ID или Mail.ru')).toBeNull();
    const send = screen.getByRole<HTMLButtonElement>('button', { name: 'Получить код' });
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Номер телефона'), {
      target: { value: '8 (000) 000-00-00' },
    });
    fireEvent.click(screen.getByLabelText(/Принимаю условия/));
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Даю согласие/));
    fireEvent.click(send);
    const code = await screen.findByLabelText<HTMLInputElement>('Код из сообщения');
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual({
      method: 'phone_otp',
      phone: '+70000000000',
    });
    fireEvent.change(code, { target: { value: '123' } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Войти' }).disabled).toBe(true);
    fireEvent.change(code, { target: { value: '123456' } });
    expect(code.value).toBe('1234');
    expect(code.maxLength).toBe(4);
    expect(screen.queryByText(/\+70000000000/)).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Войти' }).disabled).toBe(false);
  });

  it('shows a retryable restore error without presenting a signed-out form', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code: 'UNAVAILABLE' }, { status: 503 }));
    const session = client(fetcher);
    await session.restore();
    render(<IOSAuthApp session={session} />);
    expect(screen.getByRole('alert').textContent).toContain('сохранённую сессию');
    expect(screen.queryByLabelText('Номер телефона')).toBeNull();
    fetcher.mockResolvedValueOnce(Response.json({ code: 'AUTH_SESSION_REVOKED' }, { status: 401 }));
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await screen.findByLabelText('Номер телефона');
  });

  it('waits for server revocation and provides retry on failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        accessToken: 'synthetic-access',
        tokenType: 'Bearer',
        expiresAt: '2099-01-01T00:00:00Z',
        user: { id: 'test', displayName: 'Тест' },
        context: { tenantId: 'test', userId: 'test' },
      }),
    );
    const session = client(fetcher);
    await session.restore();
    render(<IOSAuthApp session={session} />);
    fetcher.mockResolvedValueOnce(Response.json({ code: 'UNAVAILABLE' }, { status: 503 }));
    fireEvent.click(screen.getByRole('button', { name: 'Выйти' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Выход ещё не завершён'),
    );
    expect(screen.queryByText('Здравствуйте, Тест.')).toBeNull();
    fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await act(() => session.logout());
    await screen.findByLabelText('Номер телефона');
  });
});
