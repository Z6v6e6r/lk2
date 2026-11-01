import { describe, it, expect, vi } from 'vitest';
import { TournamentLocalOwnerClient } from './tournament-local-owner.js';
const id = '11111111-1111-4111-a111-111111111111';
const command = {
  schemaVersion: 1 as const,
  action: 'JOIN' as const,
  tournamentId: id,
  date: '2026-11-01',
};
const receipt = {
  schemaVersion: 1,
  tournamentId: id,
  operation: {
    operationId: id,
    action: 'JOIN',
    outcome: 'REGISTERED',
    reason: 'REGISTERED',
    generation: id,
    committedAt: '2026-10-31T12:00:00Z',
  },
  registration: { status: 'REGISTERED', asOf: '2026-10-31T12:00:01Z' },
};
function fixture(body: unknown = receipt) {
  const fetchImplementation = vi.fn(
    async () => await Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
  );
  return {
    fetchImplementation,
    client: new TournamentLocalOwnerClient({
      identityUrl: 'https://cup.example.test/api/internal/lk/identity/verify',
      integrationToken: 'synthetic-service-token',
      fetchImplementation,
    }),
  };
}
describe('CUP local transport', () => {
  it('uses explicit bounded private POST, actor and shared token, without delegation signer', async () => {
    const f = fixture();
    await f.client.command('synthetic-actor', 'original-key-value', command, id);
    expect(f.fetchImplementation).toHaveBeenCalledTimes(1);
    const [url, init] = f.fetchImplementation.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://cup.example.test/api/internal/tournaments/local-operations');
    expect(init.redirect).toBe('error');
    expect(init.body).toBe(JSON.stringify(command));
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer synthetic-actor',
      'Idempotency-Key': 'original-key-value',
    });
  });
  it.each([401, 403, 404, 409, 429, 500])(
    'does not retry status%s or downgrade to provider',
    async (status) => {
      const f = fixture();
      f.fetchImplementation.mockResolvedValue(new Response('{}', { status }));
      await expect(
        f.client.command('synthetic-actor', 'original-key-value', command, id),
      ).rejects.toThrow();
      expect(f.fetchImplementation).toHaveBeenCalledTimes(1);
    },
  );
  it('denies absent clientId, body limit, wrong origin and extra receipt fields', async () => {
    for (const body of [
      { ok: true, actor: { verified: true, source: 'cup-keycloak-jwt', tenantKey: 'tenant' } },
      { ...receipt, extra: true },
    ]) {
      const f = fixture(body);
      await expect(
        body === undefined
          ? f.client.identity('synthetic')
          : f.client.command('synthetic', 'original-key', command, id),
      ).rejects.toThrow();
    }
    const f = fixture();
    f.fetchImplementation.mockResolvedValue(new Response('x'.repeat(16385)));
    await expect(f.client.read('synthetic', command, id)).rejects.toThrow();
    const r = new Response(JSON.stringify(receipt));
    Object.defineProperty(r, 'url', { value: 'https://wrong.example.test' });
    f.fetchImplementation.mockResolvedValue(r);
    await expect(f.client.read('synthetic', command, id)).rejects.toThrow();
  });
  it('requires authenticated canonical clientId for owner identity', async () => {
    const f = fixture({
      ok: true,
      actor: { verified: true, source: 'cup-keycloak-jwt', tenantKey: 'tenant' },
    });
    await expect(f.client.identity('synthetic')).rejects.toThrow();
    f.fetchImplementation.mockResolvedValue(
      Response.json({
        ok: true,
        actor: { verified: true, source: 'cup-keycloak-jwt', tenantKey: 'tenant', clientId: '7' },
      }),
    );
    expect(await f.client.identity('synthetic')).toEqual({ tenantKey: 'tenant', clientId: '7' });
  });
  it('rejects source/unknown preparation; missing identity cannot become legacy', async () => {
    const f = fixture({
      schemaVersion: 1,
      nonBinding: true,
      tournamentId: id,
      date: command.date,
      status: 'UNKNOWN',
    });
    await expect(f.client.prepare('synthetic', id, command.date)).rejects.toThrow();
    expect(f.fetchImplementation).toHaveBeenCalledTimes(1);
  });
  it('bounds failures per phase, single half-open probe, redacted metrics cannot alter ACK', async () => {
    let now = 0,
      release!: (r: Response) => void;
    const fetchImplementation = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('network'));
    const onMetric =
      vi.fn<(metric: { phase: string; outcome: string; durationMs: number }) => void>();
    const client = new TournamentLocalOwnerClient({
      identityUrl: 'https://cup.example.test/api/internal/lk/identity/verify',
      integrationToken: 'synthetic',
      fetchImplementation,
      now: () => now,
      onMetric,
    });
    for (let i = 0; i < 3; i++)
      await expect(
        client.command('actor', 'original-key', command, id, 'correlation-test'),
      ).rejects.toThrow();
    await expect(client.command('actor', 'original-key', command, id)).rejects.toMatchObject({
      code: 'TOURNAMENT_LOCAL_OWNER_CIRCUIT_OPEN',
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    fetchImplementation.mockResolvedValue(Response.json(receipt));
    await client.read('actor', command, id);
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
    now = 30001;
    fetchImplementation.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const probe = client.command('actor', 'original-key', command, id, 'correlation-test');
    await expect(client.command('actor', 'original-key', command, id)).rejects.toMatchObject({
      code: 'TOURNAMENT_LOCAL_OWNER_CIRCUIT_OPEN',
    });
    onMetric.mockImplementation(() => {
      throw new Error('metrics-down');
    });
    release(Response.json(receipt));
    expect((await probe).operation.outcome).toBe('REGISTERED');
    expect(fetchImplementation.mock.calls[4]![1]?.headers).toMatchObject({
      'X-Correlation-ID': 'correlation-test',
    });
    expect(Object.keys(onMetric.mock.calls[0]![0]).sort()).toEqual([
      'durationMs',
      'outcome',
      'phase',
    ]);
  });
  it.each([400, 403, 409, 429])('actor refusal %s never opens shared circuit', async (status) => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(Response.json({}, { status })));
    const client = new TournamentLocalOwnerClient({
      identityUrl: 'https://cup.example.test/api/internal/lk/identity/verify',
      integrationToken: 'synthetic',
      fetchImplementation,
    });
    for (let i = 0; i < 4; i++)
      await expect(client.command('actor', 'original-key', command, id)).rejects.toThrow();
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
  });
  it('malformed successful upstream counts as unavailable', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(Response.json({ unexpected: true })));
    const client = new TournamentLocalOwnerClient({
      identityUrl: 'https://cup.example.test/api/internal/lk/identity/verify',
      integrationToken: 'synthetic',
      fetchImplementation,
    });
    for (let i = 0; i < 3; i++) await expect(client.read('actor', command, id)).rejects.toThrow();
    await expect(client.read('actor', command, id)).rejects.toMatchObject({
      code: 'TOURNAMENT_LOCAL_OWNER_CIRCUIT_OPEN',
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });
});
