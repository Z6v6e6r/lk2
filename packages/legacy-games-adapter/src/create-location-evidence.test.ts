import { describe, expect, it, vi } from 'vitest';
const query = vi.hoisted(() => ({
  find: vi.fn(),
  limit: vi.fn(),
  toArray: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
  options: [] as unknown[],
}));
vi.mock('mongodb', () => ({
  MongoClient: class {
    constructor(_uri: unknown, options: unknown) {
      query.options.push(options);
    }
    connect = query.connect;
    close = query.close;
    db() {
      return { collection: () => ({ find: query.find }) };
    }
  },
}));
import { LegacyGamesMongoAdapter, parseLegacyCreateLocationEvidence } from './index.js';
const row = {
  id: 'synthetic-game',
  updatedAt: '2026-10-01T12:00:00Z',
  booking: { studioId: 'synthetic-studio', roomId: 'synthetic-room' },
};
describe('private CREATE location Mongo evidence', () => {
  it('is separate from the public snapshot and contains no participants', () => {
    const result = parseLegacyCreateLocationEvidence({
      ...row,
      participants: [{ phone: 'not copied' }],
    });
    expect(result.gameAliases).toHaveLength(2);
    expect(result).not.toHaveProperty('participants');
    expect(result.roomId).toBe('synthetic-room');
  });
  it.each([
    null,
    [],
    { ...row, updatedAt: null },
    { ...row, id: 'bad\n' },
    { ...row, booking: { roomId: 'room' } },
  ])('rejects incomplete raw evidence', (input) => {
    expect(() => parseLegacyCreateLocationEvidence(input)).toThrow();
  });
  it('reads exact all historical aliases with primary/majority and minimal projection', async () => {
    query.find.mockReturnValue({ limit: query.limit });
    query.limit.mockReturnValue({ toArray: query.toArray });
    query.toArray.mockResolvedValue([row]);
    const source = new LegacyGamesMongoAdapter({ uri: 'mongodb://synthetic.invalid/fixture' });
    await expect(source.readCreateLocationEvidence(['synthetic-game'])).resolves.toHaveLength(1);
    expect(query.options.at(-1)).toMatchObject({
      readPreference: 'primary',
      readConcern: { level: 'majority' },
      retryReads: false,
    });
    expect(query.find).toHaveBeenLastCalledWith(
      { id: { $in: ['synthetic-game'] } },
      {
        projection: { _id: 0, id: 1, updatedAt: 1, 'booking.studioId': 1, 'booking.roomId': 1 },
        maxTimeMS: 5000,
      },
    );
    expect(query.limit).toHaveBeenCalledWith(10001);
    expect(query.close).toHaveBeenCalled();
    query.toArray.mockResolvedValue([row, row]);
    await expect(source.readCreateLocationEvidence(['synthetic-game'])).rejects.toThrow(
      'UNAVAILABLE',
    );
  });
});
