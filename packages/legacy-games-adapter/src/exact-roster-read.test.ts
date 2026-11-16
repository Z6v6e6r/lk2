import { beforeEach, expect, it, vi } from 'vitest';
const q = vi.hoisted(() => ({
  find: vi.fn(),
  sort: vi.fn(),
  limit: vi.fn(),
  toArray: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
  options: [] as unknown[],
}));
vi.mock('mongodb', () => ({
  MongoClient: class {
    constructor(_uri: unknown, options: unknown) {
      q.options.push(options);
    }
    connect = q.connect;
    close = q.close;
    db() {
      return { collection: () => ({ find: q.find }) };
    }
  },
}));
import { LegacyGamesMongoAdapter } from './index.js';
const row = {
  id: 'synthetic-exact-game',
  status: 'PAID',
  organizer: { id: 'organizer', name: 'Организатор' },
  participants: [{ id: 'second', name: 'Второй участник', status: 'ACTIVE' }],
  settings: { isPrivate: true, ratingGame: false },
  metadata: { gameFormat: 'doubles' },
  booking: {
    studioId: 'studio',
    studioName: 'Терехово',
    timeFromIso: '2026-11-15T07:00:00+03:00',
    timeToIso: '2026-11-15T08:00:00+03:00',
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  q.options.length = 0;
  q.find.mockReturnValue({ sort: q.sort });
  q.sort.mockReturnValue({ limit: q.limit });
  q.limit.mockReturnValue({ toArray: q.toArray });
  q.toArray.mockResolvedValue([row]);
  q.close.mockResolvedValue(undefined);
});
const source = () =>
  new LegacyGamesMongoAdapter({ uri: 'mongodb://synthetic.invalid/fixture', maxAttempts: 2 });
it('reads a full exact roster from primary/majority even when the adapter normally uses eventual reads', async () => {
  const result = await source().readRosterByExternalIds({ externalIds: [row.id], limit: 1 });
  expect(result[0]?.participants).toHaveLength(2);
  expect(q.options[0]).toMatchObject({
    readPreference: 'primary',
    readConcern: { level: 'majority' },
    retryReads: false,
  });
  expect(q.find.mock.calls[0]?.[0]).toMatchObject({ id: { $in: [row.id] } });
  expect(q.limit).toHaveBeenCalledWith(2);
  expect(q.close).toHaveBeenCalled();
});
it.each([
  { externalIds: [], limit: 1 },
  { externalIds: [row.id, row.id], limit: 1 },
  { externalIds: [row.id], limit: 11 },
  { externalIds: ['bad\nkey'], limit: 1 },
])('rejects unsafe exact input before connecting: %j', async (input) => {
  await expect(source().readRosterByExternalIds(input)).rejects.toThrow(
    'EXACT_ROSTER_INPUT_INVALID',
  );
  expect(q.connect).not.toHaveBeenCalled();
});
it('rejects truncated and invalid source documents without returning a partial roster', async () => {
  q.toArray.mockResolvedValue([row, { ...row, id: 'unexpected-other' }]);
  await expect(
    source().readRosterByExternalIds({ externalIds: [row.id], limit: 1 }),
  ).rejects.toThrow('SOURCE_LIMIT_EXCEEDED');
  q.toArray.mockResolvedValue([{ ...row, organizer: null }]);
  await expect(
    source().readRosterByExternalIds({ externalIds: [row.id], limit: 1 }),
  ).rejects.toThrow('UNAVAILABLE');
});

function paidRow() {
  return {
    ...row,
    organizer: { ...row.organizer, status: 'PAID' },
    participants: [
      { ...row.participants[0]!, status: 'PAID' },
      { id: 'third', name: 'Третий', status: 'PAID' },
      { id: 'fourth', name: 'Четвёртый', status: 'PAID' },
    ],
  };
}
it('proves the complete explicitly paid source4 roster for replacement without changing generic reads', async () => {
  const paid = paidRow();
  q.toArray.mockResolvedValue([paid]);
  const result = await source().readRosterByExternalIds({
    externalIds: [row.id],
    limit: 1,
    requirePaidRosterProof: true,
  });
  expect(result[0]!.participants).toHaveLength(4);
  expect(q.connect).toHaveBeenCalledTimes(1);
  // The canonical organizer is sometimes repeated in the source roster. Only an identical PAID
  // organizer record is unambiguous; it represents one seat, not an additional player.
  q.toArray.mockResolvedValue([{ ...paid, participants: [paid.organizer, ...paid.participants] }]);
  expect(
    (
      await source().readRosterByExternalIds({
        externalIds: [row.id],
        limit: 1,
        requirePaidRosterProof: true,
      })
    )[0]!.participants,
  ).toHaveLength(4);
});
it.each(['PENDING', 'CANCELLED', 'ACTIVE', 'UNKNOWN', undefined])(
  'rejects source player status %s rather than fabricating a paid seat',
  async (status) => {
    const paid = paidRow();
    q.toArray.mockResolvedValue([
      {
        ...paid,
        participants: [{ ...paid.participants[0], status }, ...paid.participants.slice(1)],
      },
    ]);
    await expect(
      source().readRosterByExternalIds({
        externalIds: [row.id],
        limit: 1,
        requirePaidRosterProof: true,
      }),
    ).rejects.toThrow('SOURCE_UNAVAILABLE');
    expect(q.connect).toHaveBeenCalledTimes(1);
    expect(q.close).toHaveBeenCalledTimes(1);
  },
);
it.each([
  'organizer-unproven',
  'organizer-cancelled',
  'over-capacity',
  'malformed',
  'missing-array',
  'duplicate',
  'conflicting-organizer',
  'repeated-organizer',
  'cancelled-game',
])('rejects incomplete or ambiguous replacement roster: %s', async (scenario) => {
  const paid = paidRow();
  let raw: unknown = paid;
  if (scenario === 'organizer-unproven') raw = { ...paid, organizer: row.organizer };
  if (scenario === 'organizer-cancelled')
    raw = { ...paid, organizer: { ...paid.organizer, status: 'CANCELLED' } };
  if (scenario === 'over-capacity')
    raw = {
      ...paid,
      participants: [...paid.participants, { id: 'fifth', name: 'Пятый', status: 'PAID' }],
    };
  if (scenario === 'malformed')
    raw = { ...paid, participants: [...paid.participants, { id: 'missing-name', status: 'PAID' }] };
  if (scenario === 'missing-array') raw = { ...paid, participants: undefined };
  if (scenario === 'duplicate')
    raw = { ...paid, participants: [...paid.participants, paid.participants[0]] };
  if (scenario === 'conflicting-organizer')
    raw = { ...paid, participants: [...paid.participants, { ...paid.organizer, name: 'Другой' }] };
  if (scenario === 'repeated-organizer')
    raw = { ...paid, participants: [paid.organizer, ...paid.participants, paid.organizer] };
  if (scenario === 'cancelled-game') raw = { ...paid, status: 'CANCELLED' };
  q.toArray.mockResolvedValue([raw]);
  await expect(
    source().readRosterByExternalIds({
      externalIds: [row.id],
      limit: 1,
      requirePaidRosterProof: true,
    }),
  ).rejects.toThrow('SOURCE_UNAVAILABLE');
  expect(q.connect).toHaveBeenCalledTimes(1);
});
