import { expect, test, type Page, type Route } from '@playwright/test';

const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const gameId = '33333333-3333-4333-8333-333333333333';
const levelId = '44444444-4444-4444-8444-444444444444';
const decisionId = '55555555-5555-4555-8555-555555555555';
const commandId = '66666666-6666-4666-8666-666666666666';

const baseGame = {
  id: gameId,
  revision: 7,
  surface: 'DISCOVER',
  displayState: 'ONE_SPOT_LEFT',
  title: 'Рейтинговая игра вечером',
  kind: 'RATING',
  visibility: 'PUBLIC',
  startsAt: '2026-09-20T15:00:00.000Z',
  endsAt: '2026-09-20T16:00:00.000Z',
  timezone: 'Europe/Moscow',
  station: { id: '77777777-7777-4777-8777-777777777777', name: 'Селигерская' },
  court: { id: '88888888-8888-4888-8888-888888888888', name: 'Корт №3' },
  levelRange: { from: 'C', to: 'C+' },
  rosterState: 'LAST_SPOT',
  capacity: { total: 4, occupied: 3, reserved: 0, open: 1, waitlistCount: 0 },
  participants: [
    {
      userId: '99999999-9999-4999-8999-999999999999',
      displayName: 'Анна',
      avatarUrl: null,
      level: 'C',
      role: 'ORGANIZER',
    },
  ],
  priceSummary: null,
  viewerRelation: 'NONE',
  viewerPaymentState: 'NOT_REQUIRED',
  resultSummary: null,
  badges: ['RATING'],
  allowedActions: ['OPEN_DETAILS', 'JOIN'],
  deepLink: `/games/${gameId}`,
  conversation: null,
} as const;

const joinedGame = {
  ...baseGame,
  revision: 8,
  displayState: 'ROSTER_READY',
  rosterState: 'FULL',
  capacity: { total: 4, occupied: 4, reserved: 0, open: 0, waitlistCount: 0 },
  viewerRelation: 'PARTICIPANT',
  allowedActions: ['LEAVE'],
} as const;

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'X-Correlation-ID': 'eligibility-browser-e2e' },
    body: JSON.stringify(body),
  });
}

async function installApi(
  page: Page,
  scenario: 'recovery' | 'warn',
): Promise<{
  readonly joinBodies: readonly unknown[];
  readonly levelWrites: () => number;
}> {
  const joinBodies: unknown[] = [];
  let levelWrites = 0;
  let joined = false;

  await page.route('**/user/api/v1/local-padel/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/auth/session/refresh') && request.method() === 'POST') {
      await json(route, {
        accessToken: 'browser-e2e-access-token-value',
        tokenType: 'Bearer',
        expiresAt: '2026-09-20T18:00:00.000Z',
        user: { id: userId, displayName: 'Игрок' },
        context: {
          tenantId,
          userId,
          displayName: 'Игрок',
          phoneLast4: '0000',
          roles: ['user'],
          permissions: [],
        },
      });
      return;
    }
    if (path.endsWith(`/games/${gameId}`) && request.method() === 'GET') {
      await json(route, { game: joined ? joinedGame : baseGame });
      return;
    }
    if (path.endsWith(`/games/${gameId}/join`) && request.method() === 'POST') {
      joinBodies.push(request.postDataJSON());
      if (scenario === 'recovery' && joinBodies.length === 1) {
        await json(
          route,
          {
            code: 'PLAYER_LEVEL_REQUIRED',
            message: 'Укажите уровень игрока.',
            correlationId: 'eligibility-browser-e2e',
            eligibility: {
              allowed: false,
              decisionId,
              mode: 'BLOCK',
              code: 'PLAYER_LEVEL_REQUIRED',
              recoveryAction: 'SELECT_LEVEL',
              retryable: true,
              policyVersion: 4,
            },
          },
          409,
        );
        return;
      }
      if (scenario === 'warn') await new Promise((resolve) => setTimeout(resolve, 150));
      joined = true;
      await json(route, {
        commandId,
        operation: {
          id: commandId,
          type: 'JOIN_GAME',
          status: 'SUCCEEDED',
          gameId,
          aggregateRevision: 8,
          createdAt: '2026-08-24T12:00:00.000Z',
          updatedAt: '2026-08-24T12:00:00.000Z',
          nextAction: { type: 'NONE' },
          error: null,
        },
        game: joinedGame,
        ...(scenario === 'warn'
          ? {
              eligibility: {
                allowed: true,
                decisionId,
                mode: 'WARN',
                code: 'LEVEL_TOO_LOW',
                recoveryAction: 'NONE',
                retryable: false,
                policyVersion: 4,
                warning: {
                  code: 'LEVEL_TOO_LOW',
                  message: 'Уровень игры выше указанного вами уровня.',
                },
              },
            }
          : {}),
        replayed: false,
      });
      return;
    }
    if (path.endsWith('/profile/level') && request.method() === 'GET') {
      await json(route, {
        sportCode: 'PADEL',
        scaleVersion: 1,
        currentLevel: null,
        levels: [
          {
            id: levelId,
            sportCode: 'PADEL',
            code: 'C+',
            title: 'C+',
            rank: 4,
            sortOrder: 4,
            aliases: ['C+'],
            active: true,
            scaleVersion: 1,
          },
        ],
      });
      return;
    }
    if (path.endsWith('/profile/level') && request.method() === 'PUT') {
      levelWrites += 1;
      await json(route, {
        playerId: userId,
        sportCode: 'PADEL',
        levelId,
        code: 'C+',
        title: 'C+',
        rank: 4,
        source: 'SELF_DECLARED',
        numericValue: null,
        scaleVersion: 1,
        updatedAt: '2026-08-24T12:00:00.000Z',
      });
      return;
    }
    await json(route, { code: 'UNEXPECTED_E2E_REQUEST', message: path }, 500);
  });

  return { joinBodies, levelWrites: () => levelWrites };
}

test('restores missing-level recovery after refresh and retries the exact JOIN', async ({
  page,
}) => {
  const api = await installApi(page, 'recovery');
  await page.goto(`/games/${gameId}`);

  await page.getByRole('button', { name: 'Вступить в игру' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Укажите уровень, чтобы присоединиться' }),
  ).toBeVisible();

  await page.reload();
  const restored = page.getByRole('dialog', {
    name: 'Укажите уровень, чтобы присоединиться',
  });
  await expect(restored).toBeVisible();
  await restored.getByRole('button', { name: 'Знаю свой уровень' }).click();
  await restored.getByRole('combobox', { name: 'Ваш уровень' }).selectOption(levelId);
  await restored.getByRole('button', { name: 'Сохранить и продолжить запись' }).click();

  await expect(page.getByText('Вы в игре. Состав и доступные действия обновлены.')).toBeVisible();
  expect(api.joinBodies).toHaveLength(2);
  expect(api.levelWrites()).toBe(1);
  for (const body of api.joinBodies) {
    expect(body).not.toHaveProperty('rank');
    expect(body).not.toHaveProperty('levelId');
    expect(body).not.toHaveProperty('bypass');
  }
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('phub.pending-level-recovery.v1')))
    .toBeNull();
});

test('WARN permits the JOIN, shows the server message and suppresses a duplicate click', async ({
  page,
}) => {
  const api = await installApi(page, 'warn');
  await page.goto(`/games/${gameId}`);

  await page.getByRole('button', { name: 'Вступить в игру' }).dblclick();

  await expect(page.getByText('Уровень игры выше указанного вами уровня.')).toBeVisible();
  expect(api.joinBodies).toHaveLength(1);
});
