// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotificationAdminClient } from './notification-admin-client.js';
import { ApiClientError } from '@phub/api-sdk';
import { NotificationScenariosWorkspace } from './NotificationScenariosWorkspace.js';

function client() {
  return {
    listNotificationScenarios: vi
      .fn<NotificationAdminClient['listNotificationScenarios']>()
      .mockResolvedValue({
        items: [],
        runtimeEnabled: false,
        catalog: [
          { type: 'BOOKING_STARTS', available: true, reason: null },
          { type: 'SUBSCRIPTION_ENDS', available: false, reason: 'Источник ещё не подключён' },
        ],
      }),
    listNotificationScenarioRuns: vi
      .fn<NotificationAdminClient['listNotificationScenarioRuns']>()
      .mockResolvedValue({ items: [] }),
    saveNotificationScenario: vi.fn<NotificationAdminClient['saveNotificationScenario']>(),
  };
}
afterEach(cleanup);
describe('CUP notification scenarios', () => {
  it('renders the draft editor, unavailable sources and synthetic preview without sending', async () => {
    const api = client();
    render(<NotificationScenariosWorkspace client={api} />);
    expect(await screen.findByLabelText('Название')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Окончание подписки/ })).toBeDisabled();
    expect(screen.getByLabelText('Предварительный просмотр')).toHaveTextContent(
      'Групповая тренировка',
    );
    expect(screen.getByText(/Автоматическая отправка выключена/)).toBeInTheDocument();
    expect(api.saveNotificationScenario).not.toHaveBeenCalled();
  });
  it('preserves the exact command after ambiguous failure and retries the same key', async () => {
    const api = client();
    api.saveNotificationScenario
      .mockRejectedValueOnce(new TypeError('Сеть недоступна'))
      .mockImplementationOnce(
        (input: Parameters<NotificationAdminClient['saveNotificationScenario']>[0]) =>
          Promise.resolve({
            id: '11111111-1111-4111-8111-111111111111',
            version: 1,
            definition: input.definition,
            updatedAt: '2026-10-21T12:00:00Z',
          }),
      );
    render(<NotificationScenariosWorkspace client={api} />);
    fireEvent.change(await screen.findByLabelText('Название'), {
      target: { value: 'Перед тренировкой' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить сценарий' }));
    expect(await screen.findByRole('button', { name: 'Проверить сохранение' })).toBeEnabled();
    expect(screen.getByLabelText('Название')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Проверить сохранение' }));
    await waitFor(() => expect(api.saveNotificationScenario).toHaveBeenCalledTimes(2));
    expect(api.saveNotificationScenario.mock.calls[0]?.[0]).toEqual(
      api.saveNotificationScenario.mock.calls[1]?.[0],
    );
    expect(await screen.findByText('Сохранена версия 1.')).toBeInTheDocument();
  });
  it('adds the required inbox when changing a saved Web Push-only scenario to a friend invitation', async () => {
    const api = client();
    api.listNotificationScenarios.mockResolvedValue({
      runtimeEnabled: false,
      catalog: [
        { type: 'BOOKING_CONFIRMED', available: true, reason: null },
        { type: 'FRIEND_GAME_PUBLISHED', available: true, reason: null },
      ],
      items: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          version: 2,
          updatedAt: '2026-10-21T12:00:00Z',
          definition: {
            name: 'Сохранённый сценарий',
            trigger: 'BOOKING_CONFIRMED',
            delayMinutes: 0,
            ttlMinutes: 60,
            title: 'Тест',
            body: 'Тест',
            channels: ['WEB_PUSH'],
            quietHours: 'DEFER',
            dailyLimit: 1,
            goal: 'NONE',
            goalWindowMinutes: 60,
            active: false,
          },
        },
      ],
    });
    render(<NotificationScenariosWorkspace client={api} />);
    fireEvent.click(await screen.findByRole('button', { name: /Сохранённый сценарий/ }));
    expect(screen.getByLabelText('Центр уведомлений')).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('Триггер'), {
      target: { value: 'FRIEND_GAME_PUBLISHED' },
    });
    expect(screen.getByLabelText('Центр уведомлений')).toBeChecked();
    expect(screen.getByLabelText('Центр уведомлений')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить сценарий' }));
    await waitFor(() => expect(api.saveNotificationScenario).toHaveBeenCalledOnce());
    const saved = api.saveNotificationScenario.mock.calls[0]![0].definition;
    expect(saved.goal).toBe('GAME_JOINED');
    expect(saved.channels).toEqual(['WEB_PUSH', 'IN_APP']);
  });
  it('allows correction after a definitive validation rejection', async () => {
    const api = client();
    api.saveNotificationScenario.mockRejectedValue(
      new ApiClientError('Проверьте параметры', 400, 'INVALID_REQUEST', 'test'),
    );
    render(<NotificationScenariosWorkspace client={api} />);
    fireEvent.change(await screen.findByLabelText('Название'), { target: { value: 'Тест' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить сценарий' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Проверьте параметры');
    expect(screen.getByLabelText('Название')).toBeEnabled();
  });
});
