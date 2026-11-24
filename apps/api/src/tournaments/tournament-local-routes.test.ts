import Fastify from 'fastify';
import { describe, it, expect, vi } from 'vitest';
import { registerTournamentLocalRoutes } from './tournament-local-routes.js';
import { TournamentLocalError } from '@phub/domain';
const id = '11111111-1111-4111-a111-111111111111',
  base = `/user/api/v1/local/tournaments/${id}/`;
async function fixture(auth = true) {
  const app = Fastify(),
    runtime = {
      execute: vi.fn(async () => await Promise.resolve({ ok: true })),
      retry: vi.fn(async () => await Promise.resolve({ ok: true })),
      read: vi.fn(async () => await Promise.resolve({ commandsEnabled: false, result: null })),
      playerGender: vi.fn(async () => await Promise.resolve({ gender: 'FEMALE', version: 1 })),
    };
  registerTournamentLocalRoutes(app, {
    runtime: runtime as never,
    handlers: [
      async (r) => {
        await Promise.resolve();
        if (auth) {
          r.tenantId = id;
          r.padlHubClaims = { sub: id, sid: id, permissions: ['profile.read'] } as never;
        }
      },
    ],
  });
  await app.ready();
  return { app, runtime };
}
describe('actual tournament route boundaries', () => {
  it('sets the authenticated profile only and rejects a caller-provided identity', async () => {
    const f = await fixture();
    const url = '/user/api/v1/local/profile/tournament-gender';
    const headers = { 'Idempotency-Key': 'original-profile-key' };
    const setting = { gender: 'FEMALE', expectedVersion: 0 };
    try {
      expect(
        (
          await f.app.inject({
            method: 'PUT',
            url,
            headers,
            payload: { ...setting, userId: 'other' },
          })
        ).statusCode,
      ).toBe(400);
      expect(f.runtime.playerGender).not.toHaveBeenCalled();
      const result = await f.app.inject({ method: 'PUT', url, headers, payload: setting });
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.json()).toEqual({ gender: 'FEMALE', version: 1 });
      expect(f.runtime.playerGender).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: id, tenantKey: 'local', userId: id, sessionId: id }),
        { input: setting, key: headers['Idempotency-Key'] },
      );
    } finally {
      await f.app.close();
    }
  });
  it('auth and exact body reject forged actor/sex/date before runtime', async () => {
    const f = await fixture();
    for (const body of [
      { action: 'JOIN', clientId: 'victim' },
      { action: 'JOIN', gender: 'MALE' },
      { action: 'JOIN', date: '2026-11-01' },
      { action: 'LEAVE' },
      null,
    ]) {
      const r = await f.app.inject({
        method: 'POST',
        url: base + 'registrations',
        payload: JSON.stringify(body),
        headers: { 'Idempotency-Key': 'original-command-key', 'Content-Type': 'application/json' },
      });
      expect(r.statusCode).toBe(400);
    }
    expect(f.runtime.execute).not.toHaveBeenCalled();
    await f.app.close();
  });
  it('typed cross-key errors are sanitized; retry requires key and no body', async () => {
    const f = await fixture();
    f.runtime.read.mockRejectedValue(
      new TournamentLocalError('TOURNAMENT_LOCAL_KEY_CONFLICT', 409),
    );
    expect(
      (await f.app.inject({ method: 'GET', url: base + 'registration-operation' })).statusCode,
    ).toBe(409);
    expect(
      (await f.app.inject({ method: 'POST', url: base + `registration-operations/${id}/retry` }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: base + `registration-operations/${id}/retry`,
          headers: { 'Idempotency-Key': id },
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(f.runtime.retry).not.toHaveBeenCalled();
    await f.app.close();
  });
  it('passes current authenticated session only and read is separate from mutation', async () => {
    const f = await fixture();
    const r = await f.app.inject({
      method: 'POST',
      url: base + 'registrations',
      headers: { 'Idempotency-Key': 'original-command-key' },
      payload: { action: 'JOIN' },
    });
    expect(r.statusCode).toBe(200);
    expect(f.runtime.execute).toHaveBeenCalledWith(
      expect.objectContaining({ userId: id, tenantId: id, sessionId: id }),
      id,
      'original-command-key',
      { action: 'JOIN' },
    );
    expect(r.headers['cache-control']).toBe('no-store');
    await f.app.close();
    const unauth = await fixture(false);
    expect(
      (await unauth.app.inject({ method: 'GET', url: base + 'registration-operation' })).statusCode,
    ).toBe(401);
    expect(unauth.runtime.read).not.toHaveBeenCalled();
    await unauth.app.close();
  });
  it('accepts only Android empty text retry, preserving original operation and command semantics', async () => {
    const f = await fixture();
    for (const contentType of ['text/plain', 'text/plain; charset=UTF-8']) {
      const r = await f.app.inject({
        method: 'POST',
        url: base + `registration-operations/${id}/retry`,
        headers: { 'Idempotency-Key': id, 'Content-Type': contentType },
        payload: '',
      });
      expect(r.statusCode).toBe(200);
    }
    expect(f.runtime.retry).toHaveBeenCalledTimes(2);
    expect(f.runtime.retry).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: id, tenantId: id }),
      id,
      id,
    );
    for (const [contentType, payload] of [
      ['text/plain', ' '],
      ['text/plain', '{}'],
      ['text/plain', '{"action":"JOIN"}'],
      ['application/json', '{}'],
      ['application/json', '""'],
      ['application/x-www-form-urlencoded', ''],
      ['text/plain; charset=ascii', ''],
    ] as const) {
      const r = await f.app.inject({
        method: 'POST',
        url: base + `registration-operations/${id}/retry`,
        headers: { 'Idempotency-Key': id, 'Content-Type': contentType },
        payload,
      });
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(f.runtime.retry).toHaveBeenCalledTimes(2);
    expect(f.runtime.execute).not.toHaveBeenCalled();
    await f.app.close();
  });
  it('returns explicit disabled status without mutation', async () => {
    const f = await fixture();
    const response = await f.app.inject({ method: 'GET', url: base + 'registration-operation' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ commandsEnabled: false, result: null });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(f.runtime.execute).not.toHaveBeenCalled();
    expect(f.runtime.retry).not.toHaveBeenCalled();
    await f.app.close();
  });
});
