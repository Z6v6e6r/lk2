import { describe, expect, it, vi } from 'vitest';
import { IOSDirectController, directRecipient, readOtherProfile } from './direct-start.js';
import { directFixture, otherProfile } from './testing/direct-fixtures.js';
import { nativeResult, syntheticSession, viewerId, auth } from './testing/cabinet-fixtures.js';
import { directId, peer } from './testing/chat-fixtures.js';
import type { IOSSessionPlugin } from './session.js';

async function setup(override?: IOSSessionPlugin['request']) {
  const fixture = directFixture();
  const request = vi.fn<IOSSessionPlugin['request']>(
    override ?? (async (input) => await Promise.resolve(fixture.reply(input))),
  );
  const session = syntheticSession(request);
  await session.restore();
  return { fixture, request, session, controller: new IOSDirectController(session, viewerId) };
}
const waitDone = async (controller: IOSDirectController) => {
  await vi.waitFor(() => expect(controller.snapshot().busy).toBe(false));
  await vi.waitFor(() =>
    expect(controller.snapshot().error ?? controller.snapshot().conversationId).not.toBeNull(),
  );
};
describe('iOS direct start and profile trust boundary', () => {
  it('accepts only the server direct link with one exact recipient', () => {
    const route = `/chats/new?recipientUserId=${peer.userId}&open=1`;
    expect(directRecipient(route)).toBe(peer.userId);
    for (const candidate of [
      route + '&open=1',
      route + '#x',
      route.replace('open=1', 'open=0'),
      route.replace(peer.userId, '../x'),
      route.replace('recipientUserId=', 'tenant=other&recipientUserId='),
    ])
      expect(directRecipient(candidate)).toBeNull();
  });
  it('reads a public projection and strips avatar without fetching media', async () => {
    const { session, request } = await setup();
    expect((await readOtherProfile(session, viewerId, peer.userId)).profile.avatarUrl).toBeNull();
    expect(request.mock.calls.map(([input]) => input.resource).filter(Boolean)).toEqual([
      'playerProfile',
    ]);
  });
  it.each([
    { ...otherProfile, privateAccount: { balanceMinor: 100 } },
    { ...otherProfile, profile: { ...otherProfile.profile, userId: viewerId } },
    { ...otherProfile, access: { ...otherProfile.access, audience: 'SELF' } },
    { ...otherProfile, access: { ...otherProfile.access, visibleSections: ['PRIVATE_ACCOUNT'] } },
    {
      ...otherProfile,
      access: {
        ...otherProfile.access,
        chat: { status: 'AVAILABLE', route: `/chats/new?recipientUserId=${viewerId}&open=1` },
      },
    },
  ])('rejects mismatched or private profile before create', async (profile) => {
    const fixture = directFixture();
    const { controller, request } = await setup(
      async (input) =>
        await Promise.resolve(
          input.resource === 'playerProfile' ? nativeResult(profile) : fixture.reply(input),
        ),
    );
    controller.activate(peer.userId);
    await waitDone(controller);
    expect(controller.snapshot().canRetry).toBe(false);
    expect(request.mock.calls.some(([input]) => input.resource === 'createDirect')).toBe(false);
  });
  it.each(['LOCKED', 'HIDDEN'])('does not create for %s server capability', async (status) => {
    const fixture = directFixture();
    const { controller, request } = await setup(
      async (input) =>
        await Promise.resolve(
          input.resource === 'playerProfile'
            ? nativeResult({
                ...otherProfile,
                access: { ...otherProfile.access, chat: { status } },
              })
            : fixture.reply(input),
        ),
    );
    controller.activate(peer.userId);
    await waitDone(controller);
    expect(request.mock.calls.some(([input]) => input.resource === 'createDirect')).toBe(false);
  });
  it('does not read or create without the current direct grant or for self', async () => {
    const fixture = directFixture();
    const { controller, request } = await setup(
      async (input) =>
        await Promise.resolve(
          input.operation === 'refresh' ? nativeResult(auth) : fixture.reply(input),
        ),
    );
    controller.activate(peer.userId);
    await waitDone(controller);
    controller.activate(viewerId);
    await waitDone(controller);
    expect(request.mock.calls.filter(([input]) => input.operation !== 'refresh')).toHaveLength(0);
  });
  it('serializes double taps and reconciles lost response before retrying', async () => {
    const { controller, request, fixture } = await setup();
    fixture.loseResponse(true);
    controller.activate(peer.userId);
    await waitDone(controller);
    expect(controller.snapshot().canRetry).toBe(true);
    await Promise.all([controller.attempt(), controller.attempt()]);
    expect(controller.snapshot().conversationId).toBe(directId);
    expect(request.mock.calls.filter(([input]) => input.resource === 'createDirect')).toHaveLength(
      1,
    );
    expect(request.mock.calls.at(-1)?.[0].resource).toBe('conversations');
    controller.stop();
    expect(controller.snapshot().conversationId).toBeNull();
    controller.activate(viewerId);
    await waitDone(controller);
    expect(controller.snapshot().conversationId).toBeNull();
  });
  it('rejects a returned conversation for another participant', async () => {
    const fixture = directFixture();
    const { controller } = await setup(
      async (input) =>
        await Promise.resolve(
          input.resource === 'createDirect'
            ? nativeResult({
                outcome: 'ok',
                conversation: {
                  ...fixture.conversation,
                  participant: { ...peer, userId: viewerId },
                },
              })
            : fixture.reply(input),
        ),
    );
    controller.activate(peer.userId);
    await waitDone(controller);
    expect(controller.snapshot()).toMatchObject({ conversationId: null, canRetry: false });
  });
  it('reuses the original key when reconciliation has no matching conversation', async () => {
    const fixture = directFixture();
    let posts = 0;
    const { controller, request } = await setup(async (input) => {
      if (input.resource === 'createDirect' && ++posts === 1)
        return nativeResult({ code: 'UNAVAILABLE' }, 503);
      return await Promise.resolve(fixture.reply(input));
    });
    controller.activate(peer.userId);
    await waitDone(controller);
    await controller.attempt();
    const calls = request.mock.calls.map(([input]) => input);
    const sent = calls.filter((input) => input.resource === 'createDirect');
    expect(sent).toHaveLength(2);
    expect(sent[1]?.headers['idempotency-key']).toBe(sent[0]?.headers['idempotency-key']);
    expect(calls.findIndex((input) => input.resource === 'conversations')).toBeLessThan(
      calls.lastIndexOf(sent[1]!),
    );
    expect(controller.snapshot().conversationId).toBe(directId);
  });
  it('does not send after route exit or logout during profile read', async () => {
    const fixture = directFixture();
    let release!: (result: ReturnType<typeof nativeResult>) => void;
    const pending = new Promise<ReturnType<typeof nativeResult>>((resolve) => {
      release = resolve;
    });
    const { controller, request, session } = await setup(async (input) =>
      input.resource === 'playerProfile'
        ? await pending
        : await Promise.resolve(fixture.reply(input)),
    );
    controller.activate(peer.userId);
    await vi.waitFor(() =>
      expect(request.mock.calls.some(([input]) => input.resource === 'playerProfile')).toBe(true),
    );
    const logout = session.logout();
    controller.stop();
    release(nativeResult(otherProfile));
    await logout;
    expect(request.mock.calls.some(([input]) => input.resource === 'createDirect')).toBe(false);
    expect(controller.snapshot().conversationId).toBeNull();
  });
});
