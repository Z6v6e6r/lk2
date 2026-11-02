// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IOSChatController } from './chat-data.js';
import { nativeResult, syntheticSession } from './testing/cabinet-fixtures.js';
import { chatFixture, directId, gameChatId } from './testing/chat-fixtures.js';
import { getChatsUnreadCount, setChatsUnreadCount } from '../../../web/src/chats-unread.js';
import type { IOSSessionPlugin } from './session.js';

afterEach(() => setChatsUnreadCount(0));
const offline = () =>
  Object.assign(new Error('synthetic offline'), { code: 'NATIVE_NETWORK_UNAVAILABLE' });
async function setup(
  override?: (
    input: Parameters<IOSSessionPlugin['request']>[0],
    fixture: ReturnType<typeof chatFixture>,
  ) => ReturnType<typeof nativeResult> | Promise<ReturnType<typeof nativeResult>>,
) {
  const fixture = chatFixture();
  const request = vi.fn<IOSSessionPlugin['request']>(async (input) =>
    override ? await override(input, fixture) : fixture.reply(input),
  );
  const session = syntheticSession(request);
  await session.restore();
  const controller = new IOSChatController(session, gameChatId);
  controller.start();
  await controller.refresh();
  return { controller, request, fixture, session };
}
describe('existing iOS conversation recovery', () => {
  it('retains a gap received during an older in-flight refresh and performs another HTTP read', async () => {
    let hold = false;
    let resume!: (reply: ReturnType<typeof nativeResult>) => void;
    const { controller, fixture, request } = await setup((input, source) => {
      if (hold && input.resource === 'conversationMessages') {
        hold = false;
        return new Promise((resolve) => {
          resume = resolve;
        });
      }
      return source.reply(input);
    });
    const original = fixture.messages.find((message) => message.conversationId === gameChatId)!;
    const missing = { ...original, id: 'missing', sequence: 2, body: 'Пропущенное сообщение' };
    const newest = { ...original, id: 'newest', sequence: 5, body: 'Новое сообщение' };
    fixture.messages.push(missing, newest);
    hold = true;
    const refreshing = controller.refresh();
    await vi.waitFor(() => expect(resume).toBeTypeOf('function'));
    controller.recover(0);
    resume(nativeResult({ messages: [newest] }));
    await refreshing;
    await vi.waitFor(() =>
      expect(controller.snapshot().messages.map((message) => message.sequence)).toEqual([1, 2, 5]),
    );
    expect(
      request.mock.calls.filter(
        ([input]) =>
          input.resource === 'conversationMessages' && input.query?.afterSequence === '0',
      ),
    ).toHaveLength(2);
    controller.stop();
  });
  it('loads GAME with a profile-only session, scopes history and marks its actual sequence', async () => {
    const { controller, request } = await setup();
    expect(controller.snapshot().loaded).toBe(true);
    expect(controller.snapshot().messages).toHaveLength(1);
    expect(getChatsUnreadCount()).toBe(5);
    expect(
      request.mock.calls.some(
        ([input]) =>
          input.resource === 'messageReadCursor' &&
          (JSON.parse(input.body!) as { throughSequence: number }).throughSequence === 1,
      ),
    ).toBe(true);
    await controller.refresh();
    expect(getChatsUnreadCount()).toBe(2);
    expect(
      controller.snapshot().page?.items.find((entry) => entry.id === gameChatId)?.unreadCount,
    ).toBe(0);
    controller.stop();
  });
  it('reconciles a durable send with a lost response without resending or duplicating it', async () => {
    const { controller, request } = await setup((input, fixture) => {
      const reply = fixture.reply(input);
      if (input.resource === 'sendMessage') throw offline();
      return reply;
    });
    await controller.send('Тест');
    expect(controller.snapshot().pending).toBeNull();
    expect(
      controller.snapshot().messages.filter((message) => message.body === 'Тест'),
    ).toHaveLength(1);
    await controller.retry();
    expect(request.mock.calls.filter(([input]) => input.resource === 'sendMessage')).toHaveLength(
      1,
    );
    controller.stop();
  });
  it('requires fresh reconciliation then retries with the exact key and body after no write', async () => {
    let failing = true;
    const { controller, request } = await setup((input, fixture) => {
      if (input.resource === 'sendMessage' && failing) throw offline();
      return fixture.reply(input);
    });
    await controller.send('Повтор');
    expect(controller.snapshot().canRetry).toBe(true);
    failing = false;
    await controller.retry();
    const sends = request.mock.calls
      .map(([input]) => input)
      .filter((input) => input.resource === 'sendMessage');
    expect(sends).toHaveLength(2);
    expect(sends[1]?.body).toBe(sends[0]?.body);
    expect(sends[1]?.headers['idempotency-key']).toBe(sends[0]?.headers['idempotency-key']);
    const secondIndex = request.mock.calls.findLastIndex(
      ([input]) => input.resource === 'sendMessage',
    );
    expect(request.mock.calls.slice(0, secondIndex).at(-1)?.[0].resource).toBe(
      'conversationMessages',
    );
    expect(
      controller.snapshot().messages.filter((message) => message.body === 'Повтор'),
    ).toHaveLength(1);
    controller.stop();
  });
  it('never sends another command when reconciliation is offline or truncated', async () => {
    let failed = false;
    const { controller, request } = await setup((input, fixture) => {
      if (input.resource === 'sendMessage') {
        failed = true;
        throw offline();
      }
      if (failed && input.resource === 'conversationMessages')
        return nativeResult({
          messages: [],
          nextAfterSequence: Number(input.query?.afterSequence) + 1,
        });
      return fixture.reply(input);
    });
    await controller.send('Неопределённо');
    expect(controller.snapshot().canRetry).toBe(false);
    await controller.retry();
    expect(request.mock.calls.filter(([input]) => input.resource === 'sendMessage')).toHaveLength(
      1,
    );
    controller.stop();
  });
  it.each([401, 403, 404, 409])(
    'refuses a terminal %i response without retrying',
    async (status) => {
      const { controller, request } = await setup((input, fixture) =>
        input.resource === 'sendMessage'
          ? nativeResult({ code: 'DENIED' }, status)
          : fixture.reply(input),
      );
      await controller.send('Запрещено');
      await controller.retry();
      const sends = request.mock.calls.filter(([input]) => input.resource === 'sendMessage');
      // A 401 has one SDK refresh/retry; no UI retry is introduced.
      expect(sends.length).toBe(status === 401 ? 2 : 1);
      expect(controller.snapshot().pending).toBeNull();
      controller.stop();
    },
  );
  it('discards late history and ACK after route disposal or logout', async () => {
    let resolve!: (reply: ReturnType<typeof nativeResult>) => void;
    const { controller, request, fixture, session } = await setup((input, source) =>
      input.resource === 'sendMessage'
        ? new Promise((done) => {
            resolve = done;
          })
        : source.reply(input),
    );
    const sending = controller.send('Поздно');
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    const outgoing = request.mock.calls.at(-1)![0];
    const loggingOut = session.logout();
    controller.stop();
    resolve(fixture.reply(outgoing));
    await sending;
    await loggingOut;
    expect(controller.snapshot().messages.some((message) => message.body === 'Поздно')).toBe(false);
    expect(session.getSnapshot().status).toBe('signed-out');
  });
  it('follows forward gap pages including deleted windows and deduplicates repeated sequences', async () => {
    const { controller, fixture } = await setup((input, source) => {
      if (input.resource === 'conversationMessages') {
        const after = Number(input.query?.afterSequence);
        return after === 0
          ? nativeResult({ messages: [], nextAfterSequence: 1 })
          : nativeResult({
              messages: source.messages.filter((message) => message.conversationId === gameChatId),
            });
      }
      return source.reply(input);
    });
    controller.recover(0);
    await controller.refresh();
    expect(controller.snapshot().messages).toEqual(
      fixture.messages.filter((message) => message.conversationId !== directId),
    );
    controller.stop();
  });
});
