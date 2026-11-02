import { describe, it, expect } from 'vitest';
import { gameCancelRequest } from './native-game-cancel-request.js';
const config = { apiBaseUrl: 'https://lk2.padlhub.su', tenantKey: 'local-padel' };
const url =
  config.apiBaseUrl + '/user/api/v1/local-padel/games/751fe6a8-b0b1-4b2b-873d-a2d785c4e191/cancel';
const init = {
  method: 'POST',
  body: '{"reasonCode":"ORGANIZER_REQUEST"}',
  headers: {
    authorization: 'Bearer synthetic-access',
    'idempotency-key': 'c'.repeat(20),
    'content-type': 'application/json',
  },
};
describe('native exact local CANCEL request', () => {
  it('accepts only the original existing command', () =>
    expect(gameCancelRequest(url, init, config)).toEqual({
      resourceId: '751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
    }));
  it.each(['?force=true', '/', '\n'])('rejects path suffix %j', (suffix) =>
    expect(() => gameCancelRequest(url + suffix, init, config)).toThrow(),
  );
  it.each(['GET', 'DELETE', 'PATCH'])('rejects method %s', (method) =>
    expect(() => gameCancelRequest(url, { ...init, method }, config)).toThrow(),
  );
  it.each([
    '{}',
    '{"reasonCode":"ADMIN"}',
    '{"reasonCode":"ORGANIZER_REQUEST","note":"extra"}',
    '{"reasonCode":"ORGANIZER_REQUEST","reasonCode":"ORGANIZER_REQUEST"}',
    '{"reasonCode":["ORGANIZER_REQUEST"]}',
  ])('rejects malformed/expanded body %s', (body) =>
    expect(() => gameCancelRequest(url, { ...init, body }, config)).toThrow(),
  );
  it('rejects absent auth/key and noncanonical UUID', () => {
    expect(() => gameCancelRequest(url, { ...init, headers: {} }, config)).toThrow();
    expect(() => gameCancelRequest(url.replace('-4b2b-', '-0b2b-'), init, config)).toThrow();
  });
});
