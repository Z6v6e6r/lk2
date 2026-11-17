// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PushOptInPage } from './PushOptInPage.js';

afterEach(cleanup);

const enabled = { enabled: true, publicKey: 'public-vapid-key-value' } as const;
const community = 'https://padlhub.ru/lk_new?authMode=viva&openCommunity=community_1';

function renderPage(overrides: Partial<Parameters<typeof PushOptInPage>[0]> = {}) {
  return render(
    <PushOptInPage
      webPush={enabled}
      browserState="ready"
      busy={false}
      error={null}
      ios={false}
      returnTo={community}
      onEnable={() => undefined}
      {...overrides}
    />,
  );
}

describe('PushOptInPage', () => {
  it('offers the explicit opt-in and returns to the community', () => {
    const onEnable = vi.fn();
    renderPage({ onEnable });
    expect(screen.getByRole('heading', { name: 'Уведомления о результатах' })).toBeVisible();
    expect(screen.getByText(/пришлём результаты выставки/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Включить уведомления' }));
    expect(onEnable).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'Вернуться в сообщество' })).toHaveAttribute(
      'href',
      community,
    );
  });

  it('reports an already enabled device without offering a second subscription', () => {
    renderPage({ browserState: 'subscribed' });
    expect(screen.getByText('Уведомления включены на этом устройстве.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Включить уведомления' })).not.toBeInTheDocument();
  });

  it('explains a denied permission and does not offer a dead button', () => {
    renderPage({ browserState: 'denied' });
    expect(screen.getByRole('alert')).toHaveTextContent(/Браузер запретил уведомления/);
    expect(screen.queryByRole('button', { name: 'Включить уведомления' })).not.toBeInTheDocument();
  });

  it('explains the iOS home-screen requirement instead of claiming unsupported silence', () => {
    renderPage({ browserState: 'unsupported', ios: true });
    expect(screen.getByText(/На iPhone уведомления работают только/)).toBeVisible();
    expect(screen.getByText(/На экран Домой/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Включить уведомления' })).not.toBeInTheDocument();
  });

  it('keeps a way back when push is not enabled for the organisation', () => {
    renderPage({ webPush: { enabled: false, reason: 'TENANT_GATE_DISABLED' } });
    expect(screen.getByText(/Уведомления пока недоступны/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Вернуться в сообщество' })).toBeVisible();
  });

  it('falls back to notifications for a direct visit without a community return URL', () => {
    renderPage({ returnTo: null });
    expect(screen.getByRole('link', { name: 'Перейти к уведомлениям' })).toHaveAttribute(
      'href',
      '/notifications',
    );
  });
});
