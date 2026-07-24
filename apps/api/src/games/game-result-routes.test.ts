import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerGameResultRoutes } from './game-result-routes.js';

const IDS = {
  tenant: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  game: '6fe9dc1f-87b5-4efd-83a2-5cf9d8070b76',
  submission: '8ef58c73-f94c-4e04-97e8-f6057afc0ec1',
  command: '705e97fd-2a14-4274-8e4a-f4e1a1248f24',
  organizer: 'f75b4e2a-9c98-4b26-85b6-ae58e0edca24',
  player2: 'a9c106f7-0db8-4e27-b1e0-298829f94730',
  player3: '6a758cce-23ab-4ffd-9c57-a1bc5d4aab70',
  player4: 'c68f263e-4a54-4472-9254-103e3b332538',
} as const;

function repository() {
  return {
    submit: vi.fn().mockResolvedValue({
      outcome: 'applied',
      commandId: IDS.command,
      gameId: IDS.game,
      submissionId: IDS.submission,
      revision: 9,
      resultState: 'PENDING_CONFIRMATION',
      committedAt: '2026-07-22T09:00:00.000Z',
      replayed: false,
    }),
    confirm: vi.fn(),
    dispute: vi.fn(),
  };
}

async function appWith(repositoryValue: ReturnType<typeof repository>) {
  const app = Fastify();
  registerGameResultRoutes(app, {
    repository: repositoryValue,
    commandHandlers: [
      (request: FastifyRequest) => {
        const current = request as FastifyRequest & {
          tenantId?: string;
          padlHubClaims?: { sub: string };
        };
        current.tenantId = IDS.tenant;
        current.padlHubClaims = {
          sub: IDS.organizer,
          tenants: [IDS.tenant],
          roles: ['PLAYER'],
          permissions: ['games:play'],
          sid: 'session-result-test',
        };
        return Promise.resolve();
      },
    ],
  });
  await app.ready();
  return app;
}

describe('game result routes', () => {
  it('accepts one immutable snapshot with per-set pairings', async () => {
    const resultRepository = repository();
    const app = await appWith(resultRepository);
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/padlhub/games/${IDS.game}/result-submissions`,
      headers: { 'idempotency-key': 'result-submit-0001' },
      payload: {
        sets: [
          {
            setNumber: 1,
            teamAUserIds: [IDS.organizer, IDS.player2],
            teamBUserIds: [IDS.player3, IDS.player4],
            teamA: 6,
            teamB: 4,
          },
          {
            setNumber: 2,
            teamAUserIds: [IDS.organizer, IDS.player3],
            teamBUserIds: [IDS.player2, IDS.player4],
            teamA: 3,
            teamB: 6,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      commandId: IDS.command,
      operation: { type: 'SUBMIT_RESULT', status: 'SUCCEEDED', aggregateRevision: 9 },
    });
    expect(resultRepository.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: IDS.tenant,
        actorUserId: IDS.organizer,
        gameId: IDS.game,
        idempotencyKey: 'result-submit-0001',
      }),
    );
  });

  it('rejects a set that repeats a player before touching storage', async () => {
    const resultRepository = repository();
    const app = await appWith(resultRepository);
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/padlhub/games/${IDS.game}/result-submissions`,
      headers: { 'idempotency-key': 'result-submit-0002' },
      payload: {
        sets: [
          {
            setNumber: 1,
            teamAUserIds: [IDS.organizer, IDS.organizer],
            teamBUserIds: [IDS.player3, IDS.player4],
            teamA: 6,
            teamB: 4,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(resultRepository.submit).not.toHaveBeenCalled();
  });
});
