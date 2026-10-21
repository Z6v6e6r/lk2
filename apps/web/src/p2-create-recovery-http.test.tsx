// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { loadConfig } from '@phub/config';
import { createGameRepository } from '@phub/database';
import { PadlHubApiClient } from '@phub/api-sdk';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAppWithActiveSession } from '../../api/src/testing/build-test-app.js';
import { CreateGamePage } from './CreateGamePage.js';
import type { AuthGateway } from './auth-gateway.js';
import type { CreateGameAttemptLockManager } from './create-game-attempt.js';
import { loadCreateGameAttemptLedger } from './create-game-attempt.js';

// JOSE and Node WebCrypto use the Node typed-array realm under jsdom.
vi.stubGlobal('Uint8Array', new TextEncoder().encode('').constructor);

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const stationId = 'bd35543d-c565-443a-bd3d-eea68eb2fbe6';
const gameId = '6418f90b-0fa6-4c04-a3da-57707e2f0ae2';
const principal = { tenantId, userId: actorUserId };
const apps: Awaited<ReturnType<typeof buildAppWithActiveSession>>[] = [];
afterEach(async () => {
  cleanup();
  window.localStorage.clear();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

// Synthetic SQL fixture records the writes made by the actual repository. This is
// HTTP/UI integration evidence, not physical PostgreSQL or provider acceptance.
function canonicalFixture() {
  const writes: string[] = [];
  let row: Record<string, unknown> | undefined;
  const query = vi.fn(
    async (
      sql: string,
      values: readonly unknown[] = [],
    ): Promise<{ rows: Record<string, unknown>[] }> => {
      await Promise.resolve();
      if (/\b(insert|update|delete)\b/i.test(sql) && !/for update/.test(sql)) writes.push(sql);
      if (sql.includes('identity.tenants')) return { rows: [{ id: tenantId }] };
      if (sql.includes('from locations.profiles')) return { rows: [{ id: stationId }] };
      if (sql.includes('as admissible')) return { rows: [{ admissible: true }] };
      if (sql.includes('insert into games.games'))
        return {
          rows: [
            {
              id: gameId,
              tenant_id: tenantId,
              revision: 1,
              organizer_user_id: actorUserId,
              title: values[2],
              kind: values[3],
              visibility: values[4],
              lifecycle_state: values[18],
              station_id: stationId,
              court_id: null,
              booking_id: null,
              starts_at: values[7],
              ends_at: values[8],
              timezone: values[9],
              capacity: values[10],
              waitlist_enabled: values[11],
              join_cutoff_at: values[12],
              payment_mode: 'NO_PAYMENT',
              level_from: null,
              level_to: null,
              result_state: 'NOT_AVAILABLE',
              card_projection_revision: null,
              created_at: '2026-10-13T10:00:00Z',
              updated_at: '2026-10-13T10:00:00Z',
            },
          ],
        };
      if (sql.includes('insert into games.command_idempotency')) {
        row = {
          id: values[1],
          actor_user_id: values[2],
          principal_key: values[3],
          idempotency_key: values[4],
          command_type: 'game.create.v1',
          request_hash: values[5],
          aggregate_id: values[6],
          state: 'COMPLETED',
          result_payload: JSON.parse(String(values[7])),
          completed_at: '2026-10-13T10:00:00Z',
        };
        return { rows: [] };
      }
      if (sql.includes('select c.id, c.aggregate_id'))
        return {
          rows:
            row &&
            values[0] === tenantId &&
            values[1] === row.actor_user_id &&
            values[2] === row.principal_key &&
            values[3] === row.idempotency_key
              ? [row]
              : [],
        };
      if (sql.includes('from games.command_idempotency')) return { rows: [] };
      return { rows: [] };
    },
  );
  const pool = {
    query,
    connect: () => Promise.resolve({ query, release: () => undefined }),
  } as unknown as Pool;
  return { pool, writes, query, getRow: () => row! };
}

describe('P2 page → actual SDK → actual HTTP handler → canonical CREATE repository', () => {
  it('loses the accepted response, reloads twice and reads same operation/game/key with one CREATE', async () => {
    const config = loadConfig({
      APP_ENV: 'ci',
      DATABASE_URL: 'postgresql://synthetic:test@localhost/synthetic',
      REDIS_URL: 'redis://localhost:6379',
      RABBITMQ_URL: 'amqp://localhost',
      JWT_ISSUER: 'synthetic-p2',
      JWT_AUDIENCE: 'synthetic-p2-api',
      JWT_ACCESS_SECRET: 'synthetic-p2-access-secret-at-least-32-characters',
      JWT_REFRESH_SECRET: 'synthetic-p2-refresh-secret-at-least-32-characters',
    });
    const fixture = canonicalFixture();
    const repository = createGameRepository(fixture.pool);
    const app = await buildAppWithActiveSession({
      config,
      logger: createLogger('synthetic-p2', 'silent'),
      pool: fixture.pool,
      gameCommandRepository: repository,
    });
    apps.push(app);
    const token = await new SignJWT({
      tenants: [tenantId],
      roles: ['client'],
      permissions: ['games.play'],
      sid: '55555555-5555-4555-8555-555555555555',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(actorUserId)
      .setIssuer(config.JWT_ISSUER)
      .setAudience(config.JWT_AUDIENCE)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
    const requests: { method: string; path: string }[] = [];
    let lose = true;
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const method = init?.method ?? 'GET';
      requests.push({ method, path: url.pathname });
      const response = await app.inject({
        method: method as 'GET' | 'POST',
        url: url.pathname,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
      });
      if (method === 'POST' && lose) {
        lose = false;
        expect(response.statusCode).toBe(202);
        throw new TypeError('response lost after canonical commit');
      }
      return new Response(response.body, {
        status: response.statusCode,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const sdk = new PadlHubApiClient({
      baseUrl: 'http://synthetic-p2.test',
      tenantKey: 'local-padel',
      platform: 'web',
      appVersion: 'p2-test',
      initialAccessToken: token,
      fetchImplementation,
    });
    const gateway = {
      listLocations: () =>
        Promise.resolve({ items: [{ id: stationId, title: 'Синтетическая станция' }] }),
      createGame: sdk.createGame.bind(sdk),
      getGameCreateOperation: sdk.getGameCreateOperation.bind(sdk),
    } as unknown as AuthGateway;
    const navigate = vi.fn();
    const locks: CreateGameAttemptLockManager = {
      request: (_name, _options, callback) => Promise.resolve().then(callback),
    };
    const props = {
      gateway,
      principal,
      navigate,
      attemptStorage: window.localStorage,
      attemptLockManager: locks,
    };
    const view = render(
      <CreateGamePage {...props} attemptLockManager={props.attemptLockManager} />,
    );
    await screen.findByRole('option', { name: 'Синтетическая станция' });
    await userEvent.click(screen.getByRole('button', { name: 'Создать игру' }));
    await waitFor(() => expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1), {
      timeout: 5000,
    });
    await screen.findByText(/Связь прервалась/, {}, { timeout: 5000 });
    const original = loadCreateGameAttemptLedger(principal, window.localStorage).activeAttempt!;
    const canonical = fixture.getRow();
    expect(canonical.idempotency_key).toBe(original.idempotencyKey);
    const writeCount = fixture.writes.length;
    view.unmount();
    render(<CreateGamePage {...props} attemptLockManager={props.attemptLockManager} />);
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(expect.stringContaining(`/games/${gameId}?created=1`)),
    );
    cleanup();
    render(<CreateGamePage {...props} attemptLockManager={props.attemptLockManager} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(2));
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(requests.filter((r) => r.method === 'GET')).toHaveLength(2);
    expect(fixture.writes).toHaveLength(writeCount);
    expect(fixture.writes.filter((sql) => sql.includes('insert into games.games'))).toHaveLength(1);
    expect(
      loadCreateGameAttemptLedger(principal, window.localStorage).resolvedAttempts[0],
    ).toMatchObject({
      attemptId: original.attemptId,
      idempotencyKey: original.idempotencyKey,
      operationId: canonical.id,
      gameId,
    });
    // Same key alone cannot discover another actor's canonical operation.
    expect(
      await repository.getCreateOperation!({
        tenantId,
        actorUserId: stationId,
        idempotencyKey: original.idempotencyKey,
      }),
    ).toBeUndefined();
    expect(
      await repository.getCreateOperation!({
        tenantId: stationId,
        actorUserId,
        idempotencyKey: original.idempotencyKey,
      }),
    ).toBeUndefined();
  });
});
