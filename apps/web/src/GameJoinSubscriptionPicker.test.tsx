// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMockHomeDashboard } from '../../api/src/home/home-dashboard.js';
import { GameJoinSubscriptionPicker } from './GameJoinSubscriptionPicker.js';
import { createBrowserAuthGateway, type HomeDashboard } from './auth-gateway.js';

const first = '00000000-0000-4000-8000-000000000005';
const second = '00000000-0000-4000-8000-000000000006';
const item = (id: string, title: string) => ({
  id,
  title,
  status: 'expired' as const,
  remainingUnits: 0,
  validUntil: null,
  route: '/subscriptions/' + id,
});
const home = (subscriptions: HomeDashboard['subscriptions']): HomeDashboard => ({
  ...buildMockHomeDashboard({
    tenantId: first,
    userId: second,
    displayName: 'Синтетический игрок',
    phoneLast4: '0000',
    roles: ['client'],
    permissions: ['games.play'],
  }),
  subscriptions,
});
afterEach(cleanup);

describe('canonical subscription picker', () => {
  it('keeps policy on the server and offers only unique canonical ids with an accessible label', async () => {
    const onChange = vi.fn();
    render(
      <GameJoinSubscriptionPicker
        gateway={{
          getHomeDashboard: vi
            .fn()
            .mockResolvedValue(
              home([
                item(first, 'Произвольное название'),
                item(second, 'Другая подписка'),
                item(first, 'Дубликат'),
                item('provider-synthetic-raw-id', 'Сырой ID'),
              ]),
            ),
        }}
        onChange={onChange}
      />,
    );
    const select = await screen.findByRole('combobox', { name: 'Выберите подписку' });
    expect(select).toHaveValue('');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.queryByRole('option', { name: 'Сырой ID' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Дубликат' })).toBeNull();
    const user = userEvent.setup();
    await user.tab();
    expect(select).toHaveFocus();
    await user.selectOptions(select, second);
    expect(onChange).toHaveBeenLastCalledWith(second);
  });

  it('shows an empty state for absent or noncanonical instances', async () => {
    render(
      <GameJoinSubscriptionPicker
        gateway={{
          getHomeDashboard: vi
            .fn()
            .mockResolvedValue(home([item('provider-synthetic-raw-id', 'Сырой ID')])),
        }}
        onChange={vi.fn()}
      />,
    );
    expect(await screen.findByText('Нет подписок для проверки.')).toBeVisible();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('allows a bounded user retry after a read failure', async () => {
    let resolveRetry!: (dashboard: HomeDashboard) => void;
    const getHomeDashboard = vi
      .fn()
      .mockRejectedValueOnce(new Error('synthetic read refusal'))
      .mockImplementationOnce(
        () =>
          new Promise<HomeDashboard>((resolve) => {
            resolveRetry = resolve;
          }),
      );
    const onChange = vi.fn();
    render(<GameJoinSubscriptionPicker gateway={{ getHomeDashboard }} onChange={onChange} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось загрузить ваши подписки.',
    );
    const user = userEvent.setup();
    const retryButton = screen.getByRole('button', { name: 'Повторить загрузку подписок' });
    await user.tab();
    expect(retryButton).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(retryButton).toHaveFocus();
    expect(retryButton).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('region', { name: 'Подписка для проверки' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(onChange).toHaveBeenCalledWith(undefined);
    await user.keyboard('{Enter}');
    expect(getHomeDashboard).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolveRetry(home([item(first, 'Тестовая подписка')]));
      await Promise.resolve();
    });
    expect(await screen.findByRole('combobox', { name: 'Выберите подписку' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Обновить список подписок' })).toBe(retryButton);
    expect(retryButton).toHaveFocus();
    expect(retryButton).toHaveAttribute('aria-disabled', 'false');
    expect(screen.getByRole('region', { name: 'Подписка для проверки' })).toHaveAttribute(
      'aria-busy',
      'false',
    );
  });

  it('never shows the previous principal subscriptions after a same-gateway switch', async () => {
    let userId = first;
    const responses: Array<(response: Response) => void> = [];
    const fetchImplementation = vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/auth/session/refresh')) {
        return Promise.resolve(
          Response.json({
            accessToken: 'synthetic-only',
            tokenType: 'Bearer',
            expiresAt: '2099-01-01T00:00:00Z',
            user: { id: userId, displayName: 'Синтетический игрок' },
            context: {
              userId,
              tenantId: second,
              displayName: 'Синтетический игрок',
              phoneLast4: '0000',
              roles: ['client'],
              permissions: ['games.play'],
            },
          }),
        );
      }
      if (url.endsWith('/home')) return new Promise<Response>((resolve) => responses.push(resolve));
      throw new Error('Unexpected synthetic request');
    });
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.synthetic.invalid/',
      tenantKey: 'synthetic',
      appVersion: 'test',
      fetchImplementation,
    });
    expect(gateway.getGameJoinConditions).toBeUndefined();
    const onChange = vi.fn();
    await gateway.restoreSession();
    const view = render(
      <GameJoinSubscriptionPicker key={userId} gateway={gateway} onChange={onChange} />,
    );
    userId = second;
    await gateway.restoreSession();
    view.rerender(
      <GameJoinSubscriptionPicker key={userId} gateway={gateway} onChange={onChange} />,
    );
    expect(responses).toHaveLength(2);
    await act(async () => {
      responses[0]!(Response.json(home([item(first, 'Подписка прежнего игрока')])));
      await Promise.resolve();
    });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText('Подписка прежнего игрока')).toBeNull();
    await act(async () => {
      responses[1]!(Response.json(home([item(second, 'Подписка текущего игрока')])));
      await Promise.resolve();
    });
    expect(await screen.findByRole('option', { name: 'Подписка текущего игрока' })).toBeVisible();
    expect(screen.queryByRole('option', { name: 'Подписка прежнего игрока' })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('hides old gateway options synchronously and ignores a late old response', async () => {
    let resolveOld!: (value: HomeDashboard) => void;
    let resolveNew!: (value: HomeDashboard) => void;
    const oldGateway = {
      getHomeDashboard: vi.fn(
        () =>
          new Promise<HomeDashboard>((resolve) => {
            resolveOld = resolve;
          }),
      ),
    };
    const newGateway = {
      getHomeDashboard: vi.fn(
        () =>
          new Promise<HomeDashboard>((resolve) => {
            resolveNew = resolve;
          }),
      ),
    };
    const view = render(<GameJoinSubscriptionPicker gateway={oldGateway} onChange={vi.fn()} />);
    view.rerender(<GameJoinSubscriptionPicker gateway={newGateway} onChange={vi.fn()} />);
    await act(async () => {
      resolveOld(home([item(first, 'Старая подписка')]));
      await Promise.resolve();
    });
    expect(screen.queryByRole('combobox')).toBeNull();
    await act(async () => {
      resolveNew(home([item(second, 'Новая подписка')]));
      await Promise.resolve();
    });
    expect(await screen.findByRole('option', { name: 'Новая подписка' })).toBeVisible();
    expect(screen.queryByRole('option', { name: 'Старая подписка' })).toBeNull();
  });
});
