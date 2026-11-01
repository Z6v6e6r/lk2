import { StationMessageCustody } from './station-message-custody.js';
// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import type { CommunityChatsSource } from '../ChatsPage.js';
import type { StationMessageReceipt } from '../auth-gateway.js';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StationStreamPage } from '@phub/api-sdk';
import { StationStreamThread, type StationStreamSource } from './StationStreamThread.js';
const id = '11111111-1111-4111-8111-111111111111';
const summary = {
  communityId: id,
  availability: 'AVAILABLE' as const,
  streamId: id,
  membershipEpoch: 1,
  baselineSequence: 0,
  readThroughSequence: 0,
  publishedThroughSequence: 2,
  unreadCount: 2,
};
const community = {
  id,
  title: 'Официальная станция',
  logoUrl: null,
  isVerified: true,
  unreadChatCount: 0,
  route: '/community',
};
function page(
  after = 0,
  through = 2,
  published = 2,
): Extract<StationStreamPage, { mode: 'STREAM' }> {
  return {
    historyVersion: 3,
    mode: 'STREAM',
    ...summary,
    publishedThroughSequence: published,
    unreadCount: published,
    afterSequence: after,
    throughSequence: through,
    items: Array.from({ length: Math.min(50, through - after) }, (_, i) => ({
      id: `${String(after + i + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
      body: `Сообщение ${after + i + 1}`,
      sentAt: '2026-11-01T10:00:00.000Z',
      author: { displayName: 'Игрок' },
      isViewer: false,
      sequence: after + i + 1,
    })),
    nextCursor: through - after > 50 ? `next_fixed_cursor_${after + 50}` : null,
    catchUpCursor: through - after > 50 ? null : 'catch_up_cursor_',
    olderCursor: after ? 'older_cursor____' : null,
    archiveCursor: after ? null : 'archive_cursor__',
    canRequestStationMessage: true,
  };
}
function setup() {
  let current = true;
  const read = vi.fn<StationStreamSource['read']>((_id, request) =>
    Promise.resolve({
      contractVersion: 1,
      contract: 'station-read',
      ...request,
      outcome: 'CONFIRMED',
      readThroughSequence: request.throughSequence,
    }),
  );
  const source: StationStreamSource = {
    scope: 'tenant:user',
    principal: 'epoch1',
    isCurrent: () => current,
    summaries: vi.fn(),
    page: vi.fn(() => Promise.resolve(page())),
    read,
    status: vi.fn(() => Promise.reject(new Error('unknown'))),
  };
  const chat = { loadCommunities: vi.fn(), stream: source };
  return {
    source,
    chat,
    read,
    logout: () => {
      current = false;
    },
    render: (position = summary) =>
      render(
        <StationStreamThread
          community={community}
          summary={position}
          source={source}
          chat={chat}
          onPosition={vi.fn()}
        />,
      ),
  };
}
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('explicit station stream read and catch-up', () => {
  it('initial GET never marks read; explicit displayed range persists before sole POST', async () => {
    const h = setup();
    h.render();
    await screen.findByText('Сообщение 2');
    expect(h.read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Отметить показанное прочитанным'));
    await waitFor(() => expect(h.read).toHaveBeenCalledOnce());
    expect(h.read.mock.calls[0]?.[1]).toMatchObject({
      streamId: id,
      membershipEpoch: 1,
      throughSequence: 2,
    });
    await screen.findByText(/Прочтение подтверждено/);
    expect(screen.getByText('Непрочитанных сообщений: 2')).toBeTruthy();
  });
  it('unknown original read reload recovers via GET only; manual retry retains same UUID', async () => {
    const h = setup();
    h.read.mockImplementation((_id, input) =>
      Promise.resolve({
        contractVersion: 1,
        contract: 'station-read',
        requestId: input.requestId,
        outcome: 'UNKNOWN',
        code: 'READ_RECEIPT_UNPROVEN',
      }),
    );
    const first = h.render();
    await screen.findByText('Сообщение 2');
    fireEvent.click(screen.getByText('Отметить показанное прочитанным'));
    await screen.findByText(/Прочтение пока не подтверждено/);
    const original = h.read.mock.calls[0]![1];
    first.unmount();
    h.render();
    await waitFor(() => expect(h.source.status).toHaveBeenCalledWith(id, original.requestId));
    await screen.findByText('Сообщение 2');
    fireEvent.click(screen.getByText('Проверить прочтение'));
    await waitFor(() => expect(h.source.status).toHaveBeenCalledTimes(2));
    expect(h.read).toHaveBeenCalledOnce();
  });
  it('latest window gap blocks read; earlier exact rows permit it', async () => {
    const h = setup();
    vi.mocked(h.source.page)
      .mockResolvedValueOnce(page(2, 4, 4))
      .mockResolvedValueOnce(page(0, 2, 4));
    h.render({ ...summary, publishedThroughSequence: 4, unreadCount: 4 });
    await screen.findByText('Сообщение 4');
    expect(screen.getByText('Отметить показанное прочитанным').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByText('Загрузить пропущенные сообщения'));
    await screen.findByText('Сообщение 1');
    fireEvent.click(screen.getByText('Отметить показанное прочитанным'));
    await waitFor(() => expect(h.read).toHaveBeenCalledOnce());
    expect(h.read.mock.calls[0]![1].throughSequence).toBe(4);
  });
  it('offline backlog consumes every fixed range page and never marks automatically', async () => {
    const h = setup();
    vi.mocked(h.source.page)
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(page(2, 104, 104))
      .mockResolvedValueOnce(page(52, 104, 110))
      .mockResolvedValueOnce(page(102, 104, 120));
    h.render();
    await screen.findByText('Сообщение 2');
    fireEvent(window, new Event('online'));
    await screen.findByText('Сообщение 104');
    expect(h.source.page).toHaveBeenCalledTimes(4);
    expect(h.read).not.toHaveBeenCalled();
    expect(screen.getByText('Непрочитанных сообщений: 120')).toBeTruthy();
  });
  it('logout/unmount drops late page and does not send a read', async () => {
    const h = setup();
    let resolve!: (value: StationStreamPage) => void;
    vi.mocked(h.source.page).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const view = h.render();
    h.logout();
    await act(async () => {
      resolve(page());
      await Promise.resolve();
    });
    expect(screen.queryByText('Сообщение 2')).toBeNull();
    fireEvent.click(screen.getByText('Отметить показанное прочитанным'));
    expect(h.read).not.toHaveBeenCalled();
    view.unmount();
  });
  it('storage corruption refuses POST and never deletes original custody', async () => {
    sessionStorage.setItem(`lk2:station-read:v1:tenant:user:${id}`, 'broken');
    const h = setup();
    h.render();
    await screen.findByText('Сообщение 2');
    fireEvent.click(screen.getByText('Отметить показанное прочитанным'));
    expect(h.read).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(`lk2:station-read:v1:tenant:user:${id}`)).toBe('broken');
  });
  it('changed epoch response clears private rows; never falls back or advances', async () => {
    const h = setup();
    vi.mocked(h.source.page)
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce({ ...page(), membershipEpoch: 2 });
    h.render();
    await screen.findByText('Сообщение 2');
    fireEvent.click(screen.getByText('Обновить историю'));
    await screen.findByText(/Не удалось подтвердить доступ/);
    expect(screen.queryByText('Сообщение 2')).toBeNull();
    expect(h.read).not.toHaveBeenCalled();
  });
  it('failed custody persistence prevents any POST', async () => {
    const h = setup();
    h.render();
    await screen.findByText('Сообщение 2');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => undefined);
    fireEvent.click(screen.getByText('Отметить показанное прочитанным'));
    await screen.findByText(
      'Запрос прочтения не отправлен: не удалось сохранить его идентификатор.',
    );
    expect(h.read).not.toHaveBeenCalled();
  });
  it('actual composer late ACK does not duplicate a message already accepted from stream history', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const h = setup();
    const published = page(2, 3, 3);
    const item = { ...published.items[0]!, body: 'Новое сообщение', isViewer: true as const };
    published.items = [item];
    vi.mocked(h.source.page)
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(published)
      .mockReturnValue(new Promise(() => {}));
    let acknowledge!: (receipt: StationMessageReceipt) => void;
    const ack = new Promise<StationMessageReceipt>((resolve) => {
      acknowledge = resolve;
    });
    const send = vi.fn<NonNullable<CommunityChatsSource['sendMessage']>>(() => ack);
    render(
      <StationStreamThread
        community={community}
        summary={summary}
        source={h.source}
        chat={{ ...h.chat, sendMessage: send, getMessageRequest: vi.fn() }}
        onPosition={vi.fn()}
      />,
    );
    await screen.findByText('Сообщение 2');
    fireEvent.change(screen.getByRole('textbox', { name: 'Сообщение сообществу' }), {
      target: { value: 'Новое сообщение' },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Отправить' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Обновить историю' }));
    await screen.findByText('Новое сообщение');
    const requestId = send.mock.calls[0]![1].requestId;
    await act(async () => {
      acknowledge({
        contractVersion: 1,
        contract: 'station-message',
        requestId,
        outcome: 'CONFIRMED',
        message: {
          id: item.id,
          body: item.body,
          sentAt: item.sentAt,
          author: item.author,
          isViewer: item.isViewer,
        },
      });
      await ack;
    });
    await waitFor(() => expect(h.source.page).toHaveBeenCalledTimes(3));
    expect(screen.getAllByText('Новое сообщение')).toHaveLength(1);
    expect(send).toHaveBeenCalledOnce();
    expect(h.read).not.toHaveBeenCalled();
  });
  it.each([
    [401, 'read'],
    [403, 'read'],
    [401, 'status'],
    [403, 'status'],
  ] as const)(
    'explicit %i from %s clears private rows/composer but retains original read custody',
    async (status, phase) => {
      vi.stubGlobal('crypto', webcrypto);
      const h = setup();
      h.read.mockImplementation((_id, input) =>
        phase === 'read'
          ? Promise.reject(Object.assign(new Error('denied'), { status }))
          : Promise.resolve({
              contractVersion: 1,
              contract: 'station-read',
              requestId: input.requestId,
              outcome: 'UNKNOWN',
              code: 'READ_RECEIPT_UNPROVEN',
            }),
      );
      vi.mocked(h.source.status).mockRejectedValue(Object.assign(new Error('denied'), { status }));
      const chat = { ...h.chat, sendMessage: vi.fn(), getMessageRequest: vi.fn() };
      render(
        <StationStreamThread
          community={community}
          summary={summary}
          source={h.source}
          chat={chat}
          onPosition={vi.fn()}
        />,
      );
      await screen.findByText('Сообщение 2');
      expect(screen.getByRole('textbox', { name: 'Сообщение сообществу' })).toBeTruthy();
      fireEvent.click(screen.getByText('Отметить показанное прочитанным'));
      if (phase === 'status') {
        await screen.findByText('Прочтение пока не подтверждено. Проверьте статус позже.');
        fireEvent.click(screen.getByText('Проверить прочтение'));
      }
      await screen.findByText('Доступ к чату не подтверждён.');
      expect(screen.queryByText('Сообщение 2')).toBeNull();
      expect(screen.queryByRole('textbox', { name: 'Сообщение сообществу' })).toBeNull();
      expect(JSON.parse(sessionStorage.getItem(`lk2:station-read:v1:tenant:user:${id}`)!)).toEqual(
        h.read.mock.calls[0]![1],
      );
      expect(chat.sendMessage).not.toHaveBeenCalled();
      expect(h.read).toHaveBeenCalledOnce();
    },
  );
  it('read transport ambiguity keeps the original custody and currently displayed rows', async () => {
    const h = setup();
    h.read.mockRejectedValue(new TypeError('offline'));
    h.render();
    await screen.findByText('Сообщение 2');
    fireEvent.click(screen.getByText('Отметить показанное прочитанным'));
    await screen.findByText('Статус прочтения пока недоступен. Исходный запрос сохранён.');
    expect(screen.getByText('Сообщение 2')).toBeTruthy();
    expect(sessionStorage.getItem(`lk2:station-read:v1:tenant:user:${id}`)).not.toBeNull();
    expect(h.read).toHaveBeenCalledOnce();
  });
  it('original pending ACK recovered before archive is not duplicated when archive later exposes its UUID', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const h = setup();
    const message = {
      id: '99999999-1111-4111-8111-111111111111',
      body: 'Старое подтверждённое сообщение',
      sentAt: '2026-10-01T10:00:00.000Z',
      author: { displayName: 'Игрок' },
      isViewer: true as const,
    };
    const original = await new StationMessageCustody(h.source.scope, id, sessionStorage).original(
      message.body,
    );
    let acknowledge!: (receipt: StationMessageReceipt) => void;
    const ack = new Promise<StationMessageReceipt>((resolve) => {
      acknowledge = resolve;
    });
    const status = vi.fn<NonNullable<CommunityChatsSource['getMessageRequest']>>(() => ack);
    const send = vi.fn<NonNullable<CommunityChatsSource['sendMessage']>>();
    const archive: StationStreamPage = {
      historyVersion: 3,
      mode: 'ARCHIVE',
      ...summary,
      items: [{ ...message, sequence: null }],
      nextCursor: null,
      catchUpCursor: null,
      olderCursor: null,
      archiveCursor: null,
      canRequestStationMessage: true,
    };
    vi.mocked(h.source.page)
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(page(2, 2, 2))
      .mockResolvedValueOnce(archive);
    render(
      <StationStreamThread
        community={community}
        summary={summary}
        source={h.source}
        chat={{ ...h.chat, sendMessage: send, getMessageRequest: status }}
        onPosition={vi.fn()}
      />,
    );
    await screen.findByText('Сообщение 2');
    await waitFor(() => expect(status).toHaveBeenCalledWith(id, original.requestId));
    await act(async () => {
      acknowledge({
        contractVersion: 1,
        contract: 'station-message',
        requestId: original.requestId,
        outcome: 'CONFIRMED',
        message,
      });
      await ack;
    });
    await screen.findByText(message.body);
    await waitFor(() => expect(h.source.page).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: 'Показать предыдущие сообщения' })
          .hasAttribute('disabled'),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Показать предыдущие сообщения' }));
    await waitFor(() => expect(h.source.page).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Показать предыдущие сообщения' })).toBeNull(),
    );
    expect(screen.getAllByText(message.body)).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledOnce();
  });
});
