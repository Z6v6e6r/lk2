// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/require-await -- React act async callbacks flush queued state. */
import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { TournamentChatPage, type TournamentChatGateway } from './TournamentChatPage.js';
import { TournamentChatCustody } from './tournament-chat-custody.js';
import type { TournamentChatReceipt } from '@phub/api-sdk';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tournamentId = id(1),
  principal = { tenantId: id(2), userId: id(3) };
const locks = { request: <T,>(_name: string, _options: unknown, cb: () => Promise<T>) => cb() };
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function setup() {
  let live = true;
  const gateway = {
    tournamentChatPrincipal: () => (live ? 'session-original' : null),
    sendTournamentChatMessage: vi.fn<TournamentChatGateway['sendTournamentChatMessage']>((tid, r) =>
      Promise.resolve({
        contractVersion: 'tournament-chat.v1',
        tournamentId: tid,
        requestId: r.requestId,
        status: 'UNKNOWN',
      }),
    ),
    getTournamentChatRequest: vi.fn<TournamentChatGateway['getTournamentChatRequest']>(
      (tid, requestId) =>
        Promise.resolve({
          contractVersion: 'tournament-chat.v1',
          tournamentId: tid,
          requestId,
          status: 'UNKNOWN',
        }),
    ),
    getTournamentChatHistory: vi.fn<TournamentChatGateway['getTournamentChatHistory']>(() =>
      Promise.resolve({
        contractVersion: 'tournament-chat.v1',
        tournamentId,
        streamId: null,
        throughSequence: 0,
        messages: [],
        hasMore: false,
        nextCursor: null,
      }),
    ),
  };
  return {
    gateway,
    retire: () => {
      live = false;
    },
    custody: new TournamentChatCustody(
      tournamentId,
      principal,
      localStorage,
      locks,
      () => live,
      webcrypto as unknown as Crypto,
    ),
  };
}
async function send(text: string) {
  fireEvent.change(await screen.findByRole('textbox', { name: 'Сообщение' }), {
    target: { value: text },
  });
  const button = screen.getByRole('button', { name: 'Отправить' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await screen.findByText('Не удалось подтвердить отправку. Проверьте статус сообщения.');
  await waitFor(() => expect(button).toBeEnabled());
}
it('actual handler retains old edited custody; reload only GET and no persistent text', async () => {
  const x = setup();
  const view = render(
    <TournamentChatPage tournamentId={tournamentId} principal={principal} gateway={x.gateway} />,
  );
  await send('original body');
  await send('edited body');
  await send('original body');
  const calls = x.gateway.sendTournamentChatMessage.mock.calls;
  expect(calls[0]![1].requestId).toBe(calls[2]![1].requestId);
  expect(calls[1]![1].requestId).not.toBe(calls[0]![1].requestId);
  expect(JSON.stringify(localStorage)).not.toContain('original body');
  view.unmount();
  render(
    <TournamentChatPage tournamentId={tournamentId} principal={principal} gateway={x.gateway} />,
  );
  await waitFor(() => expect(x.gateway.getTournamentChatRequest).toHaveBeenCalledTimes(2));
  expect(x.gateway.sendTournamentChatMessage).toHaveBeenCalledTimes(3);
  expect(await screen.findByRole('textbox', { name: 'Сообщение' })).toHaveValue('');
  expect(x.custody.pending()).toHaveLength(2);
});
it('current ACL denial hides cached body and draft but keeps original metadata', async () => {
  const x = setup();
  x.gateway.getTournamentChatHistory.mockResolvedValueOnce({
    contractVersion: 'tournament-chat.v1',
    tournamentId,
    streamId: id(4),
    throughSequence: 1,
    messages: [
      {
        messageId: id(5),
        authorUserId: principal.userId,
        sequence: 1,
        text: 'private cached message',
        acceptedAt: '2026-11-01T00:00:00.000Z',
      },
    ],
    hasMore: false,
    nextCursor: null,
  });
  render(
    <TournamentChatPage tournamentId={tournamentId} principal={principal} gateway={x.gateway} />,
  );
  await screen.findByText('private cached message');
  await send('original body');
  x.gateway.getTournamentChatRequest.mockRejectedValueOnce({ status: 403 });
  fireEvent.click(screen.getByRole('button', { name: 'Проверить статус' }));
  await waitFor(() => expect(screen.queryByText('private cached message')).not.toBeInTheDocument());
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(x.custody.pending()).toHaveLength(1);
  expect(x.gateway.sendTournamentChatMessage).toHaveBeenCalledTimes(1);
});
it('late confirmed ACK cannot clear newer draft; logout cannot consume original metadata', async () => {
  const x = setup();
  let finish!: (r: TournamentChatReceipt) => void;
  x.gateway.sendTournamentChatMessage.mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  render(
    <TournamentChatPage tournamentId={tournamentId} principal={principal} gateway={x.gateway} />,
  );
  const box = await screen.findByRole('textbox', { name: 'Сообщение' });
  fireEvent.change(box, { target: { value: 'original' } });
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
  await waitFor(() => expect(x.gateway.sendTournamentChatMessage).toHaveBeenCalledOnce());
  fireEvent.change(box, { target: { value: 'newer draft' } });
  const original = x.custody.pending()[0]!;
  await act(async () => {
    finish({
      contractVersion: 'tournament-chat.v1',
      tournamentId,
      requestId: original.requestId,
      requestHash: original.requestHash,
      status: 'CONFIRMED',
      streamId: id(4),
      messageId: id(5),
      sequence: 1,
    });
  });
  expect(box).toHaveValue('newer draft');
  expect(x.custody.pending()).toHaveLength(0);
  x.gateway.sendTournamentChatMessage.mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
  await waitFor(() => expect(x.gateway.sendTournamentChatMessage).toHaveBeenCalledTimes(2));
  const next = x.custody.pending()[0]!;
  x.retire();
  await act(async () => {
    finish({
      contractVersion: 'tournament-chat.v1',
      tournamentId,
      requestId: next.requestId,
      requestHash: next.requestHash,
      status: 'CONFIRMED',
      streamId: id(4),
      messageId: id(6),
      sequence: 2,
    });
  });
  expect(
    new TournamentChatCustody(tournamentId, principal, localStorage, locks, () => true).pending(),
  ).toHaveLength(1);
});
it('history ACL denial fences older in-flight confirmed status without clearing custody', async () => {
  const x = setup(),
    original = await x.custody.original('pending');
  let finish!: (r: TournamentChatReceipt) => void;
  x.gateway.getTournamentChatRequest.mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  render(
    <TournamentChatPage tournamentId={tournamentId} principal={principal} gateway={x.gateway} />,
  );
  await screen.findByRole('textbox', { name: 'Сообщение' });
  await waitFor(() => expect(x.gateway.getTournamentChatRequest).toHaveBeenCalledOnce());
  x.gateway.getTournamentChatHistory.mockRejectedValueOnce({ status: 403 });
  fireEvent.click(screen.getByRole('button', { name: 'Обновить' }));
  await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
  await act(async () => {
    finish({
      contractVersion: 'tournament-chat.v1',
      tournamentId,
      requestId: original.requestId,
      requestHash: original.requestHash,
      status: 'CONFIRMED',
      streamId: id(4),
      messageId: id(5),
      sequence: 1,
    });
  });
  expect(x.custody.pending()).toHaveLength(1);
  expect(x.gateway.sendTournamentChatMessage).not.toHaveBeenCalled();
});
it('actual send never dispatches without durable local metadata when storage quota fails', async () => {
  const x = setup();
  render(
    <TournamentChatPage tournamentId={tournamentId} principal={principal} gateway={x.gateway} />,
  );
  const box = await screen.findByRole('textbox', { name: 'Сообщение' });
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('QuotaExceededError');
  });
  try {
    fireEvent.change(box, { target: { value: 'retain draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await screen.findByText('Не удалось подтвердить состояние чата. Проверьте статус сообщения.');
    expect(x.gateway.sendTournamentChatMessage).not.toHaveBeenCalled();
    expect(box).toHaveValue('retain draft');
  } finally {
    write.mockRestore();
  }
});

async function tick(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}
async function pollingView() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const x = setup();
  const view = render(
    <TournamentChatPage tournamentId={tournamentId} principal={principal} gateway={x.gateway} />,
  );
  await act(async () => {});
  expect(x.gateway.getTournamentChatHistory).toHaveBeenCalledTimes(1);
  return { ...x, view };
}
it('updates an idle visible chat with GET only and stops after unmount', async () => {
  const x = await pollingView();
  x.gateway.getTournamentChatHistory.mockResolvedValueOnce({
    contractVersion: 'tournament-chat.v1',
    tournamentId,
    streamId: id(4),
    throughSequence: 1,
    messages: [
      {
        messageId: id(5),
        authorUserId: id(6),
        sequence: 1,
        text: 'new incoming message',
        acceptedAt: '2026-11-01T00:00:00.000Z',
      },
    ],
    hasMore: false,
    nextCursor: null,
  });
  await tick(10_000);
  expect(screen.getByText('new incoming message')).toBeInTheDocument();
  expect(x.gateway.getTournamentChatHistory).toHaveBeenCalledTimes(2);
  expect(x.gateway.sendTournamentChatMessage).not.toHaveBeenCalled();
  expect(x.gateway.getTournamentChatRequest).not.toHaveBeenCalled();
  x.view.unmount();
  await tick(120_000);
  expect(x.gateway.getTournamentChatHistory).toHaveBeenCalledTimes(2);
});
it('pauses hidden/offline polling and stops after principal retirement', async () => {
  const x = await pollingView();
  const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await tick(30_000);
  expect(x.gateway.getTournamentChatHistory).toHaveBeenCalledTimes(1);
  visible.mockReturnValue('visible');
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  await tick(20_000);
  expect(x.gateway.getTournamentChatHistory).toHaveBeenCalledTimes(1);
  online.mockReturnValue(true);
  await tick(10_000);
  expect(x.gateway.getTournamentChatHistory).toHaveBeenCalledTimes(2);
  x.retire();
  await tick(120_000);
  expect(x.gateway.getTournamentChatHistory).toHaveBeenCalledTimes(2);
});
it('does not overlap slow refresh or queue focus/online/visibility storms', async () => {
  const x = await pollingView();
  let finish!: () => void;
  x.gateway.getTournamentChatHistory.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({
            contractVersion: 'tournament-chat.v1',
            tournamentId,
            streamId: null,
            throughSequence: 0,
            messages: [],
            hasMore: false,
            nextCursor: null,
          });
      }),
  );
  await tick(10_000);
  for (let i = 0; i < 20; i++) {
    fireEvent.focus(window);
    fireEvent.online(window);
    fireEvent(document, new Event('visibilitychange'));
  }
  await tick(60_000);
  expect(x.gateway.getTournamentChatHistory).toHaveBeenCalledTimes(2);
  await act(async () => {
    finish();
  });
  expect(x.gateway.getTournamentChatHistory).toHaveBeenCalledTimes(2);
  await tick(10_000);
  expect(x.gateway.getTournamentChatHistory).toHaveBeenCalledTimes(3);
});
it('backs off rate limits and network failures without reconnect bypass', async () => {
  const x = await pollingView();
  x.gateway.getTournamentChatHistory.mockRejectedValueOnce({ status: 429 });
  await tick(10_000);
  for (let i = 0; i < 10; i++) fireEvent.focus(window);
  await tick(59_999);
  expect(x.gateway.getTournamentChatHistory).toHaveBeenCalledTimes(2);
  await tick(1);
  expect(x.gateway.getTournamentChatHistory).toHaveBeenCalledTimes(3);
  x.gateway.getTournamentChatHistory.mockRejectedValueOnce(new Error('timeout'));
  await tick(10_000);
  await tick(19_999);
  expect(x.gateway.getTournamentChatHistory).toHaveBeenCalledTimes(4);
  await tick(1);
  expect(x.gateway.getTournamentChatHistory).toHaveBeenCalledTimes(5);
});
it('stops automatic retries after ACL denial and requires explicit refresh', async () => {
  const x = await pollingView();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'private draft' } });
  x.gateway.getTournamentChatHistory.mockRejectedValueOnce({ status: 403 });
  await tick(10_000);
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  await tick(120_000);
  fireEvent.focus(window);
  expect(x.gateway.getTournamentChatHistory).toHaveBeenCalledTimes(2);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Обновить' }));
  });
  expect(x.gateway.getTournamentChatHistory).toHaveBeenCalledTimes(3);
  expect(screen.getByRole('textbox')).toHaveValue('');
});
it('discards late automatic history after logout', async () => {
  const x = await pollingView();
  let finish!: () => void;
  x.gateway.getTournamentChatHistory.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({
            contractVersion: 'tournament-chat.v1',
            tournamentId,
            streamId: id(4),
            throughSequence: 1,
            messages: [
              {
                messageId: id(5),
                authorUserId: id(6),
                sequence: 1,
                text: 'late private body',
                acceptedAt: '2026-11-01T00:00:00.000Z',
              },
            ],
            hasMore: false,
            nextCursor: null,
          });
      }),
  );
  await tick(10_000);
  x.retire();
  await act(async () => {
    finish();
  });
  expect(screen.queryByText('late private body')).not.toBeInTheDocument();
  await tick(120_000);
  expect(x.gateway.getTournamentChatHistory).toHaveBeenCalledTimes(2);
});
