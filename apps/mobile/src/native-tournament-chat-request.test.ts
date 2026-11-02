import { describe, expect, it, vi } from 'vitest';
import { tournamentChatRequest } from './native-tournament-chat-request.js';
import { createNativeApiFetch, type AndroidSessionPlugin } from './native-api-fetch.js';
import { createIOSFetch, type IOSSessionPlugin } from './ios/session.js';
const config = {
  apiBaseUrl: 'https://lk2.padlhub.su',
  tenantKey: 'test',
  appVersion: '1',
  appBuild: '1',
};
const id = '11111111-1111-4111-8111-111111111111',
  key = '22222222-2222-4222-8222-222222222222';
const root = config.apiBaseUrl + '/user/api/v1/test/tournaments/' + id + '/chat/';
const headers = { authorization: 'Bearer synthetic.session' };
const read = { requestId: key, streamId: id, witnessHash: 'a'.repeat(64), throughSequence: 42 };
const post = (body: unknown = { requestId: key, text: 'Hello' }): RequestInit => ({
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': key },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
describe('native tournament chat strict wire', () => {
  it('accepts exactly six operations and retains original request identity', () => {
    for (const [path, resource, input] of [
      ['messages?limit=50&cursor=' + 'a'.repeat(1800), 'history', { headers }],
      ['read-position', 'position', { headers }],
      ['message-requests', 'send', post()],
      ['message-requests/' + key, 'status', { headers }],
      ['read-requests', 'read', post(read)],
      ['read-requests/' + key, 'readStatus', { headers }],
    ] as const)
      expect(tournamentChatRequest(root + path, input, config)).toMatchObject({
        resource,
        resourceId: id,
        ...(resource === 'history' || resource === 'position' ? {} : { requestId: key }),
      });
  });
  it.each([
    'messages?limit=0',
    'messages?limit=51',
    'messages?limit=1&limit=2',
    'messages?cursor=%61',
    'messages?cursor=' + 'a'.repeat(1801),
    'messages?',
    'messages#x',
    'read-position?limit=1',
    'messages/' + key,
    'message-requests/' + key + '?x=1',
    '../chat/messages',
    '%6dessages',
    'messages/',
    'messages?identity=x',
  ])('rejects malformed path/query %s', (path) =>
    expect(() => tournamentChatRequest(root + path, { headers }, config)).toThrow(),
  );
  it.each([
    {},
    null,
    [],
    { requestId: key, text: '' },
    { requestId: key, text: '\0' },
    { requestId: key, text: '\ud800' },
    { requestId: key, text: 'x'.repeat(8001) },
    { requestId: key, text: 'hello', userId: id },
  ])('rejects invalid send body %j', (body) =>
    expect(() => tournamentChatRequest(root + 'message-requests', post(body), config)).toThrow(),
  );
  it.each([true, '1', -1, 1.5, 9007199254740991])(
    'rejects unsafe read position %s',
    (throughSequence) =>
      expect(() =>
        tournamentChatRequest(root + 'read-requests', post({ ...read, throughSequence }), config),
      ).toThrow(),
  );
  it('rejects duplicate keys, foreign identity/origin, binary and wrong method or key', () => {
    for (const input of [
      post('{"requestId":"' + key + '","text":"a","text":"b"}'),
      {
        ...post(),
        headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': id },
      },
      {
        ...post(),
        headers: {
          ...headers,
          'content-type': 'application/json',
          'idempotency-key': key,
          cookie: 'no',
        },
      },
      { ...post(), body: new Uint8Array([1]) },
      { ...post(), method: 'PUT' },
    ])
      expect(() => tournamentChatRequest(root + 'message-requests', input, config)).toThrow();
    for (const url of [
      root.replace('lk2.padlhub.su', 'foreign.invalid'),
      root.replace('/test/', '/foreign/'),
      root.replace(id, '%31' + id.slice(1)),
    ])
      expect(() => tournamentChatRequest(url + 'messages', { headers }, config)).toThrow();
    for (const value of [
      JSON.stringify(read).replace('}', ',"throughSequence":42}'),
      JSON.stringify(read).replace(':42', ':4.2e1'),
    ])
      expect(() => tournamentChatRequest(root + 'read-requests', post(value), config)).toThrow();
  });
  it('preserves valid Unicode and maximum UTF16 length with explicit no-NUL rules', () => {
    for (const text of ['😀'.repeat(4000), '漢'.repeat(8000), '\u0085', '\uFEFF hello'])
      expect(
        tournamentChatRequest(root + 'message-requests', post({ requestId: key, text }), config)
          ?.resource,
      ).toBe('send');
  });
  it('passes actual Android raw path and iOS typed operation without cookies or raw owner fields', async () => {
    const android = vi
      .fn<AndroidSessionPlugin['request']>()
      .mockResolvedValue({ status: 200, headers: {}, body: btoa('{}') });
    await createNativeApiFetch(config, {
      request: android,
      configuration: () => Promise.resolve(config),
    })(root + 'read-requests', post(read));
    expect(android.mock.calls[0]?.[0]).toMatchObject({
      path: '/user/api/v1/test/tournaments/' + id + '/chat/read-requests',
      method: 'POST',
      body: JSON.stringify(read),
    });
    const ios = vi
      .fn<IOSSessionPlugin['request']>()
      .mockResolvedValue({ status: 200, headers: {}, body: '{}' });
    await createIOSFetch(
      config,
      { request: ios, configuration: () => Promise.resolve(config) },
      undefined,
      undefined,
      () => true,
    )(root + 'read-requests', post(read));
    expect(ios.mock.calls[0]?.[0]).toMatchObject({
      operation: 'tournamentChat',
      resource: 'read',
      resourceId: id,
      requestId: key,
      query: {},
      body: JSON.stringify(read),
    });
    expect(ios.mock.calls[0]?.[0]).not.toHaveProperty('path');
    await expect(
      createIOSFetch(config, { request: ios, configuration: () => Promise.resolve(config) })(
        root + 'read-requests',
        post(read),
      ),
    ).rejects.toThrow('Session changed');
    expect(ios).toHaveBeenCalledOnce();
  });
});

it.each(['android', 'ios'] as const)(
  '%s decoded response backstop allows 3 MiB only for history',
  async (platform) => {
    for (const size of [2_400_000, 3 * 1024 * 1024 + 1]) {
      const body = ' '.repeat(size);
      const plugin = {
        configuration: () => Promise.resolve(config),
        request: () =>
          Promise.resolve({
            status: 200,
            headers: {},
            body: platform === 'android' ? btoa(body) : body,
          }),
      };
      const transport =
        platform === 'android'
          ? createNativeApiFetch(config, plugin)
          : createIOSFetch(config, plugin, undefined, undefined, () => true);
      const history = transport(root + 'messages?limit=50', { headers });
      if (size <= 3 * 1024 * 1024) expect((await history).status).toBe(200);
      else await expect(history).rejects.toThrow();
      for (const path of ['read-position', 'message-requests/' + key, 'read-requests/' + key])
        await expect(transport(root + path, { headers })).rejects.toThrow();
    }
  },
);
