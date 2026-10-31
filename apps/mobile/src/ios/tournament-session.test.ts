import { TournamentLocalAttempts } from '../../../web/src/tournament-local-attempt.js';
import { describe, it, expect, vi } from 'vitest';
import { createIOSFetch, type IOSSessionPlugin } from './session.js';
import { createIOSTournamentGateway } from './tournament-gateway.js';
import {
  auth,
  config,
  fixtureReply,
  nativeResult,
  syntheticSession,
} from './testing/cabinet-fixtures.js';
const id = '11111111-1111-4111-8111-111111111111',
  key = '22222222-2222-4222-8222-222222222222';
const user = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}/tournaments/${id}`;
const publicRoot = `${config.apiBaseUrl}/public/api/v1/${config.tenantKey}/tournaments`;
const range = '?dateFrom=2026-11-01&dateTo=2026-11-16';
const headers = { authorization: 'Bearer synthetic-access', 'idempotency-key': key };
function bridge() {
  const request = vi.fn<IOSSessionPlugin['request']>().mockResolvedValue(nativeResult({}));
  return {
    request,
    fetch: createIOSFetch(config, { configuration: () => Promise.resolve(config), request }),
  };
}
describe('concrete iOS tournament wire and lifecycle', () => {
  it('translates exact public and private resources, without passing a URL or cookie', async () => {
    const f = bridge();
    await f.fetch(publicRoot + range);
    expect(f.request).toHaveBeenLastCalledWith({
      operation: 'tournament',
      resource: 'list',
      query: { dateFrom: '2026-11-01', dateTo: '2026-11-16' },
      headers: {},
    });
    await f.fetch(user + '/registrations', { method: 'POST', headers, body: '{"action":"JOIN"}' });
    await f.fetch(user + `/registration-operations/${key}/retry`, { method: 'POST', headers });
    expect(f.request).toHaveBeenLastCalledWith({
      operation: 'tournament',
      resource: 'retry',
      resourceId: id,
      operationId: key,
      query: {},
      headers,
    });
    await f.fetch(user + `/registration-operation?operationId=${key}`, { headers });
    expect(f.request).toHaveBeenLastCalledWith({
      operation: 'tournament',
      resource: 'status',
      resourceId: id,
      operationId: key,
      query: {},
      headers,
    });
  });
  it.each([
    publicRoot + range + '&dateFrom=2026-11-02',
    publicRoot + '?dateFrom=2026-02-30&dateTo=2026-03-01',
    publicRoot + range + '&clientId=7',
    publicRoot.replace('local-padel', 'foreign') + range,
    publicRoot.replace('tournaments', 'games') + range,
    user + '/registration-operation?operationId=' + key + '&operationId=' + key,
    user + '/registrations?x=1',
  ])('rejects widened query/path before plugin: %s', async (url) => {
    const f = bridge();
    await expect(f.fetch(url)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it('rejects credentials on public and forged/duplicate command fields', async () => {
    const f = bridge();
    for (const h of [headers, { cookie: 'synthetic' }])
      await expect(f.fetch(publicRoot + range, { headers: h })).rejects.toThrow();
    for (const body of [
      '{}',
      '{"action":"JOIN","action":"JOIN"}',
      '{"action":"JOIN","gender":"MALE"}',
      '{"action":"LEAVE"}',
    ]) {
      await expect(
        f.fetch(user + '/registrations', { method: 'POST', headers, body }),
      ).rejects.toThrow();
    }
    await expect(
      f.fetch(user + `/registration-operations/${key}/retry`, {
        method: 'POST',
        headers,
        body: '',
      }),
    ).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each([401, 503, 'network'] as const)(
    'actual SDK never refreshes/replays command after %s',
    async (failure) => {
      const request = vi.fn<IOSSessionPlugin['request']>(async (input) => {
        await Promise.resolve();
        if (input.operation !== 'tournament') return fixtureReply(input);
        if (failure === 'network')
          throw Object.assign(new Error('synthetic offline'), {
            code: 'NATIVE_NETWORK_UNAVAILABLE',
          });
        return nativeResult({ code: 'UNAVAILABLE' }, failure);
      });
      const session = syntheticSession(request);
      await session.restore();
      request.mockClear();
      await expect(
        createIOSTournamentGateway(session).commandTournament!(id, { action: 'JOIN' }, key),
      ).rejects.toThrow();
      expect(request.mock.calls.filter(([r]) => r.operation === 'tournament')).toHaveLength(1);
      expect(request.mock.calls.filter(([r]) => r.operation === 'refresh')).toHaveLength(0);
    },
  );
  it('closes before outer push cleanup and rejects late ACK, restore cannot reopen the fence', async () => {
    let finish!: (value: ReturnType<typeof nativeResult>) => void;
    const request = vi.fn<IOSSessionPlugin['request']>((input) =>
      input.operation === 'tournament'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(fixtureReply(input)),
    );
    const session = syntheticSession(request);
    await session.restore();
    const gateway = createIOSTournamentGateway(session),
      principal = gateway.tournamentPrincipal!();
    const command = gateway.commandTournament!(id, { action: 'JOIN' }, key);
    const rejected = expect(command).rejects.toMatchObject({ name: 'AbortError' });
    session.closeTournament();
    expect(gateway.tournamentPrincipal!()).toBeNull();
    await expect(gateway.commandTournament!(id, { action: 'JOIN' }, key)).rejects.toThrow();
    finish(nativeResult({ synthetic: 'late ACK' }));
    await rejected;
    await session.restore();
    expect(gateway.tournamentPrincipal!()).toBeNull();
    expect(principal).toContain(auth.context.userId);
  });
  it('queued custody lock cannot dispatch after logout starts', async () => {
    const request = vi.fn<IOSSessionPlugin['request']>(
      async (input) => await Promise.resolve(fixtureReply(input)),
    );
    const session = syntheticSession(request);
    await session.restore();
    request.mockClear();
    const gateway = createIOSTournamentGateway(session),
      token = gateway.tournamentPrincipal!();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const map = new Map<string, string>();
    const attempts = new TournamentLocalAttempts(
      { tenantId: auth.context.tenantId, userId: auth.context.userId },
      {
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => {
          map.set(k, v);
        },
        removeItem: (k) => {
          map.delete(k);
        },
      },
      {
        request: async <T>(_n: string, _o: unknown, f: () => T | PromiseLike<T>) => {
          await waiting;
          return await f();
        },
      },
      gateway,
      () => gateway.tournamentPrincipal!() === token,
    );
    const pending = attempts.submit(id, { action: 'JOIN' });
    const rejected = expect(pending).rejects.toThrow('TOURNAMENT_ACCOUNT_CHANGED');
    session.closeTournament();
    release();
    await rejected;
    expect(request).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });
  it('verification started before a new logout fence cannot reopen tournament principal', async () => {
    const request = vi.fn<IOSSessionPlugin['request']>(
      async (input) =>
        await Promise.resolve(
          input.operation === 'refresh'
            ? nativeResult({ code: 'AUTH_REQUIRED' }, 401)
            : fixtureReply(input),
        ),
    );
    const session = syntheticSession(request);
    await session.restore();
    const verifying = session.verify(id, '1234');
    session.closeTournament();
    await verifying;
    expect(session.tournamentPrincipal()).toBeNull();
  });
});
