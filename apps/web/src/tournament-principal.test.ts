// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createBrowserAuthGateway } from './auth-gateway.js';
const id = '11111111-1111-4111-a111-111111111111';
const session = {
  accessToken: 'synthetic-access-token',
  tokenType: 'Bearer',
  expiresAt: '2099-01-01T00:00:00Z',
  user: { id, displayName: 'Synthetic' },
  context: {
    tenantId: id,
    userId: id,
    displayName: 'Synthetic',
    phoneLast4: '0001',
    roles: ['client'],
    permissions: ['profile.read'],
  },
};
describe('tournament-only principal fence', () => {
  it.each([false, true])('invalidates before slow logout finishes, failure=%s', async (fail) => {
    let resolve!: (v: Response) => void, reject!: (e: Error) => void;
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(session)))
      .mockImplementationOnce(
        () =>
          new Promise((r, j) => {
            resolve = r;
            reject = j;
          }),
      );
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.example.test',
      tenantKey: 'local',
      appVersion: 'test',
      fetchImplementation,
    });
    await gateway.restoreSession();
    const before = gateway.tournamentPrincipal!();
    expect(before).toContain(id);
    const out = gateway.logout();
    expect(gateway.tournamentPrincipal!()).toBeNull();
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    if (fail) {
      reject(new Error('revoke_failed'));
      await expect(out).rejects.toThrow();
    } else {
      resolve(new Response(null, { status: 204 }));
      await out;
    }
    expect(gateway.tournamentPrincipal!()).toBeNull();
  });
  it.each([false, true])(
    'late restore during logout never reopens tournament gate, failure=%s',
    async (fail) => {
      let refresh!: (r: Response) => void,
        revoke!: (r: Response) => void,
        reject!: (e: Error) => void;
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(session))
        .mockImplementationOnce(
          () =>
            new Promise((r) => {
              refresh = r;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((r, j) => {
              revoke = r;
              reject = j;
            }),
        );
      const gateway = createBrowserAuthGateway({
        baseUrl: 'https://api.example.test',
        tenantKey: 'local',
        appVersion: 'test',
        fetchImplementation,
      });
      await gateway.restoreSession();
      const restoring = gateway.restoreSession();
      await vi.waitFor(() => expect(refresh).toBeTypeOf('function'));
      const logout = gateway.logout();
      await vi.waitFor(() => expect(revoke).toBeTypeOf('function'));
      refresh(Response.json(session));
      await restoring;
      expect(gateway.tournamentPrincipal!()).toBeNull();
      if (fail) {
        reject(new Error('revoke_failed'));
        await expect(logout).rejects.toThrow();
      } else {
        revoke(new Response(null, { status: 204 }));
        await logout;
      }
      expect(gateway.tournamentPrincipal!()).toBeNull();
    },
  );
  it('authentication started during overlapping logouts cannot reopen after the first revoke', async () => {
    const pending: Array<(r: Response) => void> = [];
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(session))
      .mockImplementation(
        () =>
          new Promise((r) => {
            pending.push(r);
          }),
      );
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.example.test',
      tenantKey: 'local',
      appVersion: 'test',
      fetchImplementation,
    });
    await gateway.restoreSession();
    const one = gateway.logout(),
      two = gateway.logout();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[0]!(new Response(null, { status: 204 }));
    await expect(one).rejects.toMatchObject({ code: 'AUTH_PRINCIPAL_CHANGED' });
    const auth = gateway.verifyCode({
      challengeId: id,
      code: '000000',
      acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
    });
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    pending[1]!(new Response(null, { status: 204 }));
    await expect(two).rejects.toMatchObject({ code: 'AUTH_PRINCIPAL_CHANGED' });
    pending[2]!(Response.json(session));
    await auth;
    expect(gateway.tournamentPrincipal!()).toBeNull();
    const fresh = gateway.verifyCode({
      challengeId: id,
      code: '000000',
      acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
    });
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    pending[3]!(Response.json(session));
    await fresh;
    expect(gateway.tournamentPrincipal!()).toContain(id);
  });
});
