// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { App } from '../../web/src/App.js';
import { createBrowserAuthGateway } from '../../web/src/auth-gateway.js';
import {
  quarterStorageKey,
  quarterOperationId,
  quarterDraftId,
  type QuarterCustody,
} from '../../web/src/quarter-create-attempt.js';
import { createNativeApiFetch, type AndroidSessionPlugin } from './native-api-fetch.js';
import { auth, config, homeDashboard } from './ios/testing/cabinet-fixtures.js';
vi.mock('../../web/src/chat-realtime-client.js', () => ({
  connectChatRealtime: () => ({ stop: () => {} }),
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});
const principal = { tenantId: auth.context.tenantId, userId: auth.context.userId },
  id = '11111111-1111-4111-8111-111111111111';
async function setup(locks = true) {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('navigator', {
    ...navigator,
    locks: locks
      ? {
          request: async (_n: unknown, _o: unknown, fn: () => unknown) => {
            await Promise.resolve();
            return fn();
          },
        }
      : undefined,
  });
  let confirmed = false;
  const request = vi.fn<AndroidSessionPlugin['request']>(async (x) => {
    await Promise.resolve();
    let data: unknown;
    if (x.path.endsWith('/auth/session/refresh')) data = auth;
    else if (x.path.endsWith('/home'))
      data = { ...homeDashboard, subscriptions: [{ id, title: 'Тестовая подписка' }] };
    else if (x.path.endsWith('/capability')) data = { contractVersion: 1, available: true };
    else if (x.path.endsWith('/locations'))
      data = {
        items: [
          { stationId: id, courtId: id, stationTitle: 'Тестовая станция', courtName: 'Корт 1' },
        ],
      };
    else if (x.path.includes('/game-create-operations')) {
      const c = JSON.parse(localStorage.getItem(quarterStorageKey(principal))!) as QuarterCustody;
      expect(c).not.toBeNull();
      expect(x.headers['idempotency-key']).toBe(c.key);
      if (x.path.endsWith('/reconcile')) confirmed = true;
      const hash = Array.from(
        new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(c.key))),
      )
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('');
      data = {
        contractVersion: 1,
        request: c.request,
        keySha256: 'sha256:' + hash,
        operation: {
          id: await quarterOperationId(c),
          draftId: await quarterDraftId(c),
          status: confirmed ? 'CONFIRMED' : 'UNKNOWN',
        },
        gameProjection: { status: 'PENDING', gameId: null },
        registration: { status: 'UNKNOWN', asOf: null },
        reason: null,
      };
    } else return { status: 404, headers: {}, body: btoa('{}') };
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify(data), 'utf8').toString('base64'),
    };
  });
  const open = async () => {
    const gateway = createBrowserAuthGateway({
      baseUrl: config.apiBaseUrl,
      tenantKey: config.tenantKey,
      appVersion: 'test',
      platform: 'android',
      nativeSessionTransport: true,
      fetchImplementation: createNativeApiFetch(config, {
        request,
        configuration: () => Promise.resolve(config),
      }),
    });
    window.history.replaceState(null, '', '/games/new?quarterCreate=1');
    render(<App gateway={gateway} tenantKey={config.tenantKey} clientPlatform="android" />);
    await screen.findByRole('heading', { name: 'Игра по подписке' });
    return gateway;
  };
  await open();
  return { request, open };
}
async function fill() {
  await screen.findByRole('option', { name: 'Тестовая станция · Корт 1' });
  fireEvent.change(screen.getByLabelText('Корт'), { target: { value: id } });
  fireEvent.change(screen.getByLabelText(/Начало — ваше местное время/), {
    target: { value: '2030-01-01T12:00' },
  });
  await screen.findByRole('option', { name: 'Тестовая подписка' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Выберите подписку' }), {
    target: { value: id },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Создать игру по подписке' }));
}
it('actual Android App→gateway→SDK→bridge restores custody and only explicitly reconciles original', async () => {
  const h = await setup();
  await fill();
  await screen.findByText('Результат ещё неизвестен. Сохранён исходный запрос.');
  const original = localStorage.getItem(quarterStorageKey(principal));
  cleanup();
  await h.open();
  await screen.findByText('Результат ещё неизвестен. Сохранён исходный запрос.');
  expect(localStorage.getItem(quarterStorageKey(principal))).toBe(original);
  const creates = () =>
    h.request.mock.calls
      .map(([x]) => x)
      .filter((x) => x.path.endsWith('/game-create-operations') && x.method === 'POST');
  expect(creates()).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить исходную операцию' }));
  await screen.findByText('Создание игры подтверждено.');
  const retry = h.request.mock.calls.map(([x]) => x).find((x) => x.path.endsWith('/reconcile'))!;
  expect(retry.body).toBe(creates()[0]?.body);
  expect(retry.headers['idempotency-key']).toBe(creates()[0]?.headers['idempotency-key']);
  expect(creates()).toHaveLength(1);
});
it('actual Android native form with missing lock never writes custody or sends CREATE', async () => {
  const h = await setup(false);
  await fill();
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('Не удалось завершить проверку'),
  );
  expect(localStorage.getItem(quarterStorageKey(principal))).toBeNull();
  expect(
    h.request.mock.calls.filter(
      ([x]) => x.method === 'POST' && x.path.includes('/game-create-operations'),
    ),
  ).toHaveLength(0);
});
