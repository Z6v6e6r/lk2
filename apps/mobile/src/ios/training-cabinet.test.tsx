// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type * as CapacitorCore from '@capacitor/core';
import { IOSAuthApp } from './IOSAuthApp.js';
import {
  fixtureReply,
  homeDashboard,
  nativeResult,
  syntheticSession,
} from './testing/cabinet-fixtures.js';
import type { IOSSessionPlugin } from './session.js';
vi.mock('@capacitor/core', async (importOriginal) => {
  const original = await importOriginal<typeof CapacitorCore>();
  return {
    ...original,
    registerPlugin: (name: string) =>
      name === 'PadlHubIOSPush'
        ? {
            status: () =>
              Promise.resolve({
                configured: false,
                installationId: 'synthetic-installation',
                pendingRevoke: false,
                state: 'unsupported',
              }),
            suspend: () =>
              Promise.resolve({ installationId: 'synthetic-installation', pendingRevoke: false }),
            takeOpened: () => Promise.resolve({}),
            addListener: () => Promise.resolve({ remove: () => Promise.resolve() }),
          }
        : original.registerPlugin(name),
  };
});
const id = '11111111-1111-4111-8111-111111111111',
  sub = '22222222-2222-4222-8222-222222222222',
  op = '33333333-3333-4333-8333-333333333333';
const activity = {
  id,
  kind: 'TRAINING',
  title: 'Synthetic native training',
  startsAt: '2035-04-02T12:00:00Z',
  endsAt: '2035-04-02T14:00:00Z',
  timezone: 'Europe/Moscow',
  station: { id: sub, name: 'Synthetic station', shortAddress: 'Synthetic address' },
  court: { id: op, name: 'Synthetic court' },
  category: null,
  levelRange: null,
  capacity: { total: 4, open: 1 },
  host: { displayName: 'Synthetic coach', avatarUrl: null, role: 'TRAINER' },
  route: `/trainings?event=${id}`,
};
function fixture() {
  let confirmed = false;
  const request = vi.fn<IOSSessionPlugin['request']>(async (input) => {
    await Promise.resolve();
    if (input.operation === 'read' && input.resource === 'home')
      return nativeResult({
        ...homeDashboard,
        subscriptions: [{ id: sub, title: 'Synthetic subscription' }],
      });
    if (input.operation !== 'training') return fixtureReply(input);
    if (input.resource === 'catalog')
      return nativeResult({
        state: 'READY',
        snapshotVersion: 'a'.repeat(64),
        generatedAt: '2035-04-01T10:00:00.000Z',
        staleAt: '2035-04-01T10:01:00.000Z',
        items: [{ kind: 'GROUP_TRAINING', activity }],
        nextCursor: null,
        sourceStatus: [{ source: 'SCHEDULE', localDate: null, state: 'READY', errorCode: null }],
        totalMatched: 1,
        facets: {
          kinds: [{ kind: 'GROUP_TRAINING', count: 1 }],
          categories: [],
          stations: [{ id: sub, name: 'Synthetic station', count: 1 }],
        },
      });
    return nativeResult({
      trainingId: id,
      subscriptionId: sub,
      dateHint: '2035-04-02',
      operation: { id: op, status: confirmed ? 'CONFIRMED' : 'UNKNOWN' },
      registration: {
        status: confirmed ? 'CONFIRMED' : 'UNKNOWN',
        asOf: confirmed ? '2035-04-01T12:00:00.000Z' : null,
      },
      retryAfterSeconds: confirmed ? null : 15,
    });
  });
  return {
    request,
    confirm: () => {
      confirmed = true;
    },
  };
}
beforeAll(async () => {
  await import('./IOSCabinet.js');
});
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('scrollTo', vi.fn());
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_n: string, _o: unknown, callback: () => Promise<unknown>) =>
        await callback(),
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function open(request: IOSSessionPlugin['request']) {
  const session = syntheticSession(request);
  await session.restore();
  render(<IOSAuthApp session={session} />);
  fireEvent.click(await screen.findByRole('link', { name: 'Тренировки' }));
  await screen.findByText(activity.title);
  // The current catalogue card is the entry to the existing bounded registration panel.
  fireEvent.click(screen.getByRole('button', { name: 'Запись по подписке' }));
  await screen.findByRole('heading', { name: activity.title, level: 2 });
  return session;
}
it('actual cabinet → subscription → UNKNOWN → cold session restore → GET-only confirmation', async () => {
  const f = fixture();
  await open(f.request);
  await screen.findByRole('option', { name: 'Synthetic subscription' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Выберите подписку' }), {
    target: { value: sub },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Записаться по подписке' }));
  await screen.findByText('Текущая запись не подтверждена. Проверка не создаёт новую запись.');
  const original = f.request.mock.calls.find(([v]) => v.resource === 'register')![0];
  expect(original.body).toBe(JSON.stringify({ dateHint: '2035-04-02', subscriptionId: sub }));
  expect(original.headers['idempotency-key']).toBeTruthy();
  cleanup();
  await open(f.request);
  await screen.findByText('Текущая запись не подтверждена. Проверка не создаёт новую запись.');
  expect(f.request.mock.calls.filter(([v]) => v.resource === 'register')).toHaveLength(1);
  f.confirm();
  fireEvent.click(screen.getByRole('button', { name: 'Проверить запись' }));
  await screen.findByText('Запись подтверждена по последней проверке.');
  const reads = f.request.mock.calls.filter(([v]) => v.resource === 'status');
  expect(reads.length).toBeGreaterThan(0);
  for (const [v] of reads)
    expect(v.headers['idempotency-key']).toBe(original.headers['idempotency-key']);
  expect(f.request.mock.calls.filter(([v]) => v.resource === 'register')).toHaveLength(1);
});
it.each(['locks', 'storage'] as const)(
  'missing %s never dispatches a training write',
  async (missing) => {
    if (missing === 'locks')
      Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    else
      vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });
    const f = fixture();
    await open(f.request);
    await screen.findByRole('option', { name: 'Synthetic subscription' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Выберите подписку' }), {
      target: { value: sub },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Записаться по подписке' }));
    await screen.findByRole('alert');
    expect(f.request.mock.calls.filter(([v]) => v.resource === 'register')).toHaveLength(0);
  },
);
it('logout before selecting subscription prevents dispatch from the retained panel', async () => {
  const f = fixture();
  const session = await open(f.request);
  await screen.findByRole('option', { name: 'Synthetic subscription' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Выберите подписку' }), {
    target: { value: sub },
  });
  act(() => session.closeQuarterCreate());
  fireEvent.click(screen.getByRole('button', { name: 'Записаться по подписке' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
  expect(f.request.mock.calls.filter(([v]) => v.resource === 'register')).toHaveLength(0);
});
