import { describe, it, expect, vi } from 'vitest';
import { PadlHubApiClient } from './index.js';
import {
  parseStationReadReceipt,
  parseStationStreamPage,
  parseStationStreamSummaries,
} from './station-stream.js';
const id = '11111111-1111-4111-8111-111111111111';
const input = { requestId: id, streamId: id, membershipEpoch: 0, throughSequence: 2 };
const receipt = {
  contractVersion: 1,
  contract: 'station-read',
  ...input,
  outcome: 'CONFIRMED',
  readThroughSequence: 2,
};
const position = {
  streamId: id,
  membershipEpoch: 0,
  baselineSequence: 0,
  readThroughSequence: 0,
  publishedThroughSequence: 0,
  unreadCount: 0,
};
const page = {
  historyVersion: 3,
  mode: 'STREAM',
  ...position,
  afterSequence: 0,
  throughSequence: 0,
  items: [],
  nextCursor: null,
  catchUpCursor: 'abcdefghijklmnop',
  olderCursor: null,
  archiveCursor: 'abcdefghijklmnop',
  canRequestStationMessage: true,
};
function client(transport: typeof fetch) {
  return new PadlHubApiClient({
    baseUrl: 'https://api.invalid',
    tenantKey: 'test',
    platform: 'web',
    appVersion: 'test',
    initialAccessToken: 'synthetic-user-token',
    fetchImplementation: transport,
  });
}
describe('station stream SDK exact original requests', () => {
  it('original read key/header and status GET without mutation', async () => {
    const transport = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(receipt)));
    const api = client(transport);
    expect(await api.requestStationCommunityRead(id, input)).toEqual(receipt);
    await api.getStationCommunityReadRequest(id, id);
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Idempotency-Key': id },
      body: JSON.stringify(input),
    });
    expect(transport.mock.calls[1]?.[1]?.body).toBeUndefined();
  });
  it.each([401, 403, 409, 503])(
    'never retries read POST or refreshes auth on %i',
    async (status) => {
      const transport = vi.fn<typeof fetch>(() =>
        Promise.resolve(Response.json({ code: 'UNAVAILABLE' }, { status })),
      );
      await expect(client(transport).requestStationCommunityRead(id, input)).rejects.toThrow();
      expect(transport).toHaveBeenCalledOnce();
    },
  );
  it('network ambiguity has no automatic POST retry', async () => {
    const transport = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('offline')));
    await expect(client(transport).requestStationCommunityRead(id, input)).rejects.toThrow();
    expect(transport).toHaveBeenCalledOnce();
  });
  it('malformed path/body/over50 batch fail before HTTP', async () => {
    const transport = vi.fn<typeof fetch>();
    const api = client(transport);
    await expect(api.requestStationCommunityRead('foreign/path', input)).rejects.toThrow();
    await expect(
      api.listStationStreamSummaries(Array.from({ length: 51 }, () => id)),
    ).rejects.toThrow();
    await expect(api.getStationCommunityStream(id, { limit: 51 })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    { ...receipt, throughSequence: 3 },
    { ...receipt, membershipEpoch: '0' },
    { ...receipt, privateId: 'x' },
    { ...receipt, outcome: ['CONFIRMED'] },
    { ...receipt, readThroughSequence: 1 },
  ])('rejects altered receipt %#', (value) => {
    expect(() => parseStationReadReceipt(value, id, input)).toThrow();
  });
  it('accepts exact summary/page and rejects private/overflow/coerced fields', () => {
    expect(parseStationStreamPage(page, 50, true)).toEqual(page);
    for (const patch of [
      { unreadCount: 1 },
      { membershipEpoch: '0' },
      { publishedThroughSequence: Number.MAX_SAFE_INTEGER },
      { authorPhone: 'private' },
      { mode: ['STREAM'] },
    ])
      expect(() => parseStationStreamPage({ ...page, ...patch }, 50, true)).toThrow();
    const summaries = {
      contractVersion: 1,
      contract: 'station-stream-summaries',
      items: [{ communityId: id, availability: 'AVAILABLE', ...position }],
    };
    expect(parseStationStreamSummaries(summaries, [id])).toEqual(summaries);
    expect(() =>
      parseStationStreamSummaries(
        { ...summaries, items: [{ communityId: id, availability: 'UNAVAILABLE' }] },
        [id],
      ),
    ).toThrow();
  });
});
