import { describe, expect, it } from 'vitest';
import { stationStreamRequest } from './native-station-stream-request.js';
const config = { apiBaseUrl: 'https://lk2.padlhub.su', tenantKey: 'test' };
const id = '11111111-1111-4111-8111-111111111111',
  requestId = '22222222-2222-4222-8222-222222222222';
const root = config.apiBaseUrl + '/user/api/v1/test/community-views/';
const input = { requestId, streamId: id, membershipEpoch: 1, throughSequence: 42 };
const headers = { authorization: 'Bearer synthetic.session' };
const post = (body = JSON.stringify(input)): RequestInit => ({
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': requestId },
  body,
});
describe('native station stream strict wire', () => {
  it('accepts four exact routes and preserves v3 limits', () => {
    expect(
      stationStreamRequest(
        root + 'station-stream-summaries?communityIds=' + id + '%2C' + requestId,
        { headers },
        config,
      )?.query,
    ).toEqual({ communityIds: id + ',' + requestId });
    expect(
      stationStreamRequest(
        root + id + '/station-stream?limit=50&cursor=' + 'a'.repeat(1024),
        { headers },
        config,
      )?.resource,
    ).toBe('stream');
    expect(stationStreamRequest(root + id + '/read-requests', post(), config)?.requestId).toBe(
      requestId,
    );
    expect(
      stationStreamRequest(root + id + '/read-requests/' + requestId, { headers }, config)
        ?.resource,
    ).toBe('readStatus');
    expect(stationStreamRequest(root + id + '/chat', { headers }, config)).toBeNull();
  });
  it.each([
    '?limit=51',
    '?limit=1&limit=2',
    '?cursor=%61aaaaaaaaaaaaaaaa',
    '?cursor=' + 'a'.repeat(1025),
    '?phone=1',
    '?',
    '?limit=1#x',
  ])('rejects malformed stream query %s', (query) => {
    expect(() =>
      stationStreamRequest(root + id + '/station-stream' + query, { headers }, config),
    ).toThrow();
  });
  it.each([
    null,
    [],
    { ...input, extra: 1 },
    { ...input, membershipEpoch: true },
    { ...input, membershipEpoch: '1' },
    { ...input, throughSequence: 9007199254740991 },
    { ...input, throughSequence: -1 },
    { ...input, throughSequence: 1.1 },
  ])('rejects malformed read tuple %j', (body) => {
    expect(() =>
      stationStreamRequest(root + id + '/read-requests', post(JSON.stringify(body)), config),
    ).toThrow();
  });
  it('rejects duplicate fields, wrong key, bytes, status writes and foreign origin', () => {
    for (const body of [
      JSON.stringify(input).replace('}', ',"throughSequence":42}'),
      JSON.stringify(input) + ' '.repeat(16384),
    ])
      expect(() =>
        stationStreamRequest(root + id + '/read-requests', post(body), config),
      ).toThrow();
    expect(() =>
      stationStreamRequest(
        root + id + '/read-requests',
        {
          ...post(),
          headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': id },
        },
        config,
      ),
    ).toThrow();
    expect(() =>
      stationStreamRequest(root + id + '/read-requests/' + requestId, post(), config),
    ).toThrow();
    expect(() =>
      stationStreamRequest(
        root.replace('lk2.padlhub.su', 'foreign.invalid') + id + '/station-stream',
        { headers },
        config,
      ),
    ).toThrow();
  });
  it('requires unique bounded summary IDs and exact query', () => {
    for (const query of [
      '',
      id + ',' + id,
      id + '%252C' + requestId,
      id + '&limit=1',
      Array.from(
        { length: 51 },
        (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
      ).join('%2C'),
    ])
      expect(() =>
        stationStreamRequest(
          root + 'station-stream-summaries?communityIds=' + query,
          { headers },
          config,
        ),
      ).toThrow();
  });
});
