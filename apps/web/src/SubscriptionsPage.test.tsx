// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HomeDashboard } from './auth-gateway.js';
import { SubscriptionsPage } from './SubscriptionsPage.js';

type Subscription = HomeDashboard['subscriptions'][number];
const first: Subscription = {
  id: '00000000-0000-4000-8000-000000000021',
  title: 'Дружба',
  status: 'active',
  remainingUnits: 8,
  validUntil: '2026-12-31T00:00:00Z',
  route: '/subscriptions/00000000-0000-4000-8000-000000000021',
};
const second: Subscription = {
  ...first,
  id: '00000000-0000-4000-8000-000000000022',
  title: 'РА',
  remainingUnits: 0,
  validUntil: null,
};
function data(
  items: readonly Subscription[] = [first, second],
): Pick<HomeDashboard, 'subscriptions' | 'snapshot'> {
  return {
    subscriptions: [...items],
    snapshot: {
      version: 'synthetic-v1',
      generatedAt: '2026-10-15T09:00:00Z',
      staleAt: '2026-10-15T09:01:00Z',
      source: 'LOCAL_MOCK',
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}
const refresh = () => screen.getByRole('button', { name: 'Обновить подборку абонементов' });
beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('current subscription selection', () => {
  it('separates loading from empty and explains partial coverage on every view', async () => {
    const pending = deferred<ReturnType<typeof data>>();
    render(<SubscriptionsPage loadDashboard={() => pending.promise} />);
    expect(screen.getByRole('status')).toHaveTextContent('Загружаем абонементы');
    expect(screen.getByRole('note')).toHaveTextContent('до 6 абонементов');
    expect(refresh()).toBeDisabled();
    expect(screen.queryByText('В текущей подборке нет абонементов.')).not.toBeInTheDocument();
    await settle(() => pending.resolve(data([])));
    expect(await screen.findByText('В текущей подборке нет абонементов.')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('renders unknown units, type and validity without inferring them from a plan title', async () => {
    render(
      <SubscriptionsPage
        loadDashboard={() => Promise.resolve(data())}
        subscriptionId={second.id}
      />,
    );
    expect(await screen.findByRole('heading', { name: 'РА' })).toBeVisible();
    expect(screen.getByRole('note')).toHaveTextContent('неполный список');
    expect(screen.getByText('Не подтверждён')).toBeVisible();
    expect(screen.getByText('Срок не указан')).toBeVisible();
    expect(screen.getByText('Единица остатка')).toBeVisible();
    expect(screen.getByText('Тип').nextElementSibling).toHaveTextContent('Не указан');
    expect(screen.queryByText(/посещени|минут|дней/)).not.toBeInTheDocument();
    expect(screen.queryByText('Исчерпан')).not.toBeInTheDocument();
  });
  it('keeps confirmed exhaustion and zero separate from an unknown remainder', async () => {
    render(
      <SubscriptionsPage
        loadDashboard={() =>
          Promise.resolve(data([{ ...first, status: 'exhausted', remainingUnits: 0 }]))
        }
      />,
    );
    expect(await screen.findByText('Исчерпан')).toBeVisible();
    expect(screen.getByText('0')).toBeVisible();
    expect(screen.queryByText('Не подтверждён')).not.toBeInTheDocument();
  });
  it('selects the canonical ID and restores the same list and link focus without refetching', async () => {
    const load = vi.fn().mockResolvedValue(data());
    function Journey() {
      const [id, setId] = useState<string>();
      return (
        <SubscriptionsPage
          loadDashboard={load}
          {...(id ? { subscriptionId: id } : {})}
          onNavigate={(href) => setId(href.split('/')[2])}
        />
      );
    }
    render(<Journey />);
    const link = await screen.findByRole('link', { name: 'Открыть абонемент РА' });
    fireEvent.click(link);
    expect(screen.getByRole('heading', { name: 'РА' })).toHaveFocus();
    expect(
      screen.queryByRole('link', { name: 'Открыть абонемент Дружба' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Назад к абонементам' }));
    expect(screen.getByRole('link', { name: 'Открыть абонемент РА' })).toHaveFocus();
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('does not invent a not-found or forbidden result for an ID outside this selection', async () => {
    render(
      <SubscriptionsPage
        loadDashboard={() => Promise.resolve(data())}
        subscriptionId="00000000-0000-4000-8000-000000000099"
      />,
    );
    expect(await screen.findByText(/Этого абонемента нет в текущей подборке/)).toBeVisible();
    expect(screen.queryByText(/404|доступ запрещён/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Назад к абонементам' })).toHaveAttribute(
      'href',
      '/subscriptions',
    );
  });
  it('treats a failed request as an error, supports retry, and never calls it an empty selection', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue(data([first]));
    render(<SubscriptionsPage loadDashboard={load} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось загрузить');
    expect(screen.queryByText('В текущей подборке нет абонементов.')).not.toBeInTheDocument();
    fireEvent.click(refresh());
    expect(await screen.findByRole('link', { name: 'Открыть абонемент Дружба' })).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('re-reads on refresh, replaces the snapshot, and blocks overlapping refresh clicks', async () => {
    const next = deferred<ReturnType<typeof data>>();
    const load = vi
      .fn()
      .mockResolvedValueOnce(data([first]))
      .mockReturnValueOnce(next.promise);
    render(<SubscriptionsPage loadDashboard={load} subscriptionId={first.id} />);
    expect(await screen.findByRole('heading', { name: 'Дружба' })).toBeVisible();
    fireEvent.click(refresh());
    fireEvent.click(refresh());
    expect(refresh()).toBeDisabled();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await settle(() =>
      next.resolve({
        ...data([second]),
        snapshot: { ...data().snapshot, generatedAt: '2026-10-15T09:30:00Z' },
      }),
    );
    expect(await screen.findByText(/Этого абонемента нет в текущей подборке/)).toBeVisible();
    expect(screen.queryByText('8')).not.toBeInTheDocument();
    expect(
      screen.getByRole('main').querySelector('time[datetime="2026-10-15T09:30:00Z"]'),
    ).toBeInTheDocument();
  });
  it('retains an explicitly labelled previous selection when refresh fails', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(data([first]))
      .mockRejectedValueOnce(new Error('unavailable'));
    render(<SubscriptionsPage loadDashboard={load} />);
    await screen.findByRole('link', { name: 'Открыть абонемент Дружба' });
    fireEvent.click(refresh());
    expect(await screen.findByRole('alert')).toHaveTextContent('Ниже показана предыдущая подборка');
    expect(screen.getByRole('link', { name: 'Открыть абонемент Дружба' })).toBeVisible();
  });
  it('ignores a late old loader response after its account-scoped loader changes', async () => {
    const old = deferred<ReturnType<typeof data>>();
    const loadOld = vi.fn().mockReturnValue(old.promise);
    const loadNew = vi.fn().mockResolvedValue(data([second]));
    const view = render(<SubscriptionsPage loadDashboard={loadOld} />);
    await waitFor(() => expect(loadOld).toHaveBeenCalledTimes(1));
    view.rerender(<SubscriptionsPage loadDashboard={loadNew} />);
    await screen.findByRole('link', { name: 'Открыть абонемент РА' });
    await settle(() => old.resolve(data([first])));
    expect(
      screen.queryByRole('link', { name: 'Открыть абонемент Дружба' }),
    ).not.toBeInTheDocument();
  });
  it('clears a previous principal snapshot immediately and ignores its late refresh rejection', async () => {
    const pending = deferred<ReturnType<typeof data>>();
    const load = vi
      .fn()
      .mockResolvedValueOnce(data([first]))
      .mockReturnValueOnce(pending.promise);
    const next = deferred<ReturnType<typeof data>>();
    const view = render(<SubscriptionsPage key="tenant:old" loadDashboard={load} />);
    await screen.findByRole('link', { name: 'Открыть абонемент Дружба' });
    fireEvent.click(refresh());
    view.rerender(<SubscriptionsPage key="tenant:new" loadDashboard={() => next.promise} />);
    expect(
      screen.queryByRole('link', { name: 'Открыть абонемент Дружба' }),
    ).not.toBeInTheDocument();
    await settle(() => pending.reject(new Error('old request failed')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await settle(() => next.resolve(data([second])));
    expect(await screen.findByRole('link', { name: 'Открыть абонемент РА' })).toBeVisible();
  });
  it('does not expose actions that buy, renew or alter a subscription', async () => {
    render(<SubscriptionsPage loadDashboard={() => Promise.resolve(data())} />);
    const list = await screen.findByRole('list');
    expect(within(list).getAllByRole('link')).toHaveLength(2);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByText(/Купить|Продлить|Заморозить|Вернуть/)).not.toBeInTheDocument();
  });
});
