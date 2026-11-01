import { describe, expect, it } from 'vitest';
import { stationRequest } from './native-station-message-request.js';
const id = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const config = { apiBaseUrl: 'https://lk2.padlhub.su', tenantKey: 'test' };
const url = `${config.apiBaseUrl}/user/api/v1/test/community-views/${id}`;
const headers = {
  authorization: 'Bearer synthetic.session',
  'content-type': 'application/json',
  'idempotency-key': requestId,
};
const send = (text = 'Привет'): RequestInit => ({
  method: 'POST',
  headers,
  body: JSON.stringify({ requestId, text }),
});
describe('native station-only wire', () => {
  it('accepts original send/status/history and preserves opaque cursor', () => {
    expect(stationRequest(url + '/message-requests', send(), config)).toEqual({
      resource: 'send',
      resourceId: id,
      requestId,
      query: {},
    });
    expect(
      stationRequest(
        url + '/message-requests/' + requestId,
        { headers: { authorization: headers.authorization } },
        config,
      )?.resource,
    ).toBe('status');
    expect(
      stationRequest(
        url + '/chat?limit=50&cursor=' + 'a'.repeat(20),
        { headers: { authorization: headers.authorization } },
        config,
      )?.query,
    ).toEqual({ limit: '50', cursor: 'a'.repeat(20) });
  });
  it.each(['я'.repeat(8000), '😀'.repeat(4000), '\n'.repeat(7999) + 'a'])(
    'accepts UTF16 limit independently of UTF8 envelope',
    (text) => {
      expect(stationRequest(url + '/message-requests', send(text), config)?.resource).toBe('send');
    },
  );
  it.each([
    [url + '/message-requests', send('a'.repeat(8001))],
    [url + '/message-requests', send(' \n\t')],
    [
      url + '/message-requests',
      { ...send(), body: JSON.stringify({ requestId, text: 'hi', actor: id }) },
    ],
    [
      url + '/message-requests',
      { ...send(), body: `{"requestId":"${requestId}","text":"a","text":"b"}` },
    ],
    [url + '/message-requests', { ...send(), headers: { ...headers, 'idempotency-key': id } }],
    [
      url + '/message-requests',
      { ...send(), headers: { ...headers, 'content-type': 'text/plain' } },
    ],
    [url + '/message-requests', { ...send(), headers: { ...headers, cookie: 'private' } }],
    [url + '/message-requests', { ...send(), body: new Uint8Array([1]) }],
    [url + '/message-requests?x=1', send()],
    [url + '/message-requests', { ...send(), method: 'PUT' }],
    [url + '/chat?limit=51', { headers }],
    [url + '/chat?limit=1&limit=2', { headers }],
    [url + '/chat?cursor=%61'.repeat(2), { headers }],
    [url + '/chat?phone=123', { headers }],
    [url + '/chat', { headers, body: '{}' }],
    [url.replace(id, id.replace('-4111-', '-0111-')) + '/message-requests', send()],
    [url.replace('lk2.padlhub.su', 'viva.example') + '/message-requests', send()],
    [url + '/../chat', send()],
    [url + '/message-requests\n', send()],
  ])('rejects malformed/overbroad request %s', (destination, init) => {
    expect(() => stationRequest(destination, init, config)).toThrow(
      'Native station request rejected',
    );
  });
  it('does not authorize unrelated routes', () =>
    expect(
      stationRequest(config.apiBaseUrl + '/user/api/v1/test/conversations/direct', send(), config),
    ).toBeNull());
});
