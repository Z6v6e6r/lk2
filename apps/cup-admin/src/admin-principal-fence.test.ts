// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import {
  createNotificationAdminClient,
  type NotificationAdminClient,
} from './notification-admin-client.js';
const id = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222',
  key = '33333333-3333-4333-8333-333333333333';
const a = {
  accessToken: 'synthetic-a',
  tokenType: 'Bearer',
  expiresAt: '2099-01-01T00:00:00.000Z',
  user: { id, displayName: 'Synthetic' },
  context: {
    userId: id,
    tenantId: other,
    displayName: 'Synthetic',
    phoneLast4: '0001',
    roles: [],
    permissions: [],
  },
};
const b = {
  ...a,
  accessToken: 'synthetic-b',
  user: { ...a.user, id: other },
  context: { ...a.context, userId: other },
};
const urlOf = (raw: Parameters<typeof fetch>[0]) =>
  raw instanceof Request ? raw.url : raw.toString();
const client = (fetchImplementation: typeof fetch) =>
  createNotificationAdminClient({
    baseUrl: 'https://api.invalid',
    tenantKey: 'synthetic',
    appVersion: 'test',
    fetchImplementation,
  });
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const commands: [string, (c: NotificationAdminClient) => Promise<unknown>][] = [
  [
    'campaign',
    (c) =>
      c.createCampaign({
        phones: [],
        userIds: [id],
        title: 'Synthetic',
        body: 'Synthetic',
        channels: ['IN_APP'],
      }),
  ],
  ['moderation', (c) => c.approveCommunityPost(id, other, 1)],
  ['catalogue', (c) => c.publishGiftCertificateCatalogDraft(id, 1)],
  [
    'media',
    (c) => c.uploadLocationMedia(new File(['synthetic'], 'synthetic.png', { type: 'image/png' })),
  ],
  [
    'quota',
    (c) =>
      c.createCommunityCreateQuotaGrant(id, { scopes: [], reasonCode: 'SYNTHETIC', ticketId: key }),
  ],
  ['support', (c) => c.updateAdminSupportTicket(id, { expectedVersion: 1 }, key)],
  [
    'supportMessage',
    (c) =>
      c.sendAdminSupportTicketMessage(
        id,
        { body: 'Synthetic', internal: false, expectedVersion: 1 },
        key,
      ),
  ],
];
for (const [name, command] of commands)
  it(`${name}:401 never automatically refreshes or repeats a mutation`, async () => {
    let refreshes = 0,
      writes = 0;
    const c = client((raw) => {
      if (urlOf(raw).endsWith('/auth/session/refresh')) {
        refreshes++;
        return Promise.resolve(Response.json(a));
      }
      writes++;
      return Promise.resolve(new Response(null, { status: 401 }));
    });
    await c.restoreSession();
    await expect(command(c)).rejects.toMatchObject({ status: 401 });
    expect(writes).toBe(1);
    expect(refreshes).toBe(1);
  });
for (const [name, command] of commands.slice(0, 4))
  it.each(['same-user', 'different-user'] as const)(
    `${name}:late401 cannot replay after %s reauthentication`,
    async (mode) => {
      const late = deferred<Response>();
      let refreshes = 0,
        writes = 0;
      const c = client((raw) => {
        const url = urlOf(raw);
        if (url.endsWith('/auth/session/refresh')) {
          refreshes++;
          return Promise.resolve(Response.json(a));
        }
        if (url.endsWith('/auth/session'))
          return Promise.resolve(new Response(null, { status: 204 }));
        if (url.endsWith('/verify'))
          return Promise.resolve(Response.json(mode === 'same-user' ? a : b));
        writes++;
        return writes === 1 ? late.promise : Promise.resolve(Response.json({}));
      });
      await c.restoreSession();
      const old = command(c).catch((error) => error as Error);
      await c.logout();
      await c.verifyCode(id, '0000');
      late.resolve(new Response(null, { status: 401 }));
      expect(await old).toMatchObject({ code: 'AUTH_PRINCIPAL_CHANGED' });
      expect(writes).toBe(1);
      expect(refreshes).toBe(1);
    },
  );
it.each([
  { phase: 'headers', status: 200 },
  { phase: 'body', status: 200 },
  { phase: 'headers', status: 403 },
  { phase: 'body', status: 403 },
])(
  'hides late recipient/capability response after account replacement during $phase/$status',
  async ({ phase, status }) => {
    const late = deferred<Response>(),
      body = deferred<unknown>();
    let reads = 0;
    const c = client((raw) => {
      const url = urlOf(raw);
      if (url.endsWith('/auth/session/refresh')) return Promise.resolve(Response.json(a));
      if (url.endsWith('/verify')) return Promise.resolve(Response.json(b));
      reads++;
      if (phase === 'headers') return late.promise;
      const response = Response.json({}, { status });
      vi.spyOn(response, 'json').mockReturnValue(body.promise);
      return Promise.resolve(response);
    });
    await c.restoreSession();
    const old = c.getCapabilities().catch((error) => error as Error);
    await Promise.resolve();
    await c.verifyCode(id, '0000');
    if (phase === 'headers')
      late.resolve(Response.json({ message: 'synthetic-old-private' }, { status }));
    else body.resolve({ message: 'synthetic-old-private' });
    expect(await old).toMatchObject({ code: 'AUTH_PRINCIPAL_CHANGED' });
    expect(reads).toBe(1);
  },
);
it('rejects changed cookie identity before admin read replay', async () => {
  let refreshes = 0,
    reads = 0;
  const c = client((raw) => {
    if (urlOf(raw).endsWith('/auth/session/refresh'))
      return Promise.resolve(Response.json(++refreshes === 1 ? a : b));
    reads++;
    return Promise.resolve(reads === 1 ? new Response(null, { status: 401 }) : Response.json({}));
  });
  await c.restoreSession();
  await expect(c.getCapabilities()).rejects.toMatchObject({ code: 'AUTH_PRINCIPAL_CHANGED' });
  expect(reads).toBe(1);
  expect(refreshes).toBe(2);
});
it('retains one shared same-principal refresh for concurrent admin reads', async () => {
  const refresh = deferred<Response>();
  let refreshes = 0,
    reads = 0;
  const c = client((raw) => {
    if (urlOf(raw).endsWith('/auth/session/refresh'))
      return ++refreshes === 1 ? Promise.resolve(Response.json(a)) : refresh.promise;
    reads++;
    return Promise.resolve(
      reads <= 2 ? new Response(null, { status: 401 }) : Response.json({ synthetic: 'current' }),
    );
  });
  await c.restoreSession();
  const first = c.getCapabilities(),
    second = c.listNotificationScenarios();
  await vi.waitFor(() => expect(refreshes).toBe(2));
  refresh.resolve(Response.json({ ...a, accessToken: 'synthetic-a-refreshed' }));
  await expect(Promise.all([first, second])).resolves.toEqual([
    { synthetic: 'current' },
    { synthetic: 'current' },
  ]);
  expect(reads).toBe(4);
  expect(refreshes).toBe(2);
});
