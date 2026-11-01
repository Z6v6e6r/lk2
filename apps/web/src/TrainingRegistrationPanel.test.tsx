// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, it, expect, vi } from 'vitest';
import { TrainingRegistrationPanel } from './TrainingRegistrationPanel.js';
import type { AuthGateway } from './auth-gateway.js';
const tenantId = '11111111-1111-4111-8111-111111111111',
  userId = '22222222-2222-4222-8222-222222222222',
  training = {
    id: '33333333-3333-4333-8333-333333333333',
    title: 'Synthetic group training',
    startsAt: '2035-04-02T12:00:00.000Z',
  },
  subscriptionId = '44444444-4444-4444-8444-444444444444';
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
function setup() {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: (_n: unknown, _o: unknown, f: () => unknown) => Promise.resolve(f()) },
  });
  const result = {
    trainingId: training.id,
    subscriptionId,
    dateHint: '2035-04-02',
    operation: { id: '55555555-5555-4555-8555-555555555555', status: 'CONFIRMED' },
    registration: { status: 'UNKNOWN', asOf: null },
    retryAfterSeconds: 15,
  };
  const registerTraining = vi.fn(() => Promise.resolve(result)),
    getTrainingRegistration = vi.fn(() => Promise.resolve(result)),
    gateway = {
      getHomeDashboard: vi.fn(() =>
        Promise.resolve({
          subscriptions: [{ id: subscriptionId, title: 'Synthetic subscription' }],
        }),
      ),
      registerTraining,
      getTrainingRegistration,
    } as unknown as AuthGateway;
  return { gateway, registerTraining, getTrainingRegistration, result };
}
it('requires explicit choice, preserves pending key and never renders historical success as attendance', async () => {
  const h = setup();
  render(
    <TrainingRegistrationPanel
      gateway={h.gateway}
      principal={{ tenantId, userId }}
      training={training}
      onClose={() => undefined}
    />,
  );
  expect(screen.getByRole('button', { name: 'Записаться по подписке' })).toBeDisabled();
  const user = userEvent.setup();
  await user.selectOptions(await screen.findByLabelText('Выберите подписку'), subscriptionId);
  await user.click(screen.getByRole('button', { name: 'Записаться по подписке' }));
  await screen.findByText('Текущая запись не подтверждена. Проверка не создаёт новую запись.');
  expect(screen.queryByText('Запись подтверждена по последней проверке.')).toBeNull();
  const first = h.registerTraining.mock.calls[0];
  await user.click(screen.getByRole('button', { name: 'Продолжить исходный запрос' }));
  await waitFor(() => expect(h.registerTraining).toHaveBeenCalledTimes(2));
  expect(h.registerTraining.mock.calls[1]).toEqual(first);
});
it('reload only reads original attempt and an unavailable owner cannot display confirmed', async () => {
  const h = setup();
  localStorage.setItem(
    `phub.training.v1:${tenantId}:${userId}:${training.id}`,
    JSON.stringify({
      version: 1,
      trainingId: training.id,
      subscriptionId,
      dateHint: '2035-04-02',
      idempotencyKey: '66666666-6666-4666-8666-666666666666',
    }),
  );
  h.getTrainingRegistration.mockRejectedValue(new Error('offline'));
  render(
    <TrainingRegistrationPanel
      gateway={h.gateway}
      principal={{ tenantId, userId }}
      training={training}
      onClose={() => undefined}
    />,
  );
  await screen.findByRole('alert');
  expect(h.registerTraining).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(1);
});

it('storage getter denial renders a recoverable error and never sends a registration', async () => {
  const h = setup(),
    denied = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('Synthetic privacy denial', 'SecurityError');
    });
  try {
    render(
      <TrainingRegistrationPanel
        gateway={h.gateway}
        principal={{ tenantId, userId }}
        training={training}
        onClose={() => undefined}
      />,
    );
    await screen.findByRole('alert');
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('Выберите подписку'), subscriptionId);
    await user.click(screen.getByRole('button', { name: 'Записаться по подписке' }));
    await screen.findByRole('alert');
    expect(h.registerTraining).not.toHaveBeenCalled();
    expect(h.getTrainingRegistration).not.toHaveBeenCalled();
  } finally {
    denied.mockRestore();
  }
});
