// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IOSChats } from './IOSChats.js';
import { chatFixture, directId, gameChatId } from './testing/chat-fixtures.js';
import { nativeResult, syntheticSession, viewerId } from './testing/cabinet-fixtures.js';
import type { IOSSessionPlugin } from './session.js';

class Socket extends EventTarget {
  static OPEN = 1;
  static sockets: Socket[] = [];
  readonly sent: string[] = [];
  readyState = 0;
  constructor(readonly url: string) {
    super();
    Socket.sockets.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
  }
}
beforeEach(() => {
  Socket.sockets = [];
  vi.stubGlobal('WebSocket', Socket);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function setup(
  conversationId = directId,
  override?: (
    input: Parameters<IOSSessionPlugin['request']>[0],
  ) => ReturnType<typeof nativeResult> | undefined,
) {
  const fixture = chatFixture();
  const request = vi.fn<IOSSessionPlugin['request']>(
    async (input) => await Promise.resolve(override?.(input) ?? fixture.reply(input)),
  );
  const session = syntheticSession(request);
  await session.restore();
  return {
    ...render(<IOSChats session={session} userId={viewerId} conversationId={conversationId} />),
    request,
    fixture,
    session,
  };
}
describe('iOS existing chat consumer', () => {
  it('renders a recoverable history error with the shared chat banner and an operable refresh button', async () => {
    let unavailable = true;
    await setup(directId, (input) =>
      input.resource === 'conversationMessages' && unavailable
        ? nativeResult({ code: 'UNAVAILABLE' }, 503)
        : undefined,
    );
    const alert = await screen.findByRole('alert');
    expect(alert.className).toContain('errorBanner');
    const refresh = within(alert).getByRole('button', { name: 'Обновить' });
    refresh.focus();
    expect(refresh).toHaveFocus();
    unavailable = false;
    fireEvent.click(refresh);
    await screen.findByText('До встречи на корте!');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('renders the shared thread with text send, accessible navigation and no CREATE/attachment controls', async () => {
    const { request } = await setup();
    await screen.findByText('До встречи на корте!');
    const input = screen.getByRole('textbox', { name: 'Сообщение' });
    input.focus();
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: 'Ответ с iOS' } });
    fireEvent.submit(input.closest('form')!);
    await screen.findByText('Ответ с iOS');
    expect(request.mock.calls.some(([entry]) => entry.resource === 'sendMessage')).toBe(true);
    expect(screen.queryByRole('link', { name: 'Создать игру' })).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(screen.getByRole('link', { name: 'Назад к чатам' })).toHaveAttribute('href', '/chats');
  });
  it('opens realtime only after history, sends ticket in first frame and obtains a fresh ticket after reconnect', async () => {
    const { request, unmount } = await setup(gameChatId);
    await waitFor(() => expect(Socket.sockets).toHaveLength(1));
    const first = Socket.sockets[0]!;
    expect(first.url).toBe('wss://lk2.padlhub.su/realtime/v1/local-padel');
    act(() => {
      first.open();
      first.message({ type: 'connection.ready' });
    });
    expect(JSON.parse(first.sent[0]!)).toMatchObject({
      type: 'authenticate',
      ticket: 'synthetic-ticket-1',
    });
    expect(JSON.parse(first.sent[1]!)).toMatchObject({
      type: 'conversation.subscribe',
      conversationId: gameChatId,
      afterSequence: 1,
    });
    const before = request.mock.calls.filter(
      ([input]) => input.resource === 'conversationMessages',
    ).length;
    vi.useFakeTimers();
    await act(async () => {
      first.close();
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(Socket.sockets).toHaveLength(2);
    act(() => Socket.sockets[1]!.open());
    expect(JSON.parse(Socket.sockets[1]!.sent[0]!)).toMatchObject({ ticket: 'synthetic-ticket-2' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(
      request.mock.calls.filter(([input]) => input.resource === 'conversationMessages').length,
    ).toBeGreaterThan(before);
    unmount();
    expect(Socket.sockets[1]!.readyState).toBe(3);
    const requests = request.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(request).toHaveBeenCalledTimes(requests);
  });
  it('keeps realtime and composer closed after a forbidden initial history', async () => {
    await setup(directId, (input) =>
      input.resource === 'conversationMessages'
        ? nativeResult({ code: 'CONVERSATION_NOT_FOUND' }, 404)
        : undefined,
    );
    await screen.findByText('Этот чат недоступен для вашей учётной записи.');
    expect(Socket.sockets).toHaveLength(0);
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toBeDisabled();
  });
  it('never fetches protected media through browser transport', async () => {
    const browserFetch = vi.fn();
    vi.stubGlobal('fetch', browserFetch);
    await setup(directId, (input) =>
      input.resource === 'conversationMessages'
        ? nativeResult({
            messages: [
              {
                id: viewerId,
                conversationId: directId,
                sequence: 1,
                sender: { userId: viewerId, displayName: 'Тест' },
                messageType: 'IMAGE',
                body: '',
                createdAt: '2026-10-31T09:00:00Z',
                attachments: [
                  {
                    mediaId: gameChatId,
                    mediaType: 'IMAGE',
                    fileName: 'fixture.png',
                    contentType: 'image/png',
                    byteSize: 100,
                  },
                ],
              },
            ],
          })
        : undefined,
    );
    await screen.findByText('Изображение недоступно');
    expect(browserFetch).not.toHaveBeenCalled();
  });
});
