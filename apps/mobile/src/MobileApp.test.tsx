// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
  it('opens the existing phone screen without OAuth and explains session lifetime', async () => {
    render(<App gateway={createGateway()} tenantKey="local-padel" clientPlatform="android" />);
    expect(await screen.findByRole('button', { name: 'Получить код' })).toBeInTheDocument();
    expect(screen.queryByText('VK ID или Mail.ru')).not.toBeInTheDocument();
    expect(screen.queryByText('Yandex')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Войти через Viva/ })).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(
      'после закрытия приложения потребуется войти снова',
    );
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
