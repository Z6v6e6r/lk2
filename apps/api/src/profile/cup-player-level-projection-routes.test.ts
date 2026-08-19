import type { CupPlayerLevelProjectionRepository } from '@phub/database';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerCupPlayerLevelProjectionRoutes } from './cup-player-level-projection-routes.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const token = 'cup-player-level-token-at-least-32-characters';
const apps: FastifyInstance[] = [];

function payload() {
  return {
    schemaVersion: 1,
    sourceEventId: 'rating_evt:00000000-0000-4000-8000-000000000042',
    sourceRevision: 4,
    occurredAt: '2026-08-19T10:00:00.000Z',
    player: { externalClientId: 'viva-client-42' },
    sportCode: 'PADEL',
    level: { code: 'C+', numericValue: 3.63 },
    source: {
      eventType: 'RATING_MANUALLY_CHANGED',
      formulaVersion: 'padel-rating-grade-v1',
    },
  } as const;
}

async function appWith(repository: CupPlayerLevelProjectionRepository, enabled = true) {
  const app = Fastify();
  registerCupPlayerLevelProjectionRoutes(app, {
    enabled,
    integrationToken: token,
    authorizedTenantKey: 'local-padel',
    repository,
    commandHandlers: [
      (request) => {
        request.tenantId = tenantId;
        return Promise.resolve();
      },
    ],
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('CUP player level projection routes', () => {
  it('accepts only the server projection contract and forwards no client-owned user id', async () => {
    const apply = vi.fn().mockResolvedValue({
      outcome: 'applied',
      replayed: false,
      level: {
        playerId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
        sportCode: 'PADEL',
        levelId: '95a76d36-d8a7-4ff5-a988-84f33c0fd05a',
        code: 'C+',
        title: 'C+',
        rank: 4,
        source: 'MANUAL',
        numericValue: 3.63,
        scaleVersion: 1,
        updatedAt: '2026-08-19T10:00:00.000Z',
      },
    });
    const app = await appWith({ apply });
    const body = payload();
    const response = await app.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/player-level-projections',
      headers: {
        'x-cup-player-level-token': token,
        'idempotency-key': body.sourceEventId,
      },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        externalClientId: 'viva-client-42',
        levelCode: 'C+',
        sourceRevision: 4,
      }),
    );
    expect(apply.mock.calls[0]?.[0]).not.toHaveProperty('playerId');
  });

  it('is fail-closed when disabled or supplied with a wrong server token', async () => {
    const apply = vi.fn();
    const disabled = await appWith({ apply }, false);
    const disabledResponse = await disabled.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/player-level-projections',
      headers: { 'x-cup-player-level-token': token },
      payload: payload(),
    });
    expect(disabledResponse.statusCode).toBe(503);

    const enabled = await appWith({ apply });
    const forbidden = await enabled.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/player-level-projections',
      headers: {
        'x-cup-player-level-token': 'wrong-token-with-at-least-32-characters',
        'idempotency-key': payload().sourceEventId,
      },
      payload: payload(),
    });
    expect(forbidden.statusCode).toBe(403);
    expect(apply).not.toHaveBeenCalled();
  });

  it('does not let a valid integration token cross its configured tenant boundary', async () => {
    const apply = vi.fn();
    const app = await appWith({ apply });
    const body = payload();
    const response = await app.inject({
      method: 'POST',
      url: '/internal/api/v1/another-tenant/player-level-projections',
      headers: {
        'x-cup-player-level-token': token,
        'idempotency-key': body.sourceEventId,
      },
      payload: body,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'CUP_PLAYER_LEVEL_TENANT_FORBIDDEN' });
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects client-owned identity and requires the event id as idempotency key', async () => {
    const apply = vi.fn();
    const app = await appWith({ apply });
    const invalid = await app.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/player-level-projections',
      headers: {
        'x-cup-player-level-token': token,
        'idempotency-key': 'different-event-id',
      },
      payload: { ...payload(), playerId: 'client-controlled-user', rank: 7 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects an unsupported CUP formula version without recalculating its normalized code', async () => {
    const apply = vi.fn();
    const app = await appWith({ apply });
    const body = payload();
    const response = await app.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/player-level-projections',
      headers: {
        'x-cup-player-level-token': token,
        'idempotency-key': body.sourceEventId,
      },
      payload: { ...body, source: { ...body.source, formulaVersion: 'unknown-formula-v2' } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'CUP_PLAYER_LEVEL_FORMULA_MISMATCH' });
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects unknown provenance instead of relabeling it as calculated', async () => {
    const apply = vi.fn();
    const app = await appWith({ apply });
    const body = payload();
    const response = await app.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/player-level-projections',
      headers: {
        'x-cup-player-level-token': token,
        'idempotency-key': body.sourceEventId,
      },
      payload: { ...body, source: { ...body.source, eventType: 'RATING_UNKNOWN' } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'CUP_PLAYER_LEVEL_PROJECTION_INVALID' });
    expect(apply).not.toHaveBeenCalled();
  });
});
