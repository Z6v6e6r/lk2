// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '@phub/api-sdk';

import { mergeTicketDetail, SupportTicketsPanel } from './SupportTicketsPanel.js';
import type { NotificationAdminClient, SupportTicket } from './notification-admin-client.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ticket: SupportTicket = {
  id: '11111111-1111-4111-8111-111111111111',
  subject: 'Не открывается приложение',
  category: 'TECHNICAL',
  status: 'OPEN',
  priority: 'HIGH',
  assignedTo: null,
  tags: ['android'],
  createdAt: '2026-10-11T10:00:00.000Z',
  updatedAt: '2026-10-11T10:00:00.000Z',
  resolvedAt: null,
  autoCloseAt: null,
  version: 3,
  messages: [
    {
      id: 'message-user',
      body: 'Экран белый',
      authorRole: 'USER',
      internal: false,
      createdAt: '2026-10-11T10:00:00.000Z',
    },
    {
      id: 'message-note',
      body: 'Проверить Android trace',
      authorRole: 'AGENT',
      internal: true,
      createdAt: '2026-10-11T10:01:00.000Z',
    },
  ],
  history: [
    {
      id: 'event-1',
      kind: 'CREATED',
      createdAt: '2026-10-11T10:00:00.000Z',
      description: 'Обращение создано',
    },
  ],
};

const otherTicket: SupportTicket = {
  ...ticket,
  id: '22222222-2222-4222-8222-222222222222',
  subject: 'Не пришло уведомление',
};

function clientWith(overrides: Partial<NotificationAdminClient> = {}): NotificationAdminClient {
  return {
    listAdminSupportTickets: vi.fn().mockResolvedValue({ items: [ticket] }),
    getAdminSupportTicket: vi.fn().mockResolvedValue(ticket),
    updateAdminSupportTicket: vi
      .fn()
      .mockResolvedValue({ ...ticket, status: 'IN_PROGRESS', version: 4 }),
    sendAdminSupportTicketMessage: vi.fn().mockResolvedValue({ ...ticket, version: 4 }),
    ...overrides,
  } as unknown as NotificationAdminClient;
}

describe('mergeTicketDetail', () => {
  it('keeps a fully consumed earlier-page cursor during canonical latest-page refresh', () => {
    const fullHistory: SupportTicket = {
      ...ticket,
      messages: [
        { ...ticket.messages[0]!, id: 'message-earlier' },
        { ...ticket.messages[1]!, id: 'message-latest' },
      ],
      version: 4,
    };
    const canonicalLatest: SupportTicket = {
      ...ticket,
      messages: [{ ...ticket.messages[1]!, id: 'message-latest' }],
      nextMessageCursor: 'before-earlier-page',
      version: 4,
    };

    const merged = mergeTicketDetail(fullHistory, canonicalLatest);
    expect(merged.nextMessageCursor).toBeUndefined();
    expect(merged.messages.map((message) => message.id)).toEqual([
      'message-earlier',
      'message-latest',
    ]);
  });

  it('clears retained earlier messages when the canonical ticket reports a new conversation purge', () => {
    const cached = {
      ...ticket,
      messages: [
        { ...ticket.messages[0]!, id: 'message-earlier' },
        { ...ticket.messages[1]!, id: 'message-latest' },
      ],
      conversationPurgedAt: null,
      version: 4,
    } as SupportTicket;
    const purgedCanonical = {
      ...ticket,
      messages: [],
      conversationPurgedAt: '2028-10-11T10:00:00.000Z',
      version: 4,
    } as SupportTicket;

    const merged = mergeTicketDetail(cached, purgedCanonical);
    expect(merged.messages).toEqual([]);
    expect(merged.history).toEqual(ticket.history);
  });

  it('does not lower the visible ticket version after a late canonical read', () => {
    expect(mergeTicketDetail({ ...ticket, version: 5 }, { ...ticket, version: 4 })).toMatchObject({
      version: 5,
    });
  });
});

describe('SupportTicketsPanel', () => {
  it('loads the queue, opens a ticket and sends an agent reply with its server version', async () => {
    const sendAdminSupportTicketMessage = vi.fn().mockResolvedValue({ ...ticket, version: 4 });
    const client = clientWith({ sendAdminSupportTicketMessage });
    render(<SupportTicketsPanel client={client} canManage />);

    fireEvent.click(await screen.findByRole('button', { name: /Не открывается приложение/ }));
    expect(await screen.findByText('Экран белый')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Ответ или заметка'), {
      target: { value: 'Уже проверяем.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ответить пользователю' }));

    await waitFor(() => expect(sendAdminSupportTicketMessage).toHaveBeenCalledTimes(1));
    expect(sendAdminSupportTicketMessage).toHaveBeenCalledWith(
      ticket.id,
      { body: 'Уже проверяем.', internal: false, expectedVersion: 3 },
      expect.stringMatching(/^support-message-/),
    );
  });

  it('keeps internal notes hidden for a read-only operator', async () => {
    const client = clientWith();
    render(<SupportTicketsPanel client={client} canManage={false} />);

    fireEvent.click(await screen.findByRole('button', { name: /Не открывается приложение/ }));
    expect(await screen.findByText('Экран белый')).toBeInTheDocument();
    expect(screen.queryByText('Проверить Android trace')).not.toBeInTheDocument();
    expect(screen.getByText(/Доступ только на чтение/)).toBeInTheDocument();
  });

  it('updates ticket status with the expected version and a command idempotency key', async () => {
    const updateAdminSupportTicket = vi
      .fn()
      .mockResolvedValue({ ...ticket, status: 'IN_PROGRESS', version: 4 });
    const getAdminSupportTicket = vi.fn().mockResolvedValue(ticket);
    const client = clientWith({ updateAdminSupportTicket, getAdminSupportTicket });
    render(<SupportTicketsPanel client={client} canManage />);

    fireEvent.click(await screen.findByRole('button', { name: /Не открывается приложение/ }));
    await screen.findByText('Экран белый');
    fireEvent.change(screen.getAllByLabelText('Статус')[1]!, { target: { value: 'IN_PROGRESS' } });

    await waitFor(() => expect(getAdminSupportTicket).toHaveBeenCalledTimes(2));
    expect(updateAdminSupportTicket).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: /Не открывается приложение/ })).toHaveTextContent(
      'В работе',
    );
    expect(updateAdminSupportTicket).toHaveBeenCalledWith(
      ticket.id,
      { expectedVersion: 3, status: 'IN_PROGRESS' },
      expect.stringMatching(/^support-update-/),
    );
  });

  it('polls without restoring an advanced queue cursor or duplicating its second page', async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    const listAdminSupportTickets = vi
      .fn()
      .mockResolvedValueOnce({ items: [ticket], nextCursor: 'second-page' })
      .mockResolvedValueOnce({ items: [otherTicket] })
      .mockResolvedValueOnce({ items: [{ ...ticket, version: 4 }], nextCursor: 'second-page' });
    const getAdminSupportTicket = vi.fn().mockResolvedValue(ticket);
    const client = clientWith({ listAdminSupportTickets, getAdminSupportTicket });
    render(<SupportTicketsPanel client={client} canManage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole('button', { name: /Не открывается приложение/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(getAdminSupportTicket).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(listAdminSupportTickets).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Не открывается приложение/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /Не пришло уведомление/ })).toHaveLength(1);
  });

  it('does not switch tickets while the selected ticket is still loading', async () => {
    let resolveTicket: ((value: SupportTicket) => void) | undefined;
    const getAdminSupportTicket = vi.fn(
      () =>
        new Promise<SupportTicket>((resolve) => {
          resolveTicket = resolve;
        }),
    );
    const client = clientWith({
      listAdminSupportTickets: vi.fn().mockResolvedValue({
        items: [ticket, otherTicket],
      }),
      getAdminSupportTicket,
    });
    render(<SupportTicketsPanel client={client} canManage />);

    fireEvent.click(await screen.findByRole('button', { name: /Не открывается приложение/ }));
    const otherButton = screen.getByRole('button', { name: /Не пришло уведомление/ });
    expect(otherButton).toBeDisabled();
    fireEvent.click(otherButton);
    expect(getAdminSupportTicket).toHaveBeenCalledTimes(1);

    resolveTicket?.(ticket);
    expect(await screen.findByText('Экран белый')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Не открывается приложение' })).toBeInTheDocument();
  });

  it('retries an uncertain command with the exact immutable payload and idempotency key', async () => {
    const updateAdminSupportTicket = vi
      .fn()
      .mockRejectedValueOnce(new Error('Сеть недоступна'))
      .mockResolvedValueOnce({ ...ticket, status: 'IN_PROGRESS', version: 4 });
    const client = clientWith({ updateAdminSupportTicket });
    render(<SupportTicketsPanel client={client} canManage />);

    fireEvent.click(await screen.findByRole('button', { name: /Не открывается приложение/ }));
    await screen.findByText('Экран белый');
    fireEvent.change(screen.getAllByLabelText('Статус')[1]!, { target: { value: 'IN_PROGRESS' } });

    const retry = await screen.findByRole('button', { name: 'Повторить последнюю команду' });
    expect(screen.getByRole('button', { name: /Не открывается приложение/ })).toBeDisabled();
    expect(screen.getAllByLabelText('Статус')[1]).toBeDisabled();
    fireEvent.click(retry);

    await waitFor(() => expect(updateAdminSupportTicket).toHaveBeenCalledTimes(2));
    expect(updateAdminSupportTicket.mock.calls[1]).toEqual(updateAdminSupportTicket.mock.calls[0]);
  });

  it('does not retain a retry for a definitive support rate-limit rejection', async () => {
    const updateAdminSupportTicket = vi
      .fn()
      .mockRejectedValue(
        new ApiClientError(
          'Лимит обращений исчерпан',
          429,
          'SUPPORT_TICKET_LIMIT',
          'correlation-id',
        ),
      );
    const getAdminSupportTicket = vi.fn().mockResolvedValue(ticket);
    const client = clientWith({ updateAdminSupportTicket, getAdminSupportTicket });
    render(<SupportTicketsPanel client={client} canManage />);

    fireEvent.click(await screen.findByRole('button', { name: /Не открывается приложение/ }));
    await screen.findByText('Экран белый');
    fireEvent.change(screen.getAllByLabelText('Статус')[1]!, { target: { value: 'IN_PROGRESS' } });

    await waitFor(() => expect(getAdminSupportTicket).toHaveBeenCalledTimes(2));
    expect(updateAdminSupportTicket).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: /Не открывается приложение/ })).toHaveTextContent(
      'Открыт',
    );
    expect(
      screen.queryByRole('button', { name: 'Повторить последнюю команду' }),
    ).not.toBeInTheDocument();
  });

  it('does not retry a confirmed compact update when its canonical read fails', async () => {
    const getAdminSupportTicket = vi
      .fn()
      .mockResolvedValueOnce(ticket)
      .mockRejectedValueOnce(new Error('Не удалось обновить диалог'));
    const updateAdminSupportTicket = vi.fn().mockResolvedValue({
      ...ticket,
      status: 'IN_PROGRESS',
      version: 4,
      messages: [],
      history: [],
    });
    const client = clientWith({ getAdminSupportTicket, updateAdminSupportTicket });
    render(<SupportTicketsPanel client={client} canManage />);

    fireEvent.click(await screen.findByRole('button', { name: /Не открывается приложение/ }));
    await screen.findByText('Экран белый');
    fireEvent.change(screen.getAllByLabelText('Статус')[1]!, { target: { value: 'IN_PROGRESS' } });

    await waitFor(() => expect(getAdminSupportTicket).toHaveBeenCalledTimes(2));
    expect(updateAdminSupportTicket).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: 'Повторить последнюю команду' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Экран белый')).toBeInTheDocument();
  });

  it('does not expose raw event kinds without a human-readable description', async () => {
    const client = clientWith({
      getAdminSupportTicket: vi.fn().mockResolvedValue({
        ...ticket,
        history: [
          { id: 'event-opaque', kind: 'opaque.machine.event', createdAt: ticket.createdAt },
        ],
      }),
    });
    render(<SupportTicketsPanel client={client} canManage />);

    fireEvent.click(await screen.findByRole('button', { name: /Не открывается приложение/ }));
    expect(
      await screen.findByText(
        (_, element) =>
          element?.tagName === 'P' && element.textContent?.includes('Изменение обращения'),
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('opaque.machine.event')).not.toBeInTheDocument();
  });
});
