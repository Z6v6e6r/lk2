// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/require-await -- Synthetic async UI boundaries. */
import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { TournamentChatPage, type TournamentChatGateway } from './TournamentChatPage.js';
import {
  tournamentChatReadHash,
  parseTournamentChatCursor,
  type TournamentChatReadReceipt,
} from '@phub/api-sdk';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tid = id(1),
  principal = { tenantId: id(2), userId: id(3) },
  stream = id(4),
  witnessHash = 'a'.repeat(64);
const locks = { request: <T,>(_n: string, _o: unknown, cb: () => Promise<T>) => cb() };
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(total = 3) {
  let live = true;
  const position = {
    contractVersion: 'tournament-chat-read.v1' as const,
    tournamentId: tid,
    streamId: stream,
    witnessHash,
    baselineSequence: 0,
    readThroughSequence: 0,
    publishedSequence: total,
  };
  const gateway = {
    tournamentChatPrincipal: () => (live ? 'original-session' : null),
    sendTournamentChatMessage: vi.fn<TournamentChatGateway['sendTournamentChatMessage']>(),
    getTournamentChatRequest: vi.fn<TournamentChatGateway['getTournamentChatRequest']>(),
    getTournamentChatHistory: vi.fn<TournamentChatGateway['getTournamentChatHistory']>(
      async (_id, limit = 50, cursor) => {
        const before = cursor ? parseTournamentChatCursor(cursor).before : total + 1;
        const last = Math.max(1, before - limit),
          messages = Array.from({ length: before - last }, (_, i) => ({
            messageId: id(100 + before - i - 1),
            authorUserId: principal.userId,
            text: 'private ' + (before - i - 1),
            sequence: before - i - 1,
            acceptedAt: '2026-11-01T00:00:00.000Z',
          }));
        return {
          contractVersion: 'tournament-chat.v1',
          tournamentId: tid,
          streamId: stream,
          throughSequence: total,
          messages,
          hasMore: last > 1,
          nextCursor:
            last > 1
              ? Buffer.from(
                  JSON.stringify({
                    v: 1,
                    tenantId: principal.tenantId,
                    tournamentId: tid,
                    actorUserId: principal.userId,
                    streamId: stream,
                    witnessHash,
                    through: total,
                    before: last,
                  }),
                ).toString('base64url')
              : null,
        };
      },
    ),
    getTournamentChatReadPosition: vi.fn(async () => ({ ...position })),
    advanceTournamentChatRead: vi.fn<
      NonNullable<TournamentChatGateway['advanceTournamentChatRead']>
    >(async (_id, x) => ({
      contractVersion: 'tournament-chat-read.v1',
      tournamentId: tid,
      requestId: x.requestId,
      status: 'UNKNOWN',
    })),
    getTournamentChatReadRequest: vi.fn<
      NonNullable<TournamentChatGateway['getTournamentChatReadRequest']>
    >(async (_id, requestId) => ({
      contractVersion: 'tournament-chat-read.v1',
      tournamentId: tid,
      requestId,
      status: 'UNKNOWN',
    })),
  };
  return {
    gateway,
    position,
    retire: () => {
      live = false;
    },
    mount: () =>
      render(<TournamentChatPage tournamentId={tid} principal={principal} gateway={gateway} />),
  };
}
it('actual explicit READ handler retains original and reload recovers only by GET', async () => {
  const f = setup(),
    view = f.mount();
  const button = await screen.findByRole('button', { name: 'Отметить прочитанным' });
  await waitFor(() => expect(button).toBeEnabled());
  expect(f.gateway.advanceTournamentChatRead).not.toHaveBeenCalled();
  fireEvent.click(button);
  await screen.findByText('Отметка пока не подтверждена. Проверьте её статус.');
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(f.gateway.advanceTournamentChatRead).toHaveBeenCalledTimes(2));
  expect(f.gateway.advanceTournamentChatRead.mock.calls[0]![1]).toEqual(
    f.gateway.advanceTournamentChatRead.mock.calls[1]![1],
  );
  view.unmount();
  f.mount();
  await waitFor(() => expect(f.gateway.getTournamentChatReadRequest).toHaveBeenCalledTimes(1));
  expect(f.gateway.advanceTournamentChatRead).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(localStorage)).not.toContain('private');
});
it('actual UI refuses latest50 shortcut until missing unread prefix is loaded', async () => {
  const f = setup(60);
  f.mount();
  await screen.findByText('private 60');
  const button = screen.getByRole('button', { name: 'Отметить прочитанным' });
  expect(button).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Более ранние сообщения' }));
  await screen.findByText('private 1');
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() =>
    expect(f.gateway.advanceTournamentChatRead).toHaveBeenCalledWith(
      tid,
      expect.objectContaining({ throughSequence: 60 }),
    ),
  );
});
it('late logout ACK cannot clear original READ custody or render confirmation', async () => {
  const f = setup();
  let resolve!: (r: TournamentChatReadReceipt) => void;
  f.gateway.advanceTournamentChatRead.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  f.mount();
  const button = screen.getByRole('button', { name: 'Отметить прочитанным' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(f.gateway.advanceTournamentChatRead).toHaveBeenCalledTimes(1));
  const x = f.gateway.advanceTournamentChatRead.mock.calls[0]![1],
    requestHash = await tournamentChatReadHash(tid, x, webcrypto as unknown as Crypto);
  f.retire();
  await act(async () =>
    resolve({
      contractVersion: 'tournament-chat-read.v1',
      tournamentId: tid,
      requestId: x.requestId,
      status: 'CONFIRMED',
      requestHash,
      streamId: stream,
      witnessHash,
      baselineSequence: 0,
      throughSequence: 3,
      readThroughSequence: 3,
    }),
  );
  expect(JSON.stringify(localStorage)).toContain(x.requestId);
  expect(screen.queryByText('Отметка о прочтении сохранена.')).not.toBeInTheDocument();
});
it('current ACL denial clears cached body/read state and retains only original metadata', async () => {
  const f = setup();
  f.mount();
  const button = screen.getByRole('button', { name: 'Отметить прочитанным' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await screen.findByText('Отметка пока не подтверждена. Проверьте её статус.');
  f.gateway.getTournamentChatReadPosition.mockRejectedValue({ status: 403 });
  fireEvent.click(screen.getByRole('button', { name: 'Обновить' }));
  await waitFor(() => expect(screen.queryByText('private 3')).not.toBeInTheDocument());
  expect(button).toBeDisabled();
  expect(JSON.stringify(localStorage)).toContain('requestHash');
  expect(f.gateway.advanceTournamentChatRead).toHaveBeenCalledTimes(1);
});
it('witness change across history read clears old authorized state instead of marking a new context', async () => {
  const f = setup();
  f.gateway.getTournamentChatReadPosition
    .mockResolvedValueOnce({ ...f.position })
    .mockResolvedValue({ ...f.position, witnessHash: 'b'.repeat(64) });
  f.mount();
  await screen.findByText('Не удалось загрузить все новые сообщения. Откройте историю заново.');
  expect(screen.queryByText('private 3')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Отметить прочитанным' })).toBeDisabled();
  expect(f.gateway.advanceTournamentChatRead).not.toHaveBeenCalled();
});
