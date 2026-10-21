// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PadlHubApiClient } from '@phub/api-sdk';
import { registerGameJoinConditionsRoutes } from '../../api/src/games/game-join-conditions-routes.js';
import {
  createJoinConditionsFixture,
  evaluatePinnedLk1JoinFixture,
  fixtureActor,
  fixtureId,
} from '../../api/src/games/game-join-conditions.test-fixture.js';
import { GameDetailView } from './GameDetailView.js';
import { GamesPage } from './GamesPage.js';
import { buildMockHomeDashboard } from '../../api/src/home/home-dashboard.js';
import type { AuthGateway, GameCard } from './auth-gateway.js';
const apps: FastifyInstance[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const game: GameCard = {
  id: fixtureActor.gameId,
  revision: 8,
  surface: 'DISCOVER',
  displayState: 'FINDING_PLAYERS',
  title: 'Синтетическая игра',
  kind: 'FRIENDLY',
  visibility: 'PUBLIC',
  startsAt: '2099-09-21T04:00:00Z',
  endsAt: '2099-09-21T05:30:00Z',
  timezone: 'Europe/Moscow',
  station: { id: fixtureId(8), name: 'Тестовая площадка', shortAddress: null },
  court: { id: fixtureId(9), name: 'Корт' },
  levelRange: null,
  rosterState: 'OPEN',
  capacity: { total: 4, occupied: 0, reserved: 0, open: 4, waitlistCount: 0 },
  participants: [],
  priceSummary: null,
  viewerRelation: 'NONE',
  viewerPaymentState: 'NOT_REQUIRED',
  resultSummary: null,
  badges: [],
  allowedActions: ['OPEN_DETAILS'],
  deepLink: '/games/' + fixtureActor.gameId,
  conversation: null,
};
function harness(fixture: ReturnType<typeof createJoinConditionsFixture>) {
  const app = Fastify();
  apps.push(app);
  app.get<{ Params: { gameId: string } }>('/user/api/v1/synthetic/games/:gameId', (request) => ({
    game: { ...game, id: request.params.gameId },
  }));
  app.get('/user/api/v1/synthetic/home', () => ({
    ...buildMockHomeDashboard({
      tenantId: fixtureActor.tenantId,
      userId: fixtureActor.userId,
      displayName: 'Синтетический игрок',
      phoneLast4: '0000',
      roles: ['client'],
      permissions: ['games.play'],
    }),
    subscriptions: [
      {
        id: fixtureActor.subscriptionInstanceId,
        title: 'Годовая HUB · тестовая подписка',
        status: 'active',
        remainingUnits: 1,
        validUntil: '2099-09-30T20:59:59Z',
        route: '/subscriptions/' + fixtureActor.subscriptionInstanceId,
      },
    ],
  }));
  registerGameJoinConditionsRoutes(app, {
    owner: fixture.owner,
    authenticatedTenantHandlers: [
      async (request) => {
        await Promise.resolve();
        request.tenantId = fixtureActor.tenantId;
        request.padlHubClaims = {
          sub: fixtureActor.userId,
          sid: fixtureActor.sessionId,
          roles: ['client'],
          permissions: ['games.play'],
          tenants: [fixtureActor.tenantId],
        };
      },
    ],
  });
  const transport: typeof fetch = async (url, init) => {
    const parsed = new URL(url instanceof Request ? url.url : url instanceof URL ? url.href : url);
    if (parsed.origin !== 'https://api.synthetic.invalid' || (init?.method ?? 'GET') !== 'GET')
      throw new Error('outside synthetic read fixture');
    const response = await app.inject({ method: 'GET', url: parsed.pathname + parsed.search });
    return new Response(response.body, {
      status: response.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new PadlHubApiClient({
    baseUrl: 'https://api.synthetic.invalid',
    tenantKey: 'synthetic',
    platform: 'web',
    appVersion: 'synthetic',
    initialAccessToken: 'synthetic-only',
    fetchImplementation: transport,
  });
  const pageGateway = {
    getGame: (gameId: string) => client.getGame(gameId),
    getHomeDashboard: () => client.getHomeDashboard(),
    getGameJoinConditions: client.getGameJoinConditions.bind(client),
  } as unknown as AuthGateway;
  return {
    client,
    pageGateway,
    drawPage: (userId = fixtureActor.userId, gameId = game.id, gateway = pageGateway) => (
      <GamesPage
        gateway={gateway}
        gameId={gameId}
        chatNavigationScope={{ tenantKey: 'synthetic', userId }}
      />
    ),
    draw: (value = game) => (
      <GameDetailView
        game={value}
        activeTab="GAME"
        busy={false}
        joinConditionsClient={client}
        subscriptionInstanceId={fixtureActor.subscriptionInstanceId}
        onAction={vi.fn()}
        onChatOpen={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onTabChange={vi.fn()}
      />
    ),
  };
}
describe('API production resolver → SDK → GameDetailView synthetic read', () => {
  it('shows server denial with missing price rather than zero', async () => {
    const fixture = createJoinConditionsFixture();
    fixture.setDenial('SUBSCRIPTION_EXPIRED');
    const view = harness(fixture);
    render(view.draw());
    expect(await screen.findByText('Подписка не применяется к этой игре.')).toBeVisible();
    expect(screen.getByText('Срок действия подписки истёк.')).toBeVisible();
    expect(screen.getByText('Цена не подтверждена.')).toBeVisible();
    expect(screen.queryByText(/Предварительная цена:/)).toBeNull();
  });
  it('removes the advisory price when its server TTL expires', async () => {
    const fixture = createJoinConditionsFixture(70000, 250);
    const view = harness(fixture);
    render(view.draw());
    await screen.findByText(/Предварительная цена: 700/);
    expect(await screen.findByText('Срок проверки истёк. Обновите условия.')).toBeVisible();
    expect(screen.queryByText(/Предварительная цена:/)).toBeNull();
  });

  it.runIf(process.env.LK1_JOIN_EVALUATOR_SOURCE)(
    'renders the actual hash-pinned LK1 owner decision through production resolver/API/SDK',
    async () => {
      const decision = evaluatePinnedLk1JoinFixture(process.env.LK1_JOIN_EVALUATOR_SOURCE!);
      const fixture = createJoinConditionsFixture(decision.benefit.finalPriceMinor);
      const view = harness(fixture);
      render(view.draw());
      expect(await screen.findByText(/Предварительная цена: 700/)).toBeVisible();
      expect(screen.getByText(/Бесплатные минуты: 60. Платные минуты: 30./)).toBeVisible();
    },
  );

  it('renders owner amount, advisory limit, revision and expiry without a commercial command', async () => {
    const fixture = createJoinConditionsFixture();
    const view = harness(fixture);
    render(view.draw());
    expect(await screen.findByText('Подписка применима к этой игре.')).toBeVisible();
    expect(screen.getByText(/Предварительная цена: 700/)).toHaveTextContent(
      'Цена не подтверждена для оплаты',
    );
    expect(screen.getByText(/Ревизия игры ЛК2: 8/)).toBeVisible();
    expect(screen.getByText(/Проверка действует до/)).toBeVisible();
    expect(screen.getByText('Тестовый контур · provider mock')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Вступить в игру' })).toBeNull();
    expect(fixture.calls.filter((call) => call.kind === 'LK1_ADVISORY_READ')).toHaveLength(1);
  });
  it('shows missing price after mapping refusal without displaying zero', async () => {
    const fixture = createJoinConditionsFixture();
    fixture.setDbMissing();
    const view = harness(fixture);
    render(view.draw());
    expect(
      await screen.findByText('Условия и цена не подтверждены. Повторите проверку.'),
    ).toBeVisible();
    expect(screen.queryByText(/Предварительная цена:/)).toBeNull();
    expect(fixture.calls.every((call) => call.kind === 'SQL_READ')).toBe(true);
  });
  it('removes previous amount immediately when revision changes and refuses stale context', async () => {
    const fixture = createJoinConditionsFixture();
    const view = harness(fixture);
    const rendered = render(view.draw());
    await screen.findByText(/Предварительная цена: 700/);
    rendered.rerender(view.draw({ ...game, revision: 9 }));
    expect(screen.queryByText(/Предварительная цена:/)).toBeNull();
    expect(
      await screen.findByText('Условия и цена не подтверждены. Повторите проверку.'),
    ).toBeVisible();
  });
});

describe('GamesPage explicit canonical selection → API/SDK → existing-game conditions', () => {
  it('waits for explicit selection and clears price when selection is cleared', async () => {
    const fixture = createJoinConditionsFixture();
    const view = harness(fixture);
    render(view.drawPage());
    const picker = await screen.findByRole('combobox', { name: 'Выберите подписку' });
    expect(picker).toHaveValue('');
    expect(fixture.calls).toHaveLength(0);
    const user = userEvent.setup();
    await user.selectOptions(picker, fixtureActor.subscriptionInstanceId);
    expect(await screen.findByText(/Предварительная цена: 700/)).toBeVisible();
    expect(screen.getByText('Тестовый контур · provider mock')).toBeVisible();
    expect(screen.getByText(/Ревизия игры ЛК2: 8/)).toBeVisible();
    await user.selectOptions(picker, '');
    expect(screen.queryByText(/Предварительная цена:/)).toBeNull();
    expect(fixture.calls.filter((call) => call.kind === 'LK1_ADVISORY_READ')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Вступить в игру' })).toBeNull();
  });

  it('shows server refusal and missing price for the explicitly selected subscription', async () => {
    const fixture = createJoinConditionsFixture();
    fixture.setDenial('SUBSCRIPTION_EXPIRED');
    const view = harness(fixture);
    render(view.drawPage());
    await userEvent
      .setup()
      .selectOptions(
        await screen.findByRole('combobox', { name: 'Выберите подписку' }),
        fixtureActor.subscriptionInstanceId,
      );
    expect(await screen.findByText('Срок действия подписки истёк.')).toBeVisible();
    expect(screen.getByText('Цена не подтверждена.')).toBeVisible();
    expect(screen.queryByText(/Предварительная цена:/)).toBeNull();
  });

  it('removes conditions at the owner TTL through the actual page entry point', async () => {
    const fixture = createJoinConditionsFixture(70000, 250);
    const view = harness(fixture);
    render(view.drawPage());
    await userEvent
      .setup()
      .selectOptions(
        await screen.findByRole('combobox', { name: 'Выберите подписку' }),
        fixtureActor.subscriptionInstanceId,
      );
    await screen.findByText(/Предварительная цена: 700/);
    expect(await screen.findByText('Срок проверки истёк. Обновите условия.')).toBeVisible();
    expect(screen.queryByText(/Предварительная цена:/)).toBeNull();
  });

  it.each(['viewer', 'game', 'gateway'] as const)(
    'clears old selection and price when %s changes',
    async (change) => {
      const fixture = createJoinConditionsFixture();
      const view = harness(fixture);
      const rendered = render(view.drawPage());
      await userEvent
        .setup()
        .selectOptions(
          await screen.findByRole('combobox', { name: 'Выберите подписку' }),
          fixtureActor.subscriptionInstanceId,
        );
      await screen.findByText(/Предварительная цена: 700/);
      rendered.rerender(
        view.drawPage(
          change === 'viewer' ? fixtureId(90) : fixtureActor.userId,
          change === 'game' ? fixtureId(91) : game.id,
          change === 'gateway' ? { ...view.pageGateway } : view.pageGateway,
        ),
      );
      expect(screen.queryByText(/Предварительная цена:/)).toBeNull();
      expect(await screen.findByRole('combobox', { name: 'Выберите подписку' })).toHaveValue('');
      expect(fixture.calls.filter((call) => call.kind === 'LK1_ADVISORY_READ')).toHaveLength(1);
      // Returning to the previous scope still requires a fresh, explicit selection.
      rendered.rerender(view.drawPage());
      expect(screen.queryByText(/Предварительная цена:/)).toBeNull();
      expect(await screen.findByRole('combobox', { name: 'Выберите подписку' })).toHaveValue('');
      expect(fixture.calls.filter((call) => call.kind === 'LK1_ADVISORY_READ')).toHaveLength(1);
    },
  );

  it.runIf(process.env.LK1_JOIN_EVALUATOR_SOURCE)(
    'uses the pinned actual LK1 evaluator after user selection',
    async () => {
      const decision = evaluatePinnedLk1JoinFixture(process.env.LK1_JOIN_EVALUATOR_SOURCE!);
      const fixture = createJoinConditionsFixture(decision.benefit.finalPriceMinor);
      const view = harness(fixture);
      render(view.drawPage());
      await userEvent
        .setup()
        .selectOptions(
          await screen.findByRole('combobox', { name: 'Выберите подписку' }),
          fixtureActor.subscriptionInstanceId,
        );
      expect(await screen.findByText(/Предварительная цена: 700/)).toBeVisible();
      expect(screen.getByText(/Бесплатные минуты: 60. Платные минуты: 30./)).toBeVisible();
    },
  );
});
