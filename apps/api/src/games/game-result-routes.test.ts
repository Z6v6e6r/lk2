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
  function applied(overrides: Record<string, unknown> = {}) {
    return {
      outcome: 'applied',
      commandId: IDS.command,
      gameId: IDS.game,
      submissionId: IDS.submission,
      revision: 9,
      resultState: 'PENDING_CONFIRMATION',
      committedAt: '2026-07-22T09:00:00.000Z',
      replayed: false,
      ...overrides,
    };
  }

  const validSets = [
    {
      setNumber: 1,
      teamAUserIds: [IDS.organizer, IDS.player2],
      teamBUserIds: [IDS.player3, IDS.player4],
      teamA: 6,
      teamB: 4,
    },
  ];

  it('answers 503 while the result runtime is disabled, without touching storage', async () => {
    // This is the beta state until the game result write owner is switched: the route must fail closed
    // rather than silently accept a durable result.
    const app = Fastify();
    registerGameResultRoutes(app, {
      commandHandlers: [
        (request: FastifyRequest) => {
          const current = request as FastifyRequest & {
            tenantId?: string;
            padlHubClaims?: { sub: string };
          };
          current.tenantId = IDS.tenant;
          current.padlHubClaims = { sub: IDS.organizer };
          return Promise.resolve();
        },
      ],
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/padlhub/games/${IDS.game}/result-submissions`,
      headers: { 'idempotency-key': 'result-disabled-0001' },
      payload: { sets: validSets },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'GAMES_RESULTS_RUNTIME_UNAVAILABLE' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('maps every domain rejection to its HTTP status and never reports success', async () => {
    const cases = [
      ['GAME_NOT_FOUND', 404],
      ['GAME_RESULT_NOT_AVAILABLE', 409],
      ['GAME_RESULT_NOT_PARTICIPANT', 409],
      ['GAME_RESULT_INVALID_ROSTER', 400],
      ['GAME_RESULT_SUBMISSION_NOT_FOUND', 404],
      ['GAME_RESULT_REVIEW_FORBIDDEN', 403],
      ['GAME_RESULT_STATE_CONFLICT', 409],
    ] as const;

    for (const [code, status] of cases) {
      const resultRepository = repository();
      resultRepository.submit.mockResolvedValue({ outcome: 'rejected', code });
      const app = await appWith(resultRepository);
      const response = await app.inject({
        method: 'POST',
        url: `/user/api/v1/padlhub/games/${IDS.game}/result-submissions`,
        headers: { 'idempotency-key': `result-${code}` },
        payload: { sets: validSets },
      });

      expect(response.statusCode, code).toBe(status);
      expect(response.json()).toMatchObject({ code });
    }
  });

  it('reports a reused idempotency key as a conflict instead of replaying it', async () => {
    const resultRepository = repository();
    resultRepository.submit.mockResolvedValue({ outcome: 'idempotency_conflict' });
    const app = await appWith(resultRepository);
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/padlhub/games/${IDS.game}/result-submissions`,
      headers: { 'idempotency-key': 'result-reused-0001' },
      payload: { sets: validSets },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('flags a replayed command so a retry is observable to the caller', async () => {
    const resultRepository = repository();
    resultRepository.submit.mockResolvedValue(applied({ replayed: true, revision: 12 }));
    const app = await appWith(resultRepository);
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/padlhub/games/${IDS.game}/result-submissions`,
      headers: { 'idempotency-key': 'result-replay-0001' },
      payload: { sets: validSets },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ replayed: true, operation: { aggregateRevision: 12 } });
  });

  it('confirms and disputes a submission through its own routes', async () => {
    const resultRepository = repository();
    resultRepository.confirm.mockResolvedValue(applied({ resultState: 'CONFIRMED' }));
    resultRepository.dispute.mockResolvedValue(applied({ resultState: 'DISPUTED' }));
    const app = await appWith(resultRepository);

    const confirmed = await app.inject({
      method: 'POST',
      url: `/user/api/v1/padlhub/games/${IDS.game}/result-submissions/${IDS.submission}/confirm`,
      headers: { 'idempotency-key': 'result-confirm-0001' },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ operation: { type: 'CONFIRM_RESULT' } });

    const disputed = await app.inject({
      method: 'POST',
      url: `/user/api/v1/padlhub/games/${IDS.game}/result-submissions/${IDS.submission}/dispute`,
      headers: { 'idempotency-key': 'result-dispute-0001' },
      payload: { reasonCode: 'SCORE_INCORRECT', note: 'Счёт во втором сете' },
    });
    expect(disputed.statusCode).toBe(200);
    expect(disputed.json()).toMatchObject({ operation: { type: 'DISPUTE_RESULT' } });
    expect(resultRepository.dispute).toHaveBeenCalledWith(
      expect.objectContaining({ submissionId: IDS.submission, actorUserId: IDS.organizer }),
    );
  });

  it('requires a dispute reason and rejects malformed identifiers before storage', async () => {
    const resultRepository = repository();
    const app = await appWith(resultRepository);

    const noReason = await app.inject({
      method: 'POST',
      url: `/user/api/v1/padlhub/games/${IDS.game}/result-submissions/${IDS.submission}/dispute`,
      headers: { 'idempotency-key': 'result-dispute-0002' },
      payload: {},
    });
    expect(noReason.statusCode).toBe(400);
    expect(resultRepository.dispute).not.toHaveBeenCalled();

    const badId = await app.inject({
      method: 'POST',
      url: '/user/api/v1/padlhub/games/not-a-uuid/result-submissions',
      headers: { 'idempotency-key': 'result-bad-id' },
      payload: { sets: validSets },
    });
    expect(badId.statusCode).toBe(400);
    expect(resultRepository.submit).not.toHaveBeenCalled();
  });
});
