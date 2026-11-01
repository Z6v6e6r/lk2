// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createBrowserAuthGateway, type AuthGateway } from './auth-gateway.js';
const id = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222',
  key = '33333333-3333-4333-8333-333333333333';
const original = {
  accessToken: 'synthetic-original',
  tokenType: 'Bearer',
  expiresAt: '2099-01-01T00:00:00.000Z',
  user: { id, displayName: 'Synthetic' },
  context: {
    userId: id,
    tenantId: other,
    displayName: 'Synthetic',
    phoneLast4: '0001',
    roles: ['client'],
    permissions: [],
  },
};
const commands: [string, (g: AuthGateway) => Promise<unknown>][] = [
  ['direct', (g) => g.createDirectConversation(other, key)],
  ['game', (g) => g.getOrCreateGameConversation(id)],
  [
    'send',
    (g) => g.sendConversationMessage(id, { clientMessageId: key, body: 'synthetic message' }),
  ],
  ['read', (g) => g.markConversationRead(id, 4, key)],
  ['policy', (g) => g.setConversationNotificationPolicy(id, { level: 'NONE' }, key)],
  [
    'support',
    (g) => g.sendStationSupportMessage({ clientMessageId: key, text: 'synthetic', stationId: id }),
  ],
  [
    'mediaIssue',
    (g) =>
      g.issueConversationMediaUpload(
        id,
        {
          fileName: 'synthetic.png',
          contentType: 'image/png',
          sha256: 'a'.repeat(64),
          byteSize: 10,
        },
        key,
      ),
  ],
  ['mediaFinalize', (g) => g.finalizeConversationMediaUpload(id, other, 10, key)],
  ['mediaBytes', (g) => g.uploadConversationMediaBytes!(id, other, new Blob(['synthetic']), key)],
];
const urlOf = (raw: Parameters<typeof fetch>[0]) =>
  raw instanceof Request ? raw.url : raw.toString();
for (const platform of ['web', 'android'] as const)
  for (const [name, command] of commands.filter(
    ([n]) => platform === 'android' || n !== 'mediaBytes',
  )) {
    for (const phase of ['logout', 'different-user', 'same-user'] as const)
      it(`${platform} ${name}: original network failure cannot retry after ${phase}`, async () => {
        let fail!: (e: Error) => void;
        let identity = original;
        const sent: RequestInit[] = [];
        const transport = vi.fn<typeof fetch>((raw, init) => {
          const url = urlOf(raw);
          if (url.includes('/auth/'))
            return Promise.resolve(
              url.endsWith('/auth/session')
                ? new Response(null, { status: 204 })
                : Response.json(identity),
            );
          sent.push(init!);
          return sent.length === 1
            ? new Promise((_resolve, reject) => {
                fail = reject;
              })
            : Promise.resolve(Response.json({}));
        });
        const g = createBrowserAuthGateway({
          baseUrl: 'https://api.invalid',
          tenantKey: 'synthetic',
          platform,
          nativeSessionTransport: platform === 'android',
          appVersion: 'test',
          fetchImplementation: transport,
        });
        await g.restoreSession();
        const pending = command(g);
        const observed = pending.then(
          () => null,
          (e) => e as Error,
        );
        expect(sent).toHaveLength(1);
        await g.logout();
        if (phase !== 'logout') {
          identity = {
            ...original,
            user: { ...original.user, id: phase === 'different-user' ? other : id },
            context: { ...original.context, userId: phase === 'different-user' ? other : id },
          };
          await g.verifyCode({
            challengeId: id,
            code: '0000',
            acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
          });
        }
        fail(new TypeError('synthetic lost reply'));
        expect(await observed).toMatchObject({ message: 'AUTH_PRINCIPAL_CHANGED' });
        expect(sent).toHaveLength(1);
      });
    it(`${platform} ${name}: late successful result is fenced after synchronous close`, async () => {
      let finish!: (r: Response) => void;
      const transport = vi.fn<typeof fetch>((raw) =>
        urlOf(raw).includes('/auth/')
          ? Promise.resolve(Response.json(original))
          : new Promise((resolve) => {
              finish = resolve;
            }),
      );
      const g = createBrowserAuthGateway({
        baseUrl: 'https://api.invalid',
        tenantKey: 'synthetic',
        platform,
        nativeSessionTransport: platform === 'android',
        appVersion: 'test',
        fetchImplementation: transport,
      });
      await g.restoreSession();
      const observed = command(g).then(
        () => null,
        (e) => e as Error,
      );
      g.closeQuarterCreate?.();
      finish(Response.json({}));
      expect(await observed).toMatchObject({ message: 'AUTH_PRINCIPAL_CHANGED' });
    });
    it(`${platform} ${name}: 401 never refreshes and replays a command`, async () => {
      const transport = vi.fn<typeof fetch>((raw) =>
        Promise.resolve(
          urlOf(raw).includes('/auth/')
            ? Response.json(original)
            : Response.json({ code: 'AUTH_REQUIRED', message: 'synthetic' }, { status: 401 }),
        ),
      );
      const g = createBrowserAuthGateway({
        baseUrl: 'https://api.invalid',
        tenantKey: 'synthetic',
        platform,
        nativeSessionTransport: platform === 'android',
        appVersion: 'test',
        fetchImplementation: transport,
      });
      await g.restoreSession();
      await expect(command(g)).rejects.toThrow();
      expect(transport.mock.calls).toHaveLength(2);
    });
  }
it('unchanged native principal retains exactly one bounded retry with original key/body', async () => {
  let calls = 0;
  const transport = vi.fn<typeof fetch>((raw) =>
    urlOf(raw).includes('/auth/')
      ? Promise.resolve(Response.json(original))
      : ++calls === 1
        ? Promise.reject(new TypeError('synthetic'))
        : Promise.resolve(Response.json({ outcome: 'ok' })),
  );
  const g = createBrowserAuthGateway({
    baseUrl: 'https://api.invalid',
    tenantKey: 'synthetic',
    platform: 'android',
    nativeSessionTransport: true,
    appVersion: 'test',
    fetchImplementation: transport,
  });
  await g.restoreSession();
  await g.createDirectConversation(other, key);
  const requests = transport.mock.calls.slice(1);
  expect(requests).toHaveLength(2);
  expect(requests[0]?.[1]?.body).toBe(requests[1]?.[1]?.body);
  for (const [, input] of requests) {
    expect(new Headers(input?.headers).get('Idempotency-Key')).toBe(key);
    expect(new Headers(input?.headers).get('Authorization')).toBe('Bearer synthetic-original');
  }
});

it.each(['success', 'failure'] as const)(
  'late initial restore %s cannot clear a newly verified gateway session',
  async (outcome) => {
    let finish!: (r: Response) => void, fail!: (e: Error) => void;
    const sent: RequestInit[] = [];
    const transport = vi.fn<typeof fetch>((raw, init) => {
      const url = urlOf(raw);
      if (url.endsWith('/auth/session/refresh'))
        return new Promise((yes, no) => {
          finish = yes;
          fail = no;
        });
      if (url.endsWith('/verify'))
        return Promise.resolve(
          Response.json({
            ...original,
            accessToken: 'synthetic-new',
            user: { ...original.user, id: other },
            context: { ...original.context, userId: other },
          }),
        );
      sent.push(init!);
      return Promise.resolve(Response.json({}));
    });
    const g = createBrowserAuthGateway({
      baseUrl: 'https://api.invalid',
      tenantKey: 'synthetic',
      appVersion: 'test',
      fetchImplementation: transport,
    });
    const old = g.restoreSession();
    await g.verifyCode({
      challengeId: id,
      code: '0000',
      acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
    });
    if (outcome === 'success') finish(Response.json(original));
    else fail(new TypeError('synthetic'));
    expect(await old).toBeNull();
    await g.createDirectConversation(id, key);
    expect(sent).toHaveLength(1);
    expect(new Headers(sent[0]?.headers).get('Authorization')).toBe('Bearer synthetic-new');
  },
);
it('changed cookie identity cannot silently authorize a messaging command; explicit restore adopts it', async () => {
  let refreshes = 0,
    commandsSent = 0;
  const newSession = {
    ...original,
    accessToken: 'synthetic-new',
    user: { ...original.user, id: other },
    context: { ...original.context, userId: other },
  };
  const transport = vi.fn<typeof fetch>((raw) => {
    const url = urlOf(raw);
    if (url.endsWith('/auth/session/refresh'))
      return Promise.resolve(Response.json(++refreshes === 1 ? original : newSession));
    if (url.includes('/messages?')) return Promise.resolve(new Response(null, { status: 401 }));
    commandsSent++;
    return Promise.resolve(Response.json({}));
  });
  const g = createBrowserAuthGateway({
    baseUrl: 'https://api.invalid',
    tenantKey: 'synthetic',
    appVersion: 'test',
    fetchImplementation: transport,
  });
  await g.restoreSession();
  await expect(g.listConversationMessages(id)).rejects.toMatchObject({
    code: 'AUTH_PRINCIPAL_CHANGED',
  });
  await expect(g.createDirectConversation(id, key)).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
  expect(commandsSent).toBe(0);
  expect((await g.restoreSession())?.context.user.id).toBe(other);
  await g.createDirectConversation(id, key);
  expect(commandsSent).toBe(1);
});
