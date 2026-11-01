import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, verify } from 'node:crypto';
import fixture from './fixtures/station-notification-owner-wire.json';
import {
  parseStationResponse,
  stationRequests,
  stationResponses,
  stationHash,
  createStationSigner,
  type StationMode,
} from './station-notification-protocol.js';
describe('actual composed LK station feed fixture (synthetic, no runtime evidence)', () => {
  for (const operation of fixture.operations)
    it(operation.mode + ' exact source response/body hash', () => {
      const mode = operation.mode as StationMode,
        request = stationRequests[mode].parse(operation.request);
      expect(stationHash('station-notification-body:v1', request)).toBe(operation.bodyHash);
      expect(
        parseStationResponse(mode, operation.response, request, operation.response.checkedAtMs),
      ).toEqual(operation.response);
      for (const key of ['streamId', 'incarnationHash', 'communityId', 'requestId'])
        expect(() =>
          parseStationResponse(
            mode,
            { ...operation.response, [key]: 'wrong' },
            request,
            operation.response.checkedAtMs,
          ),
        ).toThrow();
      expect(() =>
        parseStationResponse(
          mode,
          { ...operation.response, secret: 'no' },
          request,
          operation.response.checkedAtMs,
        ),
      ).toThrow();
      expect(() =>
        parseStationResponse(mode, operation.response, request, operation.response.validUntilMs),
      ).toThrow();
    });
  it('strict contiguous pages and original epoch', () => {
    const p = fixture.operations[0]!;
    const q = stationRequests.publications.parse(p.request),
      r = structuredClone(stationResponses.publications.parse(p.response));
    r.items[0]!.sequence = 3;
    expect(() => parseStationResponse('publications', r, q, r.checkedAtMs)).toThrow();
    const e = fixture.operations[2]!;
    const er = structuredClone(stationResponses.eligibility.parse(e.response));
    er.recipient.membershipEpoch++;
    expect(() =>
      parseStationResponse(
        'eligibility',
        er,
        stationRequests.eligibility.parse(e.request),
        er.checkedAtMs,
      ),
    ).toThrow();
  });
  it('fresh dedicated RSA claims bind exact canonical body', () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }),
      o = fixture.operations[0]!,
      q = stationRequests.publications.parse(o.request);
    const sign = createStationSigner({
      privateKey: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      issuer: 'synthetic',
      audience: 'owner',
      keyId: 'test',
      tenantId: o.jwtClaims.tenant_id,
    });
    const token = sign('publications', q, 'synthetic-feed', o.response.checkedAtMs),
      [h, b, s] = token.split('.');
    expect(
      verify('RSA-SHA256', Buffer.from(h + '.' + b), keys.publicKey, Buffer.from(s!, 'base64url')),
    ).toBe(true);
    const claims = JSON.parse(Buffer.from(b!, 'base64url').toString()) as {
      body_sha256: string;
      scope: string;
      exp: number;
      iat: number;
    };
    expect(claims.body_sha256).toBe(o.bodyHash);
    expect(claims.scope).toBe(o.jwtClaims.scope);
    expect(claims.exp - claims.iat).toBe(30);
  });
});
