/* eslint-disable @typescript-eslint/require-await -- Synthetic asynchronous boundary fixtures. */
import Fastify from 'fastify';
import { describe, it, expect, vi } from 'vitest';
import { registerTournamentChatRoutes } from './tournament-chat-routes.js';
import { TournamentChatError } from '@phub/domain';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tournamentId = id(1),
  requestId = id(2),
  base = `/user/api/v1/synthetic/tournaments/${tournamentId}/chat`;
async function fixture(auth = true, enabled = true) {
  const app = Fastify({ genReqId: () => id(9) });
  const owner = {
    send: vi.fn(async () => ({
      contractVersion: 'tournament-chat.v1' as const,
      tournamentId,
      requestId,
      status: 'UNKNOWN' as const,
    })),
    status: vi.fn(async () => ({
      contractVersion: 'tournament-chat.v1' as const,
      tournamentId,
      requestId,
      status: 'UNKNOWN' as const,
    })),
    history: vi.fn(async () => ({
      contractVersion: 'tournament-chat.v1' as const,
      tournamentId,
      streamId: null,
      throughSequence: 0,
      messages: [],
      hasMore: false,
      nextCursor: null,
    })),
  };
  registerTournamentChatRoutes(app, {
    ...(enabled ? { owner } : {}),
    handlers: [
      async (request) => {
        if (auth) {
          request.tenantId = id(3);
          request.padlHubClaims = { sub: id(4), sid: id(5) } as NonNullable<
            typeof request.padlHubClaims
          >;
        }
      },
    ],
  });
  await app.ready();
  return { app, owner };
}
describe('public tournament chat boundary', () => {
  it('authenticates and forwards only verified actor, exact key and untrimmed text', async () => {
    const { app, owner } = await fixture();
    try {
      const r = await app.inject({
        method: 'POST',
        url: base + '/message-requests',
        headers: { 'idempotency-key': requestId },
        payload: { requestId, text: '  hello  ' },
      });
      expect(r.statusCode).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(owner.send).toHaveBeenCalledWith(
        {
          tenantId: id(3),
          tenantKey: 'synthetic',
          userId: id(4),
          sessionId: id(5),
          correlationId: id(9),
        },
        tournamentId,
        { requestId, text: '  hello  ' },
      );
    } finally {
      await app.close();
    }
  });
  it('GET restore and history never call mutation', async () => {
    const { app, owner } = await fixture();
    try {
      expect((await app.inject(base + '/message-requests/' + requestId)).statusCode).toBe(200);
      expect((await app.inject(base + '/messages?limit=50')).statusCode).toBe(200);
      expect(owner.send).not.toHaveBeenCalled();
      expect(owner.status).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
  it('denies anonymous/default-disabled before remote access', async () => {
    for (const [auth, enabled, code] of [
      [false, true, 401],
      [true, false, 503],
    ] as const) {
      const { app, owner } = await fixture(auth, enabled);
      try {
        expect((await app.inject(base + '/messages')).statusCode).toBe(code);
        expect(owner.history).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  });
  it('rejects client actor injection, missing key, malformed cursor/limit and unknown query', async () => {
    const { app, owner } = await fixture();
    try {
      for (const payload of [
        { requestId, text: 'x', userId: id(8) },
        { requestId, text: 'x' },
      ])
        expect(
          (await app.inject({ method: 'POST', url: base + '/message-requests', payload }))
            .statusCode,
        ).toBe(400);
      for (const q of ['limit=51', 'limit=0', 'cursor=bad%3D', 'userId=x'])
        expect((await app.inject(base + '/messages?' + q)).statusCode).toBe(400);
      expect(owner.send).not.toHaveBeenCalled();
      expect(owner.history).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('redacts owner access denial and original uncertainty', async () => {
    const { app, owner } = await fixture();
    try {
      owner.status.mockRejectedValue(new TournamentChatError('TOURNAMENT_CHAT_FORBIDDEN', 403));
      const r = await app.inject(base + '/message-requests/' + requestId);
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({
        code: 'TOURNAMENT_CHAT_FORBIDDEN',
        correlationId: id(9),
        message: 'Не удалось подтвердить состояние чата.',
      });
      expect(owner.send).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
