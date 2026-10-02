// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../web/src/App.js';
import { createBrowserAuthGateway } from '../../web/src/auth-gateway.js';

const createGateway = () =>
  createBrowserAuthGateway({
    baseUrl: 'https://lk.nano.padlhub.su',
    tenantKey: 'local-padel',
    platform: 'android',
    appVersion: 'test',
    fetchImplementation: vi.fn(),
  });
afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

describe('shared LK2 Android UI', () => {
  it('opens the existing phone screen without OAuth or obsolete session instructions', async () => {
    render(<App gateway={createGateway()} tenantKey="local-padel" clientPlatform="android" />);
    expect(await screen.findByRole('button', { name: 'Получить код' })).toBeInTheDocument();
    expect(screen.queryByText('VK ID или Mail.ru')).not.toBeInTheDocument();
    expect(screen.queryByText('Yandex')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Войти через Viva/ })).not.toBeInTheDocument();
    expect(
      screen.queryByText(/после закрытия приложения потребуется войти снова/),
    ).not.toBeInTheDocument();
  });
  it('starts with Yandex ID when the native gateway is available and requires both legal acceptances', async () => {
    const gateway = createGateway();
    const start = vi.spyOn(gateway, 'startVivaOAuth').mockResolvedValue(undefined);
    render(
      <App gateway={gateway} tenantKey="local-padel" clientPlatform="android" androidYandexLogin />,
    );
    const button = await screen.findByRole('button', { name: 'Войти с Яндекс ID' });
    expect(screen.queryByRole('textbox', { name: 'Номер телефона' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Войти по СМС' })).toBeEnabled();
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Подтвердите публичную оферту');
    for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox);
    fireEvent.click(button);
    expect(start).toHaveBeenCalledWith({
      provider: 'yandex',
      acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
    });
    expect(screen.getByRole('button', { name: 'Войти по СМС' })).toBeDisabled();
  });
  it('keeps SMS as an explicit alternative and preserves consent when switching methods', async () => {
    const gateway = createGateway();
    const start = vi.spyOn(gateway, 'startVivaOAuth').mockResolvedValue(undefined);
    const request = vi.spyOn(gateway, 'requestCode').mockResolvedValue({
      challengeId: '00000000-0000-4000-8000-000000000003',
      maskedPhone: '+7 *** ***-**-01',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      resendAt: new Date(Date.now() + 60_000).toISOString(),
    });
    render(
      <App gateway={gateway} tenantKey="local-padel" clientPlatform="android" androidYandexLogin />,
    );
    await screen.findByRole('button', { name: 'Войти с Яндекс ID' });
    for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: 'Войти по СМС' }));
    const phone = screen.getByRole('textbox', { name: 'Номер телефона' });
    expect(
      screen.getAllByRole('checkbox').every((checkbox) => (checkbox as HTMLInputElement).checked),
    ).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '← Войти с Яндекс ID' }));
    expect(screen.queryByRole('textbox', { name: 'Номер телефона' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Войти по СМС' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Номер телефона' }), {
      target: { value: '+79990000001' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Получить код' }));
    expect(await screen.findByRole('textbox', { name: 'Код из СМС' })).toBeInTheDocument();
    expect(request).toHaveBeenCalledExactlyOnceWith('+79990000001');
    expect(start).not.toHaveBeenCalled();
    expect(phone).not.toBeInTheDocument();
  });
  it('keeps SMS available after a failed Yandex launch without starting it automatically', async () => {
    const gateway = createGateway();
    vi.spyOn(gateway, 'startVivaOAuth').mockRejectedValue(new Error('launch unavailable'));
    const request = vi.spyOn(gateway, 'requestCode');
    render(
      <App gateway={gateway} tenantKey="local-padel" clientPlatform="android" androidYandexLogin />,
    );
    const button = await screen.findByRole('button', { name: 'Войти с Яндекс ID' });
    for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox);
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Войти по СМС' }));
    expect(screen.getByRole('textbox', { name: 'Номер телефона' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });
  it.each(['/giftcard', '/gift-certificates', '/games/new', '/chats', '/communities'])(
    'does not expose browser-only commerce/provider/upload controls at %s',
    async (path) => {
      window.history.replaceState({}, '', path);
      const gateway = createGateway();
      const payment = vi.spyOn(gateway, 'getPublicGiftCertificateCatalog');
      const restore = vi.spyOn(gateway, 'restoreSession').mockResolvedValue({
        context: {
          user: { id: '00000000-0000-4000-8000-000000000001', displayName: 'Тестовый игрок' },
          tenant: {
            id: '00000000-0000-4000-8000-000000000002',
            key: 'local-padel',
            name: 'ПадлХАБ',
          },
          roles: ['client'],
          permissions: [],
        },
      });
      // Unread counters are independent of the selected section.
      vi.spyOn(gateway, 'listConversations').mockResolvedValue({ items: [] });
      render(<App gateway={gateway} tenantKey="local-padel" clientPlatform="android" />);
      expect(
        await screen.findByRole('heading', {
          name: 'Раздел появится в следующей версии приложения',
        }),
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Вернуться на Главную' })).toBeInTheDocument();
      expect(payment).not.toHaveBeenCalled();
      expect(restore).toHaveBeenCalled();
    },
  );
});
