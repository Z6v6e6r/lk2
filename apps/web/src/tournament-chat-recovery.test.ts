import { webcrypto } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { TournamentChatCustody, type TournamentChatLocks } from './tournament-chat-custody.js';
import { refreshTournamentThread, tournamentThread } from './tournament-chat-history.js';
import { parseTournamentChatCursor, type TournamentChatPage } from '@phub/api-sdk';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tid = id(1),
  principal = { tenantId: id(2), userId: id(3) },
  stream = id(4);
const locks: TournamentChatLocks = { request: (_n, _o, cb) => cb() };
function store() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
    m,
  };
}
function cursor(before: number, through: number) {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      tenantId: principal.tenantId,
      tournamentId: tid,
      actorUserId: principal.userId,
      streamId: stream,
      witnessHash: 'a'.repeat(64),
      through,
      before,
    }),
  ).toString('base64url');
}
function page(through: number, before = through + 1): TournamentChatPage {
  const seq = Array.from({ length: Math.min(50, before - 1) }, (_, i) => before - 1 - i),
    last = seq.at(-1) ?? 1;
  return {
    contractVersion: 'tournament-chat.v1',
    tournamentId: tid,
    streamId: stream,
    throughSequence: through,
    messages: seq.map((sequence) => ({
      messageId: id(sequence + 100),
      sequence,
      authorUserId: principal.userId,
      text: 'same',
      acceptedAt: '2026-11-01T00:00:00.000Z',
    })),
    hasMore: last > 1,
    nextCursor: last > 1 ? cursor(last, through) : null,
  };
}
describe('metadata-only original tournament request custody', () => {
  it('retains unknown old body across edits/reload and isolates actor/tournament', async () => {
    const storage = store(),
      c = new TournamentChatCustody(
        tid,
        principal,
        storage,
        locks,
        () => true,
        webcrypto as unknown as Crypto,
      ),
      a = await c.original('old body'),
      b = await c.original('edited');
    expect(b.requestId).not.toBe(a.requestId);
    expect(await c.original('old body')).toEqual(a);
    expect([...storage.m.values()].join()).not.toContain('old body');
    const reload = new TournamentChatCustody(
      tid,
      principal,
      storage,
      locks,
      () => true,
      webcrypto as unknown as Crypto,
    );
    expect(reload.pending()).toHaveLength(2);
    expect(
      new TournamentChatCustody(id(99), principal, storage, locks, () => true).pending(),
    ).toEqual([]);
    expect(
      new TournamentChatCustody(
        tid,
        { ...principal, userId: id(99) },
        storage,
        locks,
        () => true,
      ).pending(),
    ).toEqual([]);
  });
  it('keeps original on UNKNOWN/malformed/wrong body/late logout ACK and fails closed at capacity', async () => {
    const storage = store();
    let active = true;
    const c = new TournamentChatCustody(
        tid,
        principal,
        storage,
        locks,
        () => active,
        webcrypto as unknown as Crypto,
      ),
      a = await c.original('original');
    const base = {
      contractVersion: 'tournament-chat.v1',
      tournamentId: tid,
      requestId: a.requestId,
      status: 'UNKNOWN',
    };
    expect(await c.accept(base, a.requestId)).toBe(false);
    const receipt = {
      ...base,
      status: 'CONFIRMED',
      streamId: stream,
      messageId: id(8),
      sequence: 1,
      requestHash: a.requestHash,
    };
    await expect(
      c.accept({ ...receipt, requestHash: 'f'.repeat(64) }, a.requestId),
    ).rejects.toThrow();
    expect(c.pending()).toHaveLength(1);
    for (let i = 1; i < 16; i++) await c.original('body-' + i);
    await expect(c.original('overflow')).rejects.toThrow('FULL');
    expect(await c.original('original')).toEqual(a);
    active = false;
    await expect(c.accept(receipt, a.requestId)).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
    active = true;
    expect(c.pending()).toHaveLength(16);
    expect(await c.accept(receipt, a.requestId)).toBe(true);
    expect(c.pending()).toHaveLength(15);
  });
});
describe('bounded reconnect fixed-frontier catch-up', () => {
  it('pages more than 50 new rows to original anchor without losing older pagination', async () => {
    const old = tournamentThread(page(100)),
      load = vi.fn((_id: string, _limit: number, c?: string) =>
        Promise.resolve(c ? page(180, parseTournamentChatCursor(c).before) : page(180)),
      );
    const next = await refreshTournamentThread(tid, old, load, () => true);
    expect(load).toHaveBeenCalledTimes(2);
    expect(next.messages).toHaveLength(130);
    expect(new Set(next.messages.map((m) => m.messageId)).size).toBe(130);
    expect(next.olderCursor).toBe(old.olderCursor);
    expect(next.olderThrough).toBe(100);
    expect(next.headSequence).toBe(180);
  });
  it.each(['retained-row', 'retained-head', 'fresh-page'] as const)(
    'rejects duplicate ID against %s without replacing old history or original custody',
    async (collision) => {
      const old = tournamentThread(page(100)),
        snapshot = JSON.stringify(old);
      const storage = store();
      const custody = new TournamentChatCustody(
        tid,
        principal,
        storage,
        locks,
        () => true,
        webcrypto as unknown as Crypto,
      );
      const original = await custody.original('unresolved original');
      const load = vi.fn((_id: string, _limit: number, c?: string) => {
        const result = c ? page(180, parseTournamentChatCursor(c).before) : page(180);
        const forgedSequence = collision === 'fresh-page' ? 120 : 150;
        const duplicateSequence =
          collision === 'retained-row' ? 90 : collision === 'retained-head' ? 100 : 170;
        return Promise.resolve({
          ...result,
          messages: result.messages.map((message) =>
            message.sequence === forgedSequence
              ? { ...message, messageId: id(duplicateSequence + 100) }
              : message,
          ),
        });
      });
      await expect(refreshTournamentThread(tid, old, load, () => true)).rejects.toThrow(
        'TOURNAMENT_CHAT_STREAM_CHANGED',
      );
      expect(load).toHaveBeenCalledTimes(collision === 'fresh-page' ? 2 : 1);
      expect(JSON.stringify(old)).toBe(snapshot);
      expect(custody.pending()).toEqual([original]);
    },
  );
  it('never silently replaces history if >200 catch-up or stream changed or session retired', async () => {
    const old = tournamentThread(page(10)),
      load = vi.fn((_id: string, _limit: number, c?: string) =>
        Promise.resolve(c ? page(300, parseTournamentChatCursor(c).before) : page(300)),
      );
    await expect(refreshTournamentThread(tid, old, load, () => true)).rejects.toThrow(
      'HISTORY_GAP',
    );
    expect(load).toHaveBeenCalledTimes(4);
    await expect(
      refreshTournamentThread(
        tid,
        old,
        () => Promise.resolve({ ...page(10), streamId: id(99) }),
        () => true,
      ),
    ).rejects.toThrow('STREAM_CHANGED');
    await expect(
      refreshTournamentThread(
        tid,
        old,
        () => Promise.resolve(page(10)),
        () => false,
      ),
    ).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
    expect(old.messages).toHaveLength(10);
  });
});
it('corrupt storage/quota/missing lock fail closed and never evict unknown custody', async () => {
  const storage = store(),
    c = new TournamentChatCustody(
      tid,
      principal,
      storage,
      locks,
      () => true,
      webcrypto as unknown as Crypto,
    );
  const original = await c.original('keep');
  const key = [...storage.m.keys()][0]!;
  storage.m.set(key, 'broken json');
  expect(() => c.pending()).toThrow();
  await expect(c.original('new')).rejects.toThrow();
  storage.m.set(key, JSON.stringify([original]));
  const quota = new TournamentChatCustody(
    tid,
    principal,
    {
      getItem: storage.getItem,
      setItem: () => {
        throw Error('QuotaExceededError');
      },
    },
    locks,
    () => true,
    webcrypto as unknown as Crypto,
  );
  await expect(quota.original('new')).rejects.toThrow('QuotaExceededError');
  expect(c.pending()).toEqual([original]);
  const unavailable = new TournamentChatCustody(
    tid,
    principal,
    storage,
    { request: () => Promise.reject(Error('NO_LOCK')) },
    () => true,
    webcrypto as unknown as Crypto,
  );
  await expect(unavailable.original('new')).rejects.toThrow('NO_LOCK');
  expect(c.pending()).toEqual([original]);
});
it('two views share original UUID under one per-scope exclusive lock, without storing body', async () => {
  const storage = store();
  let tail: Promise<unknown> = Promise.resolve();
  const serial: TournamentChatLocks = {
    request: (_n, _o, callback) => {
      const next = tail.then(callback);
      tail = next.catch(() => undefined);
      return next;
    },
  };
  const a = new TournamentChatCustody(
      tid,
      principal,
      storage,
      serial,
      () => true,
      webcrypto as unknown as Crypto,
    ),
    b = new TournamentChatCustody(
      tid,
      principal,
      storage,
      serial,
      () => true,
      webcrypto as unknown as Crypto,
    );
  const [first, second] = await Promise.all([
    a.original('same concurrent text'),
    b.original('same concurrent text'),
  ]);
  expect(first).toEqual(second);
  expect(a.pending()).toHaveLength(1);
  expect([...storage.m.values()].join()).not.toContain('same concurrent text');
});
