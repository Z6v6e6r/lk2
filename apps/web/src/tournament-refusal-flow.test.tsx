// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PadlHubApiClient } from '@phub/api-sdk';
import { TournamentLocalOwnerClient } from '@phub/legacy-games-adapter';
import type { TournamentAttempt, TournamentLocalRepository } from '@phub/database';
import { parseTournamentLocalInput, type TournamentOwnerReceipt } from '@phub/domain';
import { createTournamentLocalRuntime } from '../../api/src/tournaments/tournament-local-runtime.js';
import { TournamentRegistrationPanel } from './TournamentRegistrationPanel.js';

const id = '11111111-1111-4111-a111-111111111111';
const reasons = [
  ['LEVEL_NOT_ALLOWED', 'Ваш уровень не подходит под диапазон турнира.'],
  ['PLAYER_LEVEL_REQUIRED', 'Чтобы записаться, укажите свой уровень.'],
  ['PLAYER_LEVEL_UNKNOWN', 'Не удалось определить ваш уровень. Укажите его и повторите.'],
  ['ACTIVITY_LEVEL_INVALID', 'Диапазон уровней турнира настроен некорректно.'],
  ['PLAYER_GENDER_REQUIRED', 'Для записи укажите пол в профиле.'],
  ['GENDER_NOT_ALLOWED', 'Вы не подходите под ограничение турнира по полу.'],
] as const;
function fixture(reason: (typeof reasons)[number][0], loseAck: boolean) {
  const actor = {
    tenantId: id,
    userId: id,
    sessionId: id,
    tenantKey: 'local',
    correlationId: 'synthetic',
  };
  const identity = {
    providerClientId: 'synthetic-client',
    providerMappingId: id,
    providerTenantKey: 'fixture',
  };
  const rows = new Map<string, TournamentAttempt>();
  let allowed = false;
  const repository: TournamentLocalRepository = {
    ready: () => Promise.resolve(true),
    context: () => Promise.resolve(identity),
    read: (_scope, selector) =>
      Promise.resolve(
        selector?.keyHash
          ? (rows.get(selector.keyHash) ?? null)
          : selector?.id
            ? ([...rows.values()].find((row) => row.id === selector.id) ?? null)
            : ([...rows.values()].at(-1) ?? null),
      ),
    registeredJoinCandidate: () => Promise.resolve(null),
    begin: async (_actor, tournamentId, keyHash, input, ctx, date) => {
      await Promise.resolve();
      const op = crypto.randomUUID();
      const row: TournamentAttempt = {
        id: op,
        tournamentId,
        request: input,
        command: { schemaVersion: 1, action: 'JOIN', tournamentId, date },
        ownerOperationId: op,
        identity: ctx,
        state: 'READY',
        receipt: null,
        originalJoinId: null,
      };
      rows.set(keyHash, row);
      return row;
    },
    claim: async (_actor, _scope, op) => {
      await Promise.resolve();
      const row = [...rows.values()].find((row) => row.id === op)!;
      row.state = 'DISPATCHED';
      return id;
    },
    complete: async (_actor, _scope, op, _lease, receipt) => {
      await Promise.resolve();
      const row = [...rows.values()].find((row) => row.id === op)!;
      row.receipt = receipt;
      row.state = 'COMPLETED';
      return row;
    },
  };
  const receipts = new Map<string, TournamentOwnerReceipt>();
  const ownerFetch = vi.fn<typeof fetch>(async (url, init) => {
    await Promise.resolve();
    if (typeof init?.body !== 'string' || typeof url !== 'string')
      throw Error('Unexpected test transport');
    const body = JSON.parse(init.body) as { operationId?: string };
    const isRead = url.endsWith('/read');
    const row = isRead
      ? [...rows.values()].find((row) => row.id === body.operationId)!
      : [...rows.values()].at(-1)!;
    let receipt = receipts.get(row.id);
    if (!receipt) {
      receipt = {
        schemaVersion: 1,
        tournamentId: id,
        operation: {
          operationId: row.id,
          action: 'JOIN',
          outcome: allowed ? 'REGISTERED' : 'REJECTED',
          reason: allowed ? 'REGISTERED' : reason,
          generation: allowed ? row.id : null,
          committedAt: '2026-10-31T10:00:00Z',
        },
        registration: {
          status: allowed ? 'REGISTERED' : 'NOT_REGISTERED_BY_OPERATION',
          asOf: '2026-10-31T10:00:00Z',
        },
      };
      receipts.set(row.id, receipt);
    }
    return Response.json(receipt);
  });
  const owner = new TournamentLocalOwnerClient({
    identityUrl: 'https://cup.example.test/api/internal/lk/identity/verify',
    integrationToken: 'synthetic-owner-token',
    fetchImplementation: ownerFetch,
  });
  const runtime = createTournamentLocalRuntime({
    enabled: true,
    repository,
    client: {
      identity: () => Promise.resolve({ tenantKey: 'fixture', clientId: 'synthetic-client' }),
      prepare: () => Promise.resolve(undefined),
      command: owner.command.bind(owner),
      read: owner.read.bind(owner),
    },
    token: () => Promise.resolve('synthetic-user-token'),
    date: () => Promise.resolve('2026-11-18'),
  });
  const keys: string[] = [];
  const sdk = new PadlHubApiClient({
    baseUrl: 'https://api.example.test',
    tenantKey: 'local',
    platform: 'web',
    appVersion: 'test',
    fetchImplementation: async (input, init) => {
      if (typeof input !== 'string') throw Error('Unexpected test URL');
      const url = new URL(input),
        key = new Headers(init?.headers).get('Idempotency-Key')!;
      if (url.pathname.endsWith('/registrations')) {
        keys.push(key);
        if (typeof init?.body !== 'string') throw Error('Unexpected test body');
        const result = await runtime.execute(
          actor,
          id,
          key,
          parseTournamentLocalInput(JSON.parse(init.body)),
        );
        if (loseAck) {
          loseAck = false;
          throw new TypeError('lost browser ACK after durable owner refusal');
        }
        return Response.json(result);
      }
      return Response.json(
        await runtime.read(actor, id, {
          ...(key ? { key } : {}),
          ...(url.searchParams.get('operationId')
            ? { id: url.searchParams.get('operationId')! }
            : {}),
        }),
      );
    },
  });
  sdk.setAccessToken('synthetic-access-token');
  return {
    gateway: {
      tournamentPrincipal: () => `${id}:${id}:fixture`,
      commandTournament: sdk.commandTournament.bind(sdk),
      getTournamentRegistration: sdk.getTournamentRegistration.bind(sdk),
      retryTournament: sdk.retryTournament.bind(sdk),
    },
    keys,
    allow: () => {
      allowed = true;
    },
    rows,
    ownerFetch,
  };
}
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
it.each(reasons)(
  'CUP %s through owner parser/runtime/SDK/client/panel is terminal, readable and permits a new conscious attempt',
  async (reason, message) => {
    const f = fixture(reason, false),
      user = userEvent.setup();
    render(
      <TournamentRegistrationPanel
        gateway={f.gateway}
        principal={{ tenantId: id, userId: id }}
        tournamentId={id}
      />,
    );
    const join = await screen.findByRole('button', { name: 'Записаться на турнир' });
    await waitFor(() => expect(join).toBeEnabled());
    await user.click(join);
    expect(await screen.findByText(new RegExp(message.replaceAll('.', '\\.')))).toBeVisible();
    expect(screen.queryByText(/исходная регистрация уже изменилась/i)).not.toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Проверить запись' }));
    expect(await screen.findByText(new RegExp(message.replaceAll('.', '\\.')))).toBeVisible();
    expect(f.keys).toHaveLength(1);
    f.allow();
    await user.click(join);
    expect(await screen.findByText('Запись подтверждена.')).toBeVisible();
    expect(new Set(f.keys).size).toBe(2);
    expect(f.rows.size).toBe(2);
  },
);
it('lost response preserves custody until read recovers the terminal CUP receipt through runtime and SDK', async () => {
  const f = fixture('LEVEL_NOT_ALLOWED', true),
    user = userEvent.setup();
  render(
    <TournamentRegistrationPanel
      gateway={f.gateway}
      principal={{ tenantId: id, userId: id }}
      tournamentId={id}
    />,
  );
  const join = await screen.findByRole('button', { name: 'Записаться на турнир' });
  await waitFor(() => expect(join).toBeEnabled());
  await user.click(join);
  expect(
    await screen.findByText('Операция ожидает подтверждения. Сохранён исходный запрос.'),
  ).toBeVisible();
  expect(localStorage.length).toBe(1);
  await user.click(screen.getByRole('button', { name: 'Проверить запись' }));
  expect(await screen.findByText(/Ваш уровень не подходит под диапазон турнира/)).toBeVisible();
  expect(localStorage.length).toBe(0);
  expect(f.keys).toHaveLength(1);
  f.allow();
  await user.click(screen.getByRole('button', { name: 'Записаться на турнир' }));
  expect(await screen.findByText('Запись подтверждена.')).toBeVisible();
  expect(new Set(f.keys).size).toBe(2);
});
