// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, it, expect, vi } from 'vitest';
import { QuarterCreatePanel } from './QuarterCreatePanel.js';
import {
  quarterStorageKey,
  quarterOperationId,
  quarterDraftId,
  type QuarterCustody,
} from './quarter-create-attempt.js';
import type { AuthGateway } from './auth-gateway.js';
import type { CreateGameAttemptLockManager } from './create-game-attempt.js';
const principal = {
    tenantId: '11111111-1111-4111-8111-000000000001',
    userId: '11111111-1111-4111-8111-000000000002',
  },
  input = {
    stationId: '11111111-1111-4111-8111-000000000003',
    courtId: '11111111-1111-4111-8111-000000000004',
    subscriptionId: '11111111-1111-4111-8111-000000000005',
    startsAt: '2030-01-01T12:00:00.000Z',
  };
const locks: CreateGameAttemptLockManager = {
  request: async (_n, _o, fn) => {
    await Promise.resolve();
    return fn();
  },
};
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function value() {
  const c = JSON.parse(localStorage.getItem(quarterStorageKey(principal))!) as QuarterCustody,
    h = Array.from(
      new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(c.key))),
    )
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
  return {
    contractVersion: 1,
    request: c.request,
    keySha256: 'sha256:' + h,
    operation: {
      id: await quarterOperationId(c),
      draftId: await quarterDraftId(c),
      status: 'CONFIRMED',
    },
    gameProjection: { status: 'PENDING', gameId: null },
    registration: { status: 'UNKNOWN', asOf: null },
    reason: null,
  };
}
function setup() {
  vi.stubGlobal('crypto', webcrypto);
  const g = {
    quarterCreatePrincipal: () => `${principal.tenantId}:${principal.userId}:0:0`,
    getQuarterCreateCapability: vi.fn(async () => {
      await Promise.resolve();
      return { contractVersion: 1, available: true };
    }),
    getQuarterCreateLocations: vi.fn(async () => {
      await Promise.resolve();
      return {
        items: [
          {
            stationId: input.stationId,
            courtId: input.courtId,
            stationTitle: 'Synthetic station',
            courtName: 'Court1',
          },
        ],
      };
    }),
    getHomeDashboard: vi.fn(async () => {
      await Promise.resolve();
      return { subscriptions: [{ id: input.subscriptionId, title: 'Synthetic subscription' }] };
    }),
    createQuarterGame: vi.fn(async () => {
      await Promise.resolve();
      return value();
    }),
    getQuarterCreateOperation: vi.fn(async () => {
      await Promise.resolve();
      return value();
    }),
    reconcileQuarterCreateOperation: vi.fn(async () => {
      await Promise.resolve();
      return value();
    }),
  };
  return { g, gateway: g as unknown as AuthGateway };
}
it('actual form uses typed location and explicit subscription; confirmation shows projection pending, not attendance', async () => {
  const h = setup(),
    user = userEvent.setup();
  render(
    <QuarterCreatePanel
      gateway={h.gateway}
      principal={principal}
      attemptStorage={localStorage}
      attemptLockManager={locks}
    />,
  );
  const court = await screen.findByRole('option', { name: 'Synthetic station · Court1' });
  expect(court).toBeVisible();
  expect(
    screen.getByLabelText(
      `Начало — ваше местное время (${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
    ),
  ).toBeVisible();
  await user.selectOptions(screen.getByLabelText('Корт'), input.courtId);
  await user.type(screen.getByLabelText(/^Начало — ваше местное время/), '2030-01-01T15:00');
  await screen.findByRole('option', { name: 'Synthetic subscription' });
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Выберите подписку' }),
    input.subscriptionId,
  );
  await user.click(screen.getByRole('button', { name: 'Создать игру по подписке' }));
  await screen.findByText('Создание игры подтверждено.');
  expect(
    screen.getByText('Игра ещё загружается в каталог. Повторно создавать её не нужно.'),
  ).toBeVisible();
  expect(screen.getByText('Текущий статус участия пока не подтверждён.')).toBeVisible();
  expect(screen.getByText(new RegExp('Начало — ваше местное время'))).toBeVisible();
  expect(h.g.createQuarterGame).toHaveBeenCalledOnce();
  expect(h.g.createQuarterGame).toHaveBeenCalledWith(
    {
      stationId: input.stationId,
      courtId: input.courtId,
      subscriptionId: input.subscriptionId,
      startsAt: new Date('2030-01-01T15:00').toISOString(),
    },
    expect.any(String),
  );
  expect(screen.queryByRole('button', { name: 'Создать другую игру' })).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Продолжить исходную операцию' }),
  ).not.toBeInTheDocument();
});
it('reload reads custody only and storage-denied fails closed without mutating HTTP', async () => {
  const h = setup();
  localStorage.setItem(
    quarterStorageKey(principal),
    JSON.stringify({ version: 1, ...principal, key: 'synthetic-quarter-original', request: input }),
  );
  const mounted = render(
    <QuarterCreatePanel
      gateway={h.gateway}
      principal={principal}
      attemptStorage={localStorage}
      attemptLockManager={locks}
    />,
  );
  await screen.findByText('Создание игры подтверждено.');
  expect(h.g.createQuarterGame).not.toHaveBeenCalled();
  expect(h.g.reconcileQuarterCreateOperation).not.toHaveBeenCalled();
  mounted.unmount();
  const denied = {
    getItem: () => {
      throw new Error('denied');
    },
  } as unknown as Storage;
  render(
    <QuarterCreatePanel
      gateway={h.gateway}
      principal={principal}
      attemptStorage={denied}
      attemptLockManager={locks}
    />,
  );
  await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
  expect(screen.getByRole('button', { name: 'Создать игру по подписке' })).toBeDisabled();
  expect(h.g.createQuarterGame).not.toHaveBeenCalled();
});

it('late subscription read after principal logout is not shown or usable', async () => {
  const h = setup();
  let resolve!: (value: Awaited<ReturnType<typeof h.g.getHomeDashboard>>) => void;
  h.g.getHomeDashboard.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(
    <QuarterCreatePanel
      gateway={h.gateway}
      principal={principal}
      attemptStorage={localStorage}
      attemptLockManager={locks}
    />,
  );
  await waitFor(() => expect(h.g.getHomeDashboard).toHaveBeenCalledOnce());
  Object.assign(h.g, { quarterCreatePrincipal: () => null });
  resolve({ subscriptions: [{ id: input.subscriptionId, title: 'Late private subscription' }] });
  await screen.findByText('Не удалось загрузить ваши подписки.');
  expect(screen.queryByText('Late private subscription')).not.toBeInTheDocument();
  expect(h.g.createQuarterGame).not.toHaveBeenCalled();
});
