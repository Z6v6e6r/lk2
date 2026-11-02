// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createBrowserAuthGateway } from './auth-gateway.js';
const urlOf = (value: Parameters<typeof fetch>[0]) =>
  typeof value === 'string' ? value : value instanceof URL ? value.href : value.url;
const id = '10000000-0000-4000-8000-000000000001';
const session = {
  accessToken: 'synthetic',
  tokenType: 'Bearer',
  expiresAt: '2099-01-01T00:00:00.000Z',
  user: { id, displayName: 'Synthetic' },
  context: {
    userId: id,
    tenantId: '10000000-0000-4000-8000-000000000002',
    displayName: 'Synthetic',
    phoneLast4: '0001',
    roles: ['client'],
    permissions: [],
  },
};
it.each(['web', 'android'] as const)(
  'actual %s gateway refuses late tournament ACK after logout and no automatic retry',
  async (platform) => {
    let finish!: (r: Response) => void;
    const transport = vi.fn<typeof fetch>((raw) => {
      const url = raw instanceof Request ? raw.url : raw.toString();
      if (url.includes('/chat/message-requests'))
        return new Promise((r) => {
          finish = r;
        });
      if (url.endsWith('/auth/logout')) return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(Response.json(session));
    });
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.invalid',
      tenantKey: 'synthetic',
      appVersion: 'test',
      platform,
      nativeSessionTransport: platform === 'android',
      fetchImplementation: transport,
    });
    await gateway.restoreSession();
    expect(gateway.tournamentChatPrincipal!()).not.toBeNull();
    const pending = gateway.getTournamentChatRequest!(id, id);
    const assertion = expect(pending).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
    await gateway.logout();
    finish(
      Response.json({
        contractVersion: 'tournament-chat.v1',
        tournamentId: id,
        requestId: id,
        status: 'UNKNOWN',
      }),
    );
    await assertion;
    await expect(gateway.getTournamentChatRequest!(id, id)).rejects.toThrow(
      'AUTH_PRINCIPAL_CHANGED',
    );
    expect(
      transport.mock.calls.filter((c) =>
        (c[0] instanceof Request ? c[0].url : c[0].toString()).includes('/chat/'),
      ),
    ).toHaveLength(1);
  },
);
it('native gateway denies tournament chat without an authenticated principal', async () => {
  const transport = vi.fn<typeof fetch>();
  const gateway = createBrowserAuthGateway({
    baseUrl: 'https://api.invalid',
    tenantKey: 'synthetic',
    appVersion: 'test',
    platform: 'android',
    fetchImplementation: transport,
  });
  expect(gateway.tournamentChatPrincipal!()).toBeNull();
  await expect(
    gateway.sendTournamentChatMessage!(id, { requestId: id, text: 'x' }),
  ).rejects.toThrow();
  await expect(gateway.getTournamentChatRequest!(id, id)).rejects.toThrow();
  await expect(gateway.getTournamentChatHistory!(id)).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});

it('READ cannot dispatch after logout begins while hashing and revoke are both pending', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
  let finishHash!: () => void;
  let finishLogout!: (response: Response) => void;
  const spy = vi.spyOn(webcrypto.subtle, 'digest').mockImplementationOnce(
    (...args) =>
      new Promise((resolve, reject) => {
        finishHash = () => {
          void digest(...args).then(resolve, reject);
        };
      }),
  );
  const transport = vi.fn<typeof fetch>((raw, init) => {
    const url = raw instanceof Request ? raw.url : raw.toString();
    if (url.endsWith('/auth/session') && init?.method === 'DELETE')
      return new Promise((resolve) => {
        finishLogout = resolve;
      });
    if (url.endsWith('/chat/read-requests')) throw Error('READ_POST_ESCAPED_LOGOUT');
    return Promise.resolve(Response.json(session));
  });
  const gateway = createBrowserAuthGateway({
    baseUrl: 'https://api.invalid',
    tenantKey: 'synthetic',
    appVersion: 'test',
    fetchImplementation: transport,
  });
  try {
    await gateway.restoreSession();
    const pending = gateway.advanceTournamentChatRead!(id, {
      requestId: id,
      streamId: id,
      witnessHash: 'a'.repeat(64),
      throughSequence: 1,
    });
    const rejected = expect(pending).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
    expect(finishHash).toBeTypeOf('function');
    const logout = gateway.logout();
    expect(finishLogout).toBeTypeOf('function');
    expect(gateway.tournamentChatPrincipal!()).toBeNull();
    finishHash();
    await rejected;
    expect(
      transport.mock.calls.filter((call) => urlOf(call[0]).endsWith('/chat/read-requests')),
    ).toHaveLength(0);
    finishLogout(new Response(null, { status: 204 }));
    await logout;
  } finally {
    spy.mockRestore();
    vi.unstubAllGlobals();
  }
});

it.each(['web', 'android'] as const)(
  'READ still dispatches exactly once for the unchanged %s gateway principal',
  async (platform) => {
    vi.stubGlobal('crypto', webcrypto);
    const transport = vi.fn<typeof fetch>((raw) =>
      Promise.resolve(
        Response.json(
          urlOf(raw).endsWith('/chat/read-requests')
            ? {
                contractVersion: 'tournament-chat-read.v1',
                tournamentId: id,
                requestId: id,
                status: 'UNKNOWN',
              }
            : session,
        ),
      ),
    );
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.invalid',
      tenantKey: 'synthetic',
      appVersion: 'test',
      platform,
      nativeSessionTransport: platform === 'android',
      fetchImplementation: transport,
    });
    try {
      await gateway.restoreSession();
      const result = await gateway.advanceTournamentChatRead!(id, {
        requestId: id,
        streamId: id,
        witnessHash: 'a'.repeat(64),
        throughSequence: 1,
      });
      expect(result.status).toBe('UNKNOWN');
      const calls = transport.mock.calls.filter((call) =>
        urlOf(call[0]).endsWith('/chat/read-requests'),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]![1]?.method).toBe('POST');
      expect(new Headers(calls[0]![1]?.headers).get('Idempotency-Key')).toBe(id);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it.each(['revoke-pending', 'reauthenticated-session'] as const)(
  'MESSAGE cannot dispatch after original principal closes during digest (%s)',
  async (phase) => {
    vi.stubGlobal('crypto', webcrypto);
    const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
    let finishHash!: () => void;
    let finishLogout!: (response: Response) => void;
    let logout: Promise<void> | undefined;
    const spy = vi.spyOn(webcrypto.subtle, 'digest').mockImplementationOnce(
      (...args) =>
        new Promise((resolve, reject) => {
          finishHash = () => {
            void digest(...args).then(resolve, reject);
          };
        }),
    );
    const transport = vi.fn<typeof fetch>((raw, init) => {
      const url = urlOf(raw);
      if (url.endsWith('/auth/session') && init?.method === 'DELETE')
        return new Promise((resolve) => {
          finishLogout = resolve;
        });
      if (url.endsWith('/chat/message-requests'))
        return Promise.resolve(
          Response.json({
            contractVersion: 'tournament-chat.v1',
            tournamentId: id,
            requestId: id,
            status: 'UNKNOWN',
          }),
        );
      return Promise.resolve(Response.json(session));
    });
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.invalid',
      tenantKey: 'synthetic',
      appVersion: 'test',
      fetchImplementation: transport,
    });
    try {
      await gateway.restoreSession();
      const original = gateway.tournamentChatPrincipal!();
      const pending = gateway.sendTournamentChatMessage!(id, {
        requestId: id,
        text: 'Synthetic original message',
      });
      const rejected = expect(pending).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
      expect(finishHash).toBeTypeOf('function');
      logout = gateway.logout();
      expect(finishLogout).toBeTypeOf('function');
      expect(gateway.tournamentChatPrincipal!()).toBeNull();
      if (phase === 'reauthenticated-session') {
        finishLogout(new Response(null, { status: 204 }));
        await logout;
        await gateway.verifyCode({
          challengeId: id,
          code: '000000',
          acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
        });
        expect(gateway.tournamentChatPrincipal!()).not.toBeNull();
        expect(gateway.tournamentChatPrincipal!()).not.toBe(original);
      }
      finishHash();
      await rejected;
      expect(
        transport.mock.calls.filter((call) => urlOf(call[0]).endsWith('/chat/message-requests')),
      ).toHaveLength(0);
    } finally {
      finishLogout?.(new Response(null, { status: 204 }));
      await logout;
      spy.mockRestore();
      vi.unstubAllGlobals();
    }
  },
);

it('MESSAGE submits original UUID and exact body once for unchanged gateway principal', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const transport = vi.fn<typeof fetch>((raw) =>
    Promise.resolve(
      Response.json(
        urlOf(raw).endsWith('/chat/message-requests')
          ? {
              contractVersion: 'tournament-chat.v1',
              tournamentId: id,
              requestId: id,
              status: 'UNKNOWN',
            }
          : session,
      ),
    ),
  );
  const gateway = createBrowserAuthGateway({
    baseUrl: 'https://api.invalid',
    tenantKey: 'synthetic',
    appVersion: 'test',
    fetchImplementation: transport,
  });
  const input = { requestId: id, text: '  Synthetic original\n🙂  ' };
  try {
    await gateway.restoreSession();
    expect((await gateway.sendTournamentChatMessage!(id, input)).status).toBe('UNKNOWN');
    const calls = transport.mock.calls.filter((call) =>
      urlOf(call[0]).endsWith('/chat/message-requests'),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]?.method).toBe('POST');
    expect(new Headers(calls[0]![1]?.headers).get('Idempotency-Key')).toBe(input.requestId);
    expect(calls[0]![1]?.body).toBe(JSON.stringify(input));
  } finally {
    vi.unstubAllGlobals();
  }
});
