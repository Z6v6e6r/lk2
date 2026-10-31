import { describe, expect, it, vi } from 'vitest';
import { createIOSFetch, type IOSSessionPlugin } from './session.js';
import { config, nativeResult, viewerId } from './testing/cabinet-fixtures.js';

const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}`;
const key = 'synthetic-message-key';
const headers = { authorization: 'Bearer synthetic', 'idempotency-key': key };
const message = JSON.stringify({ clientMessageId: key, body: 'Привет' });
function fixture() {
  const request = vi.fn<IOSSessionPlugin['request']>().mockResolvedValue(nativeResult({}));
  return {
    request,
    fetch: createIOSFetch(config, {
      configuration: async () => await Promise.resolve(config),
      request,
    }),
  };
}
describe('iOS existing-conversation native boundary', () => {
  it.each([
    ['/conversations?limit=100', 'conversations'],
    [`/conversations/${viewerId}/messages?afterSequence=0&limit=100`, 'conversationMessages'],
  ])('maps bounded GET %s', async (path, resource) => {
    const { fetch, request } = fixture();
    await fetch(root + path, { headers: { authorization: headers.authorization } });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ operation: 'read', resource }));
  });
  it.each([
    ['messages', 'POST', message, 'sendMessage'],
    ['read-cursor', 'PUT', '{"throughSequence":0}', 'messageReadCursor'],
    ['notification-policy', 'PUT', '{"level":"NONE"}', 'conversationPolicy'],
  ])('maps only the exact %s command', async (suffix, method, body, resource) => {
    const { fetch, request } = fixture();
    await fetch(`${root}/conversations/${viewerId}/${suffix}`, { method, headers, body });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'messaging', resource, resourceId: viewerId, body }),
    );
  });
  it('issues an empty-body ticket without a command key', async () => {
    const { fetch, request } = fixture();
    await fetch(`${root}/messaging/realtime-ticket`, {
      method: 'POST',
      headers: { authorization: headers.authorization },
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'messaging', resource: 'realtimeTicket' }),
    );
  });
  it.each([
    ['/conversations?limit=101', 'GET'],
    ['/conversations?tenant=other', 'GET'],
    ['/conversations?limit=2&limit=3', 'GET'],
    [`/conversations/${viewerId}/messages?afterSequence=-1`, 'GET'],
    [`/conversations/${viewerId}/messages?afterSequence=9007199254740992`, 'GET'],
    [`/conversations/${viewerId}/messages?afterSequence=1e2`, 'GET'],
    [`/conversations/${viewerId}/messages?afterSequence=01`, 'GET'],
    [`/conversations/${viewerId}/messages?afterSequence=0%0a`, 'GET'],
    ['/conversations/direct', 'POST'],
    ['/conversations/game', 'POST'],
    [`/conversations/${viewerId}/messages`, 'DELETE'],
    [`/conversations/${viewerId}/media/uploads`, 'POST'],
    [`/conversations/${viewerId}/messages?tenant=other`, 'POST'],
    ['/conversations/%2e%2e/messages', 'POST'],
  ])('rejects unsupported destination %s %s without native I/O', async (path, method) => {
    const { fetch, request } = fixture();
    await expect(fetch(root + path, { method, headers })).rejects.toMatchObject({
      code: 'NATIVE_REQUEST_REJECTED',
    });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    ['messages', '{"clientMessageId":"synthetic-message-key","body":""}'],
    ['messages', '{"clientMessageId":"different-message-key","body":"text"}'],
    ['messages', '{"clientMessageId":"synthetic-message-key","body":"text","attachmentIds":[]}'],
    ['messages', JSON.stringify({ clientMessageId: key, body: 'a'.repeat(8001) })],
    ['messages', '[]'],
    ['messages', 'null'],
    ['messages', '{'],
    ['read-cursor', '{"throughSequence":true}'],
    ['read-cursor', '{"throughSequence":1.5}'],
    ['read-cursor', '{"throughSequence":9007199254740992}'],
    ['read-cursor', '{"throughSequence":0,"tenant":"other"}'],
    ['notification-policy', '{"level":"ALL","mutedUntil":"2000-01-01T00:00:00Z"}'],
    ['notification-policy', '{"level":"ALL","mutedUntil":true}'],
    ['notification-policy', '{"level":"ALL","mutedUntil":"2099-01-01T00:00:00Z"}'],
    ['notification-policy', '{"level":"INVALID"}'],
  ])('rejects invalid %s payload', async (suffix, body) => {
    const { fetch, request } = fixture();
    await expect(
      fetch(`${root}/conversations/${viewerId}/${suffix}`, {
        method: suffix === 'messages' ? 'POST' : 'PUT',
        headers,
        body,
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_REQUEST_REJECTED' });
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects missing auth/key, body-bearing reads/tickets and foreign origins', async () => {
    const { fetch, request } = fixture();
    for (const invalidHeaders of [
      {},
      { authorization: headers.authorization },
      { ...headers, authorization: 'Bearer ' },
    ]) {
      await expect(
        fetch(`${root}/conversations/${viewerId}/messages`, {
          method: 'POST',
          headers: invalidHeaders,
          body: message,
        }),
      ).rejects.toMatchObject({ code: 'NATIVE_REQUEST_REJECTED' });
    }
    await expect(fetch(`${root}/conversations`, { body: '{}' })).rejects.toMatchObject({
      code: 'NATIVE_REQUEST_REJECTED',
    });
    await expect(
      fetch(`${root}/messaging/realtime-ticket`, { method: 'POST', headers, body: '{}' }),
    ).rejects.toMatchObject({ code: 'NATIVE_REQUEST_REJECTED' });
    await expect(
      fetch(root.replace('local-padel', 'other') + '/conversations'),
    ).rejects.toMatchObject({ code: 'NATIVE_REQUEST_REJECTED' });
    await expect(fetch('https://evil.test/conversations')).rejects.toMatchObject({
      code: 'NATIVE_REQUEST_REJECTED',
    });
    expect(request).not.toHaveBeenCalled();
  });
});
