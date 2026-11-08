// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TournamentRegistrationPanel } from './TournamentRegistrationPanel.js';
import type { AuthGateway } from './auth-gateway.js';
import type { TournamentLocalResult } from '@phub/api-contracts';
const id = '11111111-1111-4111-a111-111111111111',
  op = '22222222-2222-4222-a222-222222222222';
const pending: TournamentLocalResult = {
  tournamentId: id,
  operation: { id: op, action: 'JOIN', status: 'UNKNOWN', reason: null, generation: null },
  registration: { status: 'UNKNOWN', asOf: null },
  retryAfterSeconds: 15,
};
const joined: TournamentLocalResult = {
  ...pending,
  operation: { ...pending.operation, status: 'REGISTERED', reason: 'REGISTERED', generation: op },
  registration: { status: 'REGISTERED', asOf: '2026-10-31T12:00:00Z' },
  retryAfterSeconds: null,
};
describe('rendered actual tournament registration panel', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (_name: string, _options: unknown, callback: () => unknown) =>
          await callback(),
      },
    });
  });
  afterEach(cleanup);
  it('level refusal offers a self-declared level and retries a fresh JOIN', async () => {
    const levels = ['D', 'C', 'B'].map((code, index) => ({
      id: `3333333${index}-3333-4333-a333-333333333333`,
      sportCode: 'PADEL',
      code,
      title: code,
      rank: index + 1,
      sortOrder: index + 1,
      aliases: [code],
      active: true,
      scaleVersion: 1,
    }));
    const gateway = {
      tournamentPrincipal: () => `${id}:${id}:0:0`,
      getTournamentRegistration: vi.fn(
        async () => await Promise.resolve({ commandsEnabled: true, result: null }),
      ),
      commandTournament: vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('level'), { status: 409, code: 'PLAYER_LEVEL_REQUIRED' }),
        )
        .mockResolvedValueOnce(joined),
      retryTournament: vi.fn(),
      getOwnPlayerLevel: vi.fn(
        async () =>
          await Promise.resolve({
            sportCode: 'PADEL',
            scaleVersion: 1,
            levels,
            currentLevel: null,
          }),
      ),
      setOwnPlayerLevel: vi.fn(async () => await Promise.resolve({})),
    } as unknown as AuthGateway;
    const user = userEvent.setup();
    render(
      <TournamentRegistrationPanel
        gateway={gateway}
        principal={{ tenantId: id, userId: id }}
        tournamentId={id}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Записаться на турнир' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Записаться на турнир' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Чтобы записаться, укажите свой уровень.',
    );
    await user.selectOptions(await screen.findByLabelText('Ваш уровень'), levels[1]!.id);
    await user.click(screen.getByRole('button', { name: 'Сохранить и записаться' }));
    expect(await screen.findByText('Запись подтверждена.')).toBeVisible();
    expect(gateway.setOwnPlayerLevel).toHaveBeenCalledWith(levels[1]!.id, 'PADEL');
    const calls = (gateway.commandTournament as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![2]).not.toBe(calls[0]![2]);
  });
  it('out-of-range level refusal shows the reason without a level picker', async () => {
    const gateway = {
      tournamentPrincipal: () => `${id}:${id}:0:0`,
      getTournamentRegistration: vi.fn(
        async () => await Promise.resolve({ commandsEnabled: true, result: null }),
      ),
      commandTournament: vi.fn(async () => {
        await Promise.resolve();
        throw Object.assign(new Error('level'), { status: 409, code: 'LEVEL_NOT_ALLOWED' });
      }),
      retryTournament: vi.fn(),
      getOwnPlayerLevel: vi.fn(),
      setOwnPlayerLevel: vi.fn(),
    } as unknown as AuthGateway;
    const user = userEvent.setup();
    render(
      <TournamentRegistrationPanel
        gateway={gateway}
        principal={{ tenantId: id, userId: id }}
        tournamentId={id}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Записаться на турнир' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Записаться на турнир' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ваш уровень не подходит под диапазон этой активности.',
    );
    expect(screen.queryByLabelText('Ваш уровень')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Записаться на турнир' })).toBeEnabled();
  });
  it('UNKNOWN manual same-operation recovery, then exact original LEAVE', async () => {
    const gateway = {
      tournamentPrincipal: () => `${id}:${id}:0:0`,
      getTournamentRegistration: vi.fn(
        async () => await Promise.resolve({ commandsEnabled: true, result: null }),
      ),
      commandTournament: vi.fn(async () => await Promise.resolve(pending)),
      retryTournament: vi.fn(async () => await Promise.resolve(joined)),
    } as unknown as AuthGateway;
    const user = userEvent.setup();
    render(
      <TournamentRegistrationPanel
        gateway={gateway}
        principal={{ tenantId: id, userId: id }}
        tournamentId={id}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Записаться на турнир' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Записаться на турнир' }));
    expect(
      await screen.findByText('Операция ожидает подтверждения. Сохранён исходный запрос.'),
    ).toBeVisible();
    expect(screen.queryByText('Запись подтверждена.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Повторить исходную операцию' }));
    expect(await screen.findByText('Запись подтверждена.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Выйти из турнира' }));
    expect(gateway.commandTournament).toHaveBeenLastCalledWith(
      id,
      { action: 'LEAVE', originalJoinOperationId: op },
      expect.any(String),
    );
  });
  it('shows typed unsupported refusal and retains original custody', async () => {
    const gateway = {
      tournamentPrincipal: () => `${id}:${id}:0:0`,
      getTournamentRegistration: vi.fn(
        async () => await Promise.resolve({ commandsEnabled: true, result: null }),
      ),
      commandTournament: vi.fn(async () => {
        await Promise.resolve();
        throw Object.assign(new Error('unsupported'), { code: 'TOURNAMENT_LOCAL_UNSUPPORTED' });
      }),
    } as unknown as AuthGateway;
    render(
      <TournamentRegistrationPanel
        gateway={gateway}
        principal={{ tenantId: id, userId: id }}
        tournamentId={id}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Записаться на турнир' })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Записаться на турнир' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Этот турнир пока не поддерживает запись',
    );
    expect(screen.getByRole('button', { name: 'Повторить исходную операцию' })).toBeVisible();
    expect(localStorage.length).toBe(1);
  });
  it.each(['disabled', 'unready', 'read-failure'])(
    'does not create custody or POST before available status: %s',
    async (mode) => {
      const read = vi.fn(() =>
        mode === 'read-failure'
          ? Promise.reject(new Error('unavailable'))
          : Promise.resolve({ commandsEnabled: false, result: null }),
      );
      const command = vi.fn();
      const gateway = {
        tournamentPrincipal: () => `${id}:${id}:0:0`,
        getTournamentRegistration: read,
        commandTournament: command,
      } as unknown as AuthGateway;
      render(
        <TournamentRegistrationPanel
          gateway={gateway}
          principal={{ tenantId: id, userId: id }}
          tournamentId={id}
        />,
      );
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Проверить запись' })).toBeEnabled(),
      );
      expect(screen.getByRole('button', { name: 'Записаться на турнир' })).toBeDisabled();
      expect(command).not.toHaveBeenCalled();
      expect(localStorage.length).toBe(0);
    },
  );
  it('denied localStorage getter renders refusal and does not access HTTP', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    const read = vi.fn(),
      command = vi.fn();
    const gateway = {
      tournamentPrincipal: () => `${id}:${id}:0:0`,
      getTournamentRegistration: read,
      commandTournament: command,
    } as unknown as AuthGateway;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('Denied', 'SecurityError');
      },
    });
    try {
      render(
        <TournamentRegistrationPanel
          gateway={gateway}
          principal={{ tenantId: id, userId: id }}
          tournamentId={id}
        />,
      );
      await screen.findByRole('alert');
      expect(read).not.toHaveBeenCalled();
      expect(command).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Повторить исходную операцию' })).toBeDisabled();
    } finally {
      Object.defineProperty(window, 'localStorage', descriptor);
    }
  });
});
