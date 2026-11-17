// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HomePushPrompt } from './HomePushPrompt.js';
import type { AuthGateway } from './auth-gateway.js';
import {
  enableWebPush,
  getWebPushBrowserState,
  type WebPushBrowserState,
} from './web-push-client.js';

vi.mock('./web-push-client.js', () => ({
  getWebPushBrowserState: vi.fn(),
  enableWebPush: vi.fn(),
}));

function gateway(config = { enabled: true, publicKey: 'synthetic-public-key' }) {
  return { getWebPushConfiguration: vi.fn().mockResolvedValue(config) } as unknown as AuthGateway;
}

beforeEach(() => {
  vi.mocked(getWebPushBrowserState).mockResolvedValue('default');
  vi.mocked(enableWebPush).mockResolvedValue(undefined);
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
    },
    close: {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.removeAttribute('open');
      },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Home push invitation', () => {
  it('checks silently and enables only on a click; closes after successful registration', async () => {
    const api = gateway();
    render(<HomePushPrompt gateway={api} clientPlatform="web" />);
    expect(await screen.findByRole('dialog', { name: 'Включите уведомления' })).toBeVisible();
    expect(enableWebPush).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Включить уведомления' }));
    expect(enableWebPush).toHaveBeenCalledWith(
      expect.objectContaining({ gateway: api, publicKey: 'synthetic-public-key' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it.each(['subscribed', 'unsupported'] as const)(
    'does not interrupt a %s browser',
    async (state) => {
      vi.mocked(getWebPushBrowserState).mockResolvedValue(state);
      const api = gateway();
      render(<HomePushPrompt gateway={api} clientPlatform="web" />);
      await waitFor(() => expect(api.getWebPushConfiguration).toHaveBeenCalled());
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    },
  );

  it('does not interpret unavailable checks or a disabled runtime as disabled user push', async () => {
    const api = gateway({ enabled: false, publicKey: '' });
    const { unmount } = render(<HomePushPrompt gateway={api} clientPlatform="web" />);
    await act(() => Promise.resolve());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    unmount();
    vi.mocked(getWebPushBrowserState).mockRejectedValue(new Error('check unavailable'));
    render(<HomePushPrompt gateway={gateway()} clientPlatform="web" />);
    await act(() => Promise.resolve());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps Later dismissed through home refreshes and restores scroll on close', async () => {
    const api = gateway();
    const { rerender } = render(<HomePushPrompt gateway={api} clientPlatform="web" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Позже' }));
    expect(document.body.style.overflow).toBe('');
    rerender(<HomePushPrompt gateway={api} clientPlatform="web" />);
    fireEvent(window, new Event('focus'));
    await act(() => Promise.resolve());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(enableWebPush).not.toHaveBeenCalled();
  });

  it.each([
    ['denied', 'Разрешите уведомления в настройках сайта'],
    ['needs_install', 'На экран Домой'],
  ] as const)('explains %s without a non-working enable button', async (state, text) => {
    vi.mocked(getWebPushBrowserState).mockResolvedValue(state);
    render(<HomePushPrompt gateway={gateway()} clientPlatform="web" />);
    expect(await screen.findByRole('dialog')).toHaveTextContent(text);
    expect(screen.queryByRole('button', { name: 'Включить уведомления' })).not.toBeInTheDocument();
  });

  it('keeps a failed registration visible and allows retry instead of claiming success', async () => {
    vi.mocked(enableWebPush).mockRejectedValueOnce(new Error('registration failed'));
    render(<HomePushPrompt gateway={gateway()} clientPlatform="web" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Включить уведомления' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось включить');
    fireEvent.click(screen.getByRole('button', { name: 'Включить уведомления' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(enableWebPush).toHaveBeenCalledTimes(2);
  });

  it('uses Android device state and action without invoking browser push', () => {
    const api = gateway();
    const devicePush = {
      enabled: true,
      state: 'ready' as WebPushBrowserState,
      busy: false,
      enable: vi.fn(),
      disable: vi.fn(),
    };
    const { rerender } = render(
      <HomePushPrompt gateway={api} clientPlatform="android" devicePush={devicePush} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Включить уведомления' }));
    expect(devicePush.enable).toHaveBeenCalledOnce();
    expect(api.getWebPushConfiguration).not.toHaveBeenCalled();
    expect(getWebPushBrowserState).not.toHaveBeenCalled();
    expect(enableWebPush).not.toHaveBeenCalled();
    rerender(
      <HomePushPrompt
        gateway={api}
        clientPlatform="android"
        devicePush={{ ...devicePush, state: 'subscribed' }}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('rechecks browser state when returning from settings and supports Escape dismissal', async () => {
    const api = gateway();
    render(<HomePushPrompt gateway={api} clientPlatform="web" />);
    const dialog = await screen.findByRole('dialog');
    fireEvent(dialog, new Event('cancel', { bubbles: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    cleanup();
    render(<HomePushPrompt gateway={api} clientPlatform="web" />);
    await screen.findByRole('dialog');
    vi.mocked(getWebPushBrowserState).mockResolvedValue('subscribed');
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
