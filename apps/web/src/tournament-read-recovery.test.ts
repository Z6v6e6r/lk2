import { webcrypto } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { TournamentReadCustody } from './tournament-read-custody.js';
import { tournamentReadableThrough } from './tournament-chat-history.js';
import { parseTournamentChatReadReceipt, tournamentChatReadHash } from '@phub/api-sdk';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const principal = { tenantId: id(1), userId: id(2) },
  tid = id(3),
  streamId = id(4),
  witnessHash = 'a'.repeat(64),
  cryptoApi = webcrypto as unknown as Crypto;
function fixture() {
  const values = new Map<string, string>();
  let live = true,
    queue = Promise.resolve();
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
  };
  const locks = {
    request: <T>(_n: string, _o: unknown, cb: () => Promise<T>) => {
      const p = queue.then(cb);
      queue = p.then(
        () => undefined,
        () => undefined,
      );
      return p;
    },
  };
  return {
    values,
    storage,
    locks,
    retire: () => {
      live = false;
    },
    make: () => new TournamentReadCustody(tid, principal, storage, locks, () => live, cryptoApi),
  };
}
describe('original READ custody and proven contiguous range', () => {
  it('two views share original UUID; reload metadata retains UNKNOWN and exact receipt alone clears', async () => {
    const f = fixture(),
      a = f.make(),
      b = f.make(),
      input = { streamId, witnessHash, throughSequence: 2 };
    const [x, y] = await Promise.all([a.original(input), b.original(input)]);
    expect(x).toEqual(y);
    expect(f.make().pending()).toHaveLength(1);
    const unknown = {
      contractVersion: 'tournament-chat-read.v1',
      tournamentId: tid,
      requestId: x.requestId,
      status: 'UNKNOWN',
    };
    expect(await a.accept(unknown, x.requestId, () => true)).toBe(false);
    expect(a.pending()).toHaveLength(1);
    const receipt = {
      ...unknown,
      status: 'CONFIRMED',
      requestHash: x.requestHash,
      streamId,
      witnessHash,
      baselineSequence: 0,
      throughSequence: 2,
      readThroughSequence: 3,
    };
    await expect(
      a.accept({ ...receipt, throughSequence: 3 }, x.requestId, () => true),
    ).rejects.toThrow();
    expect(await a.accept(receipt, x.requestId, () => true)).toBe(true);
    expect(b.pending()).toHaveLength(0);
  });
  it('capacity, malformed storage and quota never evict original or mint unretained command', async () => {
    const f = fixture(),
      a = f.make();
    for (let i = 0; i < 16; i++) await a.original({ streamId, witnessHash, throughSequence: i });
    await expect(a.original({ streamId, witnessHash, throughSequence: 17 })).rejects.toThrow();
    expect(a.pending()).toHaveLength(16);
    expect((await a.original({ streamId, witnessHash, throughSequence: 0 })).throughSequence).toBe(
      0,
    );
    const key = [...f.values.keys()][0]!;
    f.values.set(key, '{}');
    expect(() => a.pending()).toThrow();
    const g = fixture();
    g.storage.setItem = () => {
      throw Error('QuotaExceeded');
    };
    await expect(
      g.make().original({ streamId, witnessHash, throughSequence: 1 }),
    ).rejects.toThrow();
  });
  it('logout/ACL stale ACK retains metadata and cannot clear another original', async () => {
    const f = fixture(),
      a = f.make(),
      x = await a.original({ streamId, witnessHash, throughSequence: 1 });
    const r = {
      contractVersion: 'tournament-chat-read.v1',
      tournamentId: tid,
      requestId: x.requestId,
      status: 'CONFIRMED',
      requestHash: x.requestHash,
      streamId,
      witnessHash,
      baselineSequence: 0,
      throughSequence: 1,
      readThroughSequence: 1,
    };
    await expect(a.accept(r, x.requestId, () => false)).rejects.toThrow();
    expect(a.pending()).toHaveLength(1);
    f.retire();
    await expect(a.accept(r, x.requestId, () => true)).rejects.toThrow();
    expect([...f.values.values()][0]).toContain(x.requestId);
  });
  it('latest50 cannot skip unread prefix; only complete contiguous range may advance', () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      messageId: id(100 + i),
      authorUserId: principal.userId,
      text: 'same',
      sequence: 100 - i,
      acceptedAt: '2026-11-01T00:00:00.000Z',
    }));
    const thread = { streamId, headSequence: 100, olderThrough: 100, olderCursor: null, messages };
    expect(
      tournamentReadableThrough(thread, {
        streamId,
        readThroughSequence: 0,
        publishedSequence: 100,
      }),
    ).toBeNull();
    expect(
      tournamentReadableThrough(thread, {
        streamId,
        readThroughSequence: 50,
        publishedSequence: 100,
      }),
    ).toBe(100);
    expect(
      tournamentReadableThrough(
        { ...thread, messages: messages.filter((m) => m.sequence !== 80) },
        { streamId, readThroughSequence: 50, publishedSequence: 100 },
      ),
    ).toBeNull();
    expect(
      tournamentReadableThrough(thread, {
        streamId: id(9),
        readThroughSequence: 50,
        publishedSequence: 100,
      }),
    ).toBeNull();
  });
  it('strict public receipt rejects private witness and malformed counters; exact command hashing', async () => {
    const x = { requestId: id(6), streamId, witnessHash, throughSequence: 4 },
      requestHash = await tournamentChatReadHash(tid, x, cryptoApi);
    const r = {
      contractVersion: 'tournament-chat-read.v1',
      tournamentId: tid,
      requestId: x.requestId,
      status: 'CONFIRMED',
      requestHash,
      streamId,
      witnessHash,
      baselineSequence: 0,
      throughSequence: 4,
      readThroughSequence: 4,
    };
    expect(parseTournamentChatReadReceipt(r, tid, x.requestId, requestHash)).toEqual(r);
    expect(() =>
      parseTournamentChatReadReceipt({ ...r, witness: { generation: id(7) } }, tid, x.requestId),
    ).toThrow();
    expect(() =>
      parseTournamentChatReadReceipt({ ...r, readThroughSequence: 3 }, tid, x.requestId),
    ).toThrow();
  });
});
