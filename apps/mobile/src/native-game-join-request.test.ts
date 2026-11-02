import { expect, it } from 'vitest';
import { nativeJoinRequest } from './native-game-join-request.js';
import { readNativeJoinBody } from '../../web/src/native-game-join-wire.js';
const id = '11111111-1111-4111-8111-111111111111',
  sub = '22222222-2222-4222-8222-222222222222',
  key = '33333333-3333-4333-8333-333333333333';
const config = { apiBaseUrl: 'https://lk2.padlhub.su', tenantKey: 'local-padel' },
  root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}`;
const headers = {
  authorization: 'Bearer synthetic-access',
  'idempotency-key': key,
  'content-type': 'application/json',
};
it('closed body accepts only free or explicit subscription consent and rejects lexical duplication', () => {
  expect(readNativeJoinBody('{"expectedRevision":1}')).toEqual({ expectedRevision: 1 });
  const paid = JSON.stringify({
    expectedRevision: 1,
    subscriptionInstanceId: sub,
    priceConsent: { amountMinor: 0, currency: 'RUB' },
  });
  expect(readNativeJoinBody(paid).priceConsent?.amountMinor).toBe(0);
  for (const body of [
    '{"expectedRevision":1,"expectedRevision":2}',
    String.raw`{"expectedRevision":1,"\u0065xpectedRevision":2}`,
    paid.replace('"amountMinor":0', String.raw`"amountMinor":0,"\u0061mountMinor":100`),
    '{"expectedRevision":true}',
    '{"expectedRevision":-1}',
    '{"expectedRevision":9007199254740992}',
    paid.replace('"RUB"', '"USD"'),
    paid.replace('"amountMinor":0', '"amountMinor":-1'),
    '{"expectedRevision":1,"clientId":"other"}',
  ])
    expect(() => readNativeJoinBody(body)).toThrow();
});
it('exact native wire binds catalogue conditions, command key and operation recovery', () => {
  expect(
    nativeJoinRequest(
      `${root}/games/${id}/join`,
      { method: 'POST', headers, body: '{"expectedRevision":1}' },
      config,
    ),
  ).toMatchObject({ resource: 'join', key, resourceId: id });
  expect(
    nativeJoinRequest(
      `${root}/games/${id}/join-conditions?expectedRevision=1&subscriptionInstanceId=${sub}`,
      { headers: { authorization: headers.authorization } },
      config,
    )?.resource,
  ).toBe('conditions');
  expect(
    nativeJoinRequest(
      `${root}/game-operations/${id}/reconcile`,
      {
        method: 'POST',
        headers: {
          authorization: headers.authorization,
          'idempotency-key': `join-reconcile:${id}`,
        },
      },
      config,
    )?.resource,
  ).toBe('reconcile');
  for (const url of [
    `${root}/games/${id}/join?x=1`,
    `${root}/games/${id}/join?`,
    `${root}/games/${id}/join-operation/`,
    `${root}/game-operations/${id}/other`,
  ])
    expect(() => nativeJoinRequest(url, { method: 'POST', headers, body: '{}' }, config)).toThrow();
  expect(() =>
    nativeJoinRequest(
      `${root}/game-operations/${id}/reconcile`,
      { method: 'POST', headers: { authorization: headers.authorization, 'idempotency-key': key } },
      config,
    ),
  ).toThrow();
});
