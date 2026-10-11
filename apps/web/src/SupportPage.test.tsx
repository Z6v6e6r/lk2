// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { ApiClientError } from '@phub/api-sdk';
import type { SupportTicket } from '@phub/api-sdk';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthGateway } from './auth-gateway.js';
import { SupportPage } from './SupportPage.js';

const id = '11111111-1111-4111-8111-111111111111';
const ticket: SupportTicket = {
  id,
  subject: 'Не загружается профиль',
  category: 'TECHNICAL',
  status: 'CLOSED',
  priority: 'NORMAL',
  assignedTo: null,
  tags: [],
  version: 2,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  resolvedAt: null,
  autoCloseAt: null,
  messages: [
    {
      id: 'm1',
      body: 'Ответ поддержки',
      authorRole: 'AGENT',
      internal: false,
      createdAt: '2026-10-01T10:00:00.000Z',
    },
    {
      id: 'm2',
      body: 'Внутренняя заметка',
      authorRole: 'AGENT',
      internal: true,
      createdAt: '2026-10-01T10:00:00.000Z',
    },
  ],
  history: [],
};
function gateway(overrides: Partial<AuthGateway> = {}): AuthGateway {
  return {
    listSupportTickets: vi.fn().mockResolvedValue({ items: [ticket] }),
    getSupportTicket: vi.fn().mockResolvedValue(ticket),
    createSupportTicket: vi.fn().mockResolvedValue(ticket),
    sendSupportTicketMessage: vi.fn().mockResolvedValue({ ...ticket, status: 'OPEN', version: 3 }),
    ...overrides,
  } as unknown as AuthGateway;
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.history.replaceState({}, '', '/support');
});
describe('SupportPage', () => {
  it('opens the dedicated dialog and hides internal notes defensively', async () => {
    render(<SupportPage gateway={gateway()} initialTicketId={id} />);
    expect(await screen.findByRole('heading', { name: ticket.subject })).toBeVisible();
    expect(screen.getByText('Ответ поддержки')).toBeVisible();
    expect(screen.queryByText('Внутренняя заметка')).not.toBeInTheDocument();
    expect(
      screen.getByText('Обращение закрыто. Напишите сообщение, чтобы переоткрыть его.'),
    ).toBeVisible();
  });
  it('retries the exact uncertain command and blocks another ticket while it is unresolved', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValueOnce({ ...ticket, status: 'OPEN', version: 3 });
    render(
      <SupportPage gateway={gateway({ sendSupportTicketMessage: send })} initialTicketId={id} />,
    );
    await screen.findByRole('heading', { name: ticket.subject });
    fireEvent.change(screen.getByRole('textbox', { name: 'Ваш ответ' }), {
      target: { value: 'Проблема сохранилась' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    expect(await screen.findByRole('button', { name: 'Повторить отправку' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Новое обращение' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Ваш ответ' })).toBeDisabled();
    const first = send.mock.calls[0];
    fireEvent.click(screen.getByRole('button', { name: 'Повторить отправку' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]).toEqual(first);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Повторить отправку' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('textbox', { name: 'Ваш ответ' })).toHaveValue('');
  });
  it.each([409, 410])(
    'refreshes after definitive %s and submits the retained draft with a new version and key',
    async (status) => {
      const get = vi
        .fn()
        .mockResolvedValueOnce(ticket)
        .mockResolvedValue({ ...ticket, version: 3 });
      const send = vi
        .fn()
        .mockRejectedValueOnce(
          new ApiClientError(
            'Обращение изменилось',
            status,
            status === 409 ? 'SUPPORT_TICKET_VERSION_CONFLICT' : 'SUPPORT_COMMAND_EXPIRED',
            'test',
          ),
        )
        .mockResolvedValue({ ...ticket, version: 4, status: 'OPEN' });
      render(
        <SupportPage
          gateway={gateway({ getSupportTicket: get, sendSupportTicketMessage: send })}
          initialTicketId={id}
        />,
      );
      await screen.findByRole('heading', { name: ticket.subject });
      fireEvent.change(screen.getByRole('textbox', { name: 'Ваш ответ' }), {
        target: { value: 'Нужна дополнительная помощь' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
      await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled());
      expect(screen.getByRole('textbox', { name: 'Ваш ответ' })).toHaveValue(
        'Нужна дополнительная помощь',
      );
      expect(screen.queryByRole('button', { name: 'Повторить отправку' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
      await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      expect(send.mock.calls[0]?.[1]).toEqual({
        body: 'Нужна дополнительная помощь',
        expectedVersion: 2,
      });
      expect(send.mock.calls[1]?.[1]).toEqual({
        body: 'Нужна дополнительная помощь',
        expectedVersion: 3,
      });
      expect(send.mock.calls[0]?.[2]).not.toBe(send.mock.calls[1]?.[2]);
    },
  );
  it('keeps ticket reads available while the real-account preview is read only', async () => {
    render(<SupportPage gateway={gateway()} readOnly />);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(ticket.subject) }));
    expect(await screen.findByRole('heading', { name: ticket.subject })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Новое обращение' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Ваш ответ' })).toBeDisabled();
  });
  it('creates a classified ticket and adds it to the queue', async () => {
    const create = vi.fn().mockResolvedValue({ ...ticket, status: 'OPEN' });
    render(<SupportPage gateway={gateway({ createSupportTicket: create })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Новое обращение' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Тема' }), {
      target: { value: 'Вопрос об оплате' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Категория' }), {
      target: { value: 'BILLING' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Сообщение' }), {
      target: { value: 'Как получить чек?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить обращение' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]?.[0]).toEqual({
      subject: 'Вопрос об оплате',
      category: 'BILLING',
      body: 'Как получить чек?',
    });
    expect(create.mock.calls[0]?.[1]).toEqual(expect.any(String));
    await waitFor(() => expect(window.location.pathname).toBe(`/support/${id}`));
  });
  it('refreshes compact success receipts and never retries a successful command when GET fails', async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ ...ticket, status: 'OPEN', version: 3, messages: [], history: [] });
    const get = vi
      .fn()
      .mockResolvedValueOnce(ticket)
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue({ ...ticket, status: 'OPEN', version: 3 });
    render(
      <SupportPage
        gateway={gateway({ getSupportTicket: get, sendSupportTicketMessage: send })}
        initialTicketId={id}
      />,
    );
    await screen.findByText('Ответ поддержки');
    fireEvent.change(screen.getByRole('textbox', { name: 'Ваш ответ' }), {
      target: { value: 'Нужна помощь' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    expect(await screen.findByRole('button', { name: 'Обновить диалог' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Повторить отправку' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Ваш ответ' })).toHaveValue('');
    expect(screen.getByText('Ответ поддержки')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Обновить диалог' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    expect(send).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
  it('keeps loaded earlier messages and their advanced cursor during polling', async () => {
    const latest = { ...ticket, messages: [ticket.messages[0]!], nextMessageCursor: 'older' };
    const earlier = {
      ...ticket,
      messages: [
        {
          ...ticket.messages[0]!,
          id: 'early',
          body: 'Раннее сообщение',
          createdAt: '2026-09-30T10:00:00.000Z',
        },
      ],
    };
    const get = vi
      .fn()
      .mockResolvedValueOnce(latest)
      .mockResolvedValueOnce(earlier)
      .mockResolvedValue(latest);
    vi.useFakeTimers();
    render(<SupportPage gateway={gateway({ getSupportTicket: get })} initialTicketId={id} />);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Ранние сообщения' }));
      await Promise.resolve();
    });
    expect(screen.getByText('Раннее сообщение')).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(get).toHaveBeenCalledTimes(3);
    expect(screen.getByText('Раннее сообщение')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Ранние сообщения' })).not.toBeInTheDocument();
    vi.useRealTimers();
  });
  it('can reopen the currently selected dialog without staying in loading state', async () => {
    const get = vi.fn().mockResolvedValue(ticket);
    render(<SupportPage gateway={gateway({ getSupportTicket: get })} initialTicketId={id} />);
    await screen.findByText('Ответ поддержки');
    fireEvent.click(screen.getByRole('button', { name: new RegExp(ticket.subject) }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Ответ поддержки')).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
  it('treats a durable support quota rejection as definitive and keeps the draft editable', async () => {
    const send = vi
      .fn()
      .mockRejectedValue(new ApiClientError('Лимит ответов', 429, 'SUPPORT_RATE_LIMITED', 'test'));
    render(
      <SupportPage gateway={gateway({ sendSupportTicketMessage: send })} initialTicketId={id} />,
    );
    await screen.findByText('Ответ поддержки');
    fireEvent.change(screen.getByRole('textbox', { name: 'Ваш ответ' }), {
      target: { value: 'Помогите' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Лимит ответов');
    expect(screen.queryByRole('button', { name: 'Повторить отправку' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Ваш ответ' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Ваш ответ' })).toHaveValue('Помогите');
  });
  it('clears cached messages when canonical read confirms 24-month retention cleanup', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(ticket)
      .mockResolvedValue({
        ...ticket,
        version: 3,
        messages: [],
        subject: 'Архивное обращение',
        conversationPurgedAt: '2026-10-11T10:00:00.000Z',
      });
    vi.useFakeTimers();
    render(<SupportPage gateway={gateway({ getSupportTicket: get })} initialTicketId={id} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('Ответ поддержки')).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Ответ поддержки')).not.toBeInTheDocument();
    expect(screen.queryByText(ticket.subject)).not.toBeInTheDocument();
    expect(screen.getByText(/Переписка удалена после 24 месяцев хранения/)).toBeVisible();
    vi.useRealTimers();
  });
  it('reports missing capability instead of presenting a broken send action', () => {
    render(<SupportPage gateway={{} as AuthGateway} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Поддержка временно недоступна');
    expect(screen.queryByRole('button', { name: 'Новое обращение' })).not.toBeInTheDocument();
  });
});
