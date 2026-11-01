import { webcrypto, createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import * as domain from './tournament-chat.js';
import * as sdk from '../../api-sdk/src/tournament-chat.js';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tid = id(1),
  rid = id(2),
  stream = id(3);
const cursor = (before: number, through = 3) =>
  Buffer.from(
    JSON.stringify({
      v: 1,
      tenantId: id(4),
      tournamentId: tid,
      actorUserId: id(5),
      streamId: stream,
      witnessHash: 'a'.repeat(64),
      through,
      before,
    }),
  ).toString('base64url');
const message = (sequence: number) => ({
  messageId: id(10 + sequence),
  authorUserId: id(5),
  text: 'same body',
  sequence,
  acceptedAt: '2026-11-01T00:00:00.000Z',
});
const page = {
  contractVersion: 'tournament-chat.v1',
  tournamentId: tid,
  streamId: stream,
  throughSequence: 3,
  messages: [message(3), message(2)],
  hasMore: true,
  nextCursor: cursor(2),
};
describe.each([
  ['domain', domain],
  ['SDK', sdk],
] as const)('%s exact tournament wire', (_name, p) => {
  it('hashes exact untrimmed ordered CUP body and rejects invalid text', async () => {
    const x = { requestId: rid, text: '  🙂\nhi  ' };
    const actual = await p.tournamentChatRequestHash(tid, x, webcrypto as unknown as Crypto);
    expect(actual).toBe(
      createHash('sha256')
        .update(
          'tournament-chat-request:v1\0' +
            JSON.stringify({ contractVersion: 1, tournamentId: tid, ...x }),
        )
        .digest('hex'),
    );
    for (const text of [' ', '\0', '\ud800', 'a'.repeat(8001)])
      expect(() => p.parseTournamentChatRequest({ requestId: rid, text })).toThrow();
    expect(() => p.parseTournamentChatRequest({ ...x, userId: id(5) })).toThrow();
  });
  it('accepts same-body different IDs and fixed-frontier continuation', () => {
    expect(p.parseTournamentChatPage(page, tid, 2)).toEqual(page);
    const last = { ...page, messages: [message(1)], hasMore: false, nextCursor: null };
    expect(p.parseTournamentChatPage(last, tid, 2, page.nextCursor)).toEqual(last);
  });
  it('rejects missing sequence, duplicate ID, wrong stream/anchor and false end', () => {
    const bad = [
      { ...page, messages: [message(3), message(1)] },
      { ...page, messages: [message(3), { ...message(2), messageId: message(3).messageId }] },
      { ...page, nextCursor: cursor(1) },
      { ...page, hasMore: false, nextCursor: null },
      { ...page, messages: [{ ...message(3), acceptedAt: '2026-11-01' }, message(2)] },
    ];
    for (const x of bad) expect(() => p.parseTournamentChatPage(x, tid, 2)).toThrow();
    expect(() =>
      p.parseTournamentChatPage({ ...page, streamId: id(99) }, tid, 2, page.nextCursor),
    ).toThrow();
  });
  it('UNKNOWN has no candidate fields and CONFIRMED binds original hash/request', () => {
    const x = {
      contractVersion: 'tournament-chat.v1',
      tournamentId: tid,
      requestId: rid,
      status: 'UNKNOWN',
    };
    expect(p.parseTournamentChatReceipt(x, tid, rid)).toEqual(x);
    expect(() => p.parseTournamentChatReceipt({ ...x, messageId: id(6) }, tid, rid)).toThrow();
    const yes = {
      ...x,
      status: 'CONFIRMED',
      messageId: id(6),
      streamId: stream,
      sequence: 1,
      requestHash: 'b'.repeat(64),
    };
    expect(p.parseTournamentChatReceipt(yes, tid, rid, 'b'.repeat(64))).toEqual(yes);
    expect(() => p.parseTournamentChatReceipt(yes, tid, rid, 'a'.repeat(64))).toThrow();
    expect(() => p.parseTournamentChatReceipt(yes, tid, id(99))).toThrow();
  });
  it('strict cursor rejects tampering/unsafe counters and private extras', () => {
    for (const x of [
      '',
      cursor(2) + '=',
      Buffer.from(JSON.stringify({ v: 1 })).toString('base64url'),
      cursor(Number.MAX_SAFE_INTEGER),
    ])
      expect(() => p.parseTournamentChatCursor(x)).toThrow();
  });
});

it.each([domain, sdk])('preserves exact leading BOM text matching frozen CUP', async (p) => {
  const x = { requestId: rid, text: '\uFEFFsynthetic' };
  expect(p.parseTournamentChatRequest(x)).toEqual(x);
  expect(await p.tournamentChatRequestHash(tid, x, webcrypto as unknown as Crypto)).toBe(
    createHash('sha256')
      .update(
        'tournament-chat-request:v1\0' +
          JSON.stringify({ contractVersion: 1, tournamentId: tid, ...x }),
      )
      .digest('hex'),
  );
  expect(
    p.parseTournamentChatPage(
      { ...page, messages: [{ ...message(3), text: x.text }, message(2)] },
      tid,
      2,
    ).messages[0]!.text,
  ).toBe(x.text);
  const bom = Buffer.from('\uFEFF' + Buffer.from(cursor(2), 'base64url').toString()).toString(
    'base64url',
  );
  expect(() => p.parseTournamentChatCursor(bom)).toThrow();
});
