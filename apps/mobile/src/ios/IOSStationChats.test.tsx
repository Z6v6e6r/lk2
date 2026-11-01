// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IOSStationChats } from './IOSStationChats.js';
import { syntheticSession, fixtureReply, nativeResult, auth } from './testing/cabinet-fixtures.js';
import type { IOSSessionPlugin } from './session.js';
const community = '22222222-2222-4222-8222-222222222222';
const message = '33333333-3333-8333-8333-333333333333';
const row = {
  id: message,
  body: 'Original station history',
  sentAt: '2026-11-01T00:00:00.000Z',
  author: { displayName: 'Player' },
  isViewer: true,
};
const unknown = (requestId: string) => ({
  contractVersion: 1,
  contract: 'station-message',
  requestId,
  outcome: 'UNKNOWN',
  code: 'MESSAGE_RECEIPT_UNPROVEN',
});
function reply(input: Parameters<IOSSessionPlugin['request']>[0]) {
  if (input.operation === 'context')
    return nativeResult({
      user: { id: auth.user.id },
      tenant: { id: auth.context.tenantId, key: 'local-padel' },
      roles: [],
      permissions: [],
      runtimeCapabilities: { communityDirectory: true, communityReadChat: true },
    });
  if (input.operation === 'read' && input.resource === 'communities')
    return nativeResult({
      items: [
        {
          id: community,
          title: 'Official station',
          logoUrl: null,
          isVerified: true,
          unreadChatCount: 0,
          route: '/communities/' + community,
        },
      ],
    });
  if (input.operation === 'stationMessage')
    return nativeResult(
      input.resource === 'history'
        ? { items: [row], canRequestStationMessage: true }
        : unknown(input.requestId!),
    );
  return fixtureReply(input);
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function open(
  request = vi.fn<IOSSessionPlugin['request']>(
    async (input) => await Promise.resolve(reply(input)),
  ),
) {
  const session = syntheticSession(request);
  await session.restore();
  const view = render(<IOSStationChats session={session} />);
  fireEvent.click(await screen.findByRole('button', { name: /Official station/ }));
  await screen.findByText(row.body);
  return { session, view, request };
}
it('actual iOS SDK/bridge sends once and restores only original status after remount/session storage loss', async () => {
  const { session, view, request } = await open();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'private text' } });
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
  await waitFor(() =>
    expect(request.mock.calls.filter(([v]) => v.resource === 'send')).toHaveLength(1),
  );
  const command = request.mock.calls.find(([v]) => v.resource === 'send')![0];
  await screen.findByText(/Ожидают подтверждения: 1/);
  expect(Object.values(localStorage).join()).not.toContain('private text');
  view.unmount();
  sessionStorage.clear();
  render(<IOSStationChats session={session} />);
  fireEvent.click(await screen.findByRole('button', { name: /Official station/ }));
  await waitFor(() =>
    expect(
      request.mock.calls.some(
        ([v]) => v.resource === 'status' && v.requestId === command.requestId,
      ),
    ).toBe(true),
  );
  expect(request.mock.calls.filter(([v]) => v.resource === 'send')).toHaveLength(1);
});
it('current server capability false never exposes send and synchronous logout clears visible history', async () => {
  const request = vi.fn<IOSSessionPlugin['request']>(
    async (input) =>
      await Promise.resolve(
        input.operation === 'stationMessage' && input.resource === 'history'
          ? nativeResult({ items: [row], canRequestStationMessage: false })
          : reply(input),
      ),
  );
  const { session } = await open(request);
  expect(screen.queryByRole('textbox')).toBeNull();
  act(() => session.closeQuarterCreate());
  expect(screen.queryByText(row.body)).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
});
it.each([403, 404, 503])(
  'read status %i preserves original metadata and never repeats POST',
  async (status) => {
    let statusReads = false;
    const request = vi.fn<IOSSessionPlugin['request']>(
      async (input) =>
        await Promise.resolve(
          input.operation === 'stationMessage' && input.resource === 'status' && statusReads
            ? nativeResult({}, status)
            : reply(input),
        ),
    );
    await open(request);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unconfirmed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await screen.findByText(/Ожидают подтверждения: 1/);
    const before = Object.values(localStorage).join();
    statusReads = true;
    fireEvent.click(screen.getByRole('button', { name: 'Проверить статус' }));
    await waitFor(() =>
      expect(request.mock.calls.some(([v]) => v.resource === 'status')).toBe(true),
    );
    expect(Object.values(localStorage).join()).toBe(before);
    expect(request.mock.calls.filter(([v]) => v.resource === 'send')).toHaveLength(1);
    if (status !== 503) await waitFor(() => expect(screen.queryByText(row.body)).toBeNull());
  },
);
it('confirmed ACK wins an older pending history read without losing original receipt binding', async () => {
  let finish!: (v: ReturnType<typeof nativeResult>) => void;
  let reads = 0;
  const request = vi.fn<IOSSessionPlugin['request']>(async (input) => {
    if (input.resource === 'history' && ++reads === 2)
      return await new Promise((resolve) => {
        finish = resolve;
      });
    if (input.resource === 'send')
      return nativeResult({
        contractVersion: 1,
        contract: 'station-message',
        requestId: input.requestId,
        outcome: 'CONFIRMED',
        message: { ...row, id: '44444444-4444-8444-8444-444444444444', body: 'new text' },
      });
    return reply(input);
  });
  await open(request);
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(reads).toBe(2));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new text' } });
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
  await screen.findByText('new text');
  await act(async () => {
    finish(nativeResult({ items: [row], canRequestStationMessage: true }));
    await Promise.resolve();
  });
  expect(screen.getByText('new text')).toBeVisible();
  expect(Object.values(localStorage).join()).toBe('[]');
});
