import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { z } from 'zod';

export const stationCredentialSchema = z
  .object({ privateKey: z.string().min(32).max(12000) })
  .strict();
export const STATION_CONTRACT = 'station-notifications.v1';
const seq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const stationFactSchema = z
  .object({
    messageId: z.string().uuid(),
    sequence: seq.refine((v) => v > 0),
    authorPlayerId: id,
    proofHash: digest,
  })
  .strict();
export const stationRecipientSchema = z
  .object({ playerId: id, membershipEpoch: seq, baselineSequence: seq, readThroughSequence: seq })
  .strict()
  .refine((x) => x.baselineSequence <= x.readThroughSequence);
export type StationFact = z.infer<typeof stationFactSchema>;
export type StationRecipient = z.infer<typeof stationRecipientSchema>;
export interface StationScope {
  communityId: string;
  streamId: string;
  incarnationHash: string;
}
const base = z.object({
  contractVersion: z.literal(1),
  requestId: z.string().uuid(),
  communityId: id,
  streamId: z.string().uuid(),
  incarnationHash: digest,
});
export const stationRequests = {
  publications: base
    .extend({
      afterSequence: seq,
      throughSequence: seq.nullable(),
      limit: z.number().int().min(1).max(50),
    })
    .strict(),
  recipients: base
    .extend({
      fact: stationFactSchema,
      afterPlayerId: id.nullable(),
      limit: z.number().int().min(1).max(50),
    })
    .strict(),
  eligibility: base.extend({ fact: stationFactSchema, recipient: stationRecipientSchema }).strict(),
};
export type StationMode = keyof typeof stationRequests;
export type StationRequest = z.infer<(typeof stationRequests)[StationMode]>;
const responseBase = z.object({
  contract: z.literal(STATION_CONTRACT),
  requestId: z.string().uuid(),
  ownerNamespace: z.literal('iSkq6G'),
  communityId: id,
  streamId: z.string().uuid(),
  incarnationHash: digest,
  checkedAtMs: seq,
  validUntilMs: seq,
});
export const stationResponses = {
  publications: responseBase
    .extend({
      throughSequence: seq,
      items: z.array(stationFactSchema).max(50),
      nextAfterSequence: seq.nullable(),
      complete: z.boolean(),
    })
    .strict(),
  recipients: responseBase
    .extend({
      fact: stationFactSchema,
      items: z.array(stationRecipientSchema).max(50),
      nextAfterPlayerId: id.nullable(),
      complete: z.boolean(),
    })
    .strict(),
  eligibility: z.union([
    responseBase
      .extend({
        fact: stationFactSchema,
        recipient: stationRecipientSchema,
        outcome: z.literal('ALLOW'),
        currentReadThroughSequence: seq,
      })
      .strict(),
    responseBase
      .extend({
        fact: stationFactSchema,
        recipient: stationRecipientSchema,
        outcome: z.literal('DENY'),
      })
      .strict(),
  ]),
};
export type StationResponses = { [M in StationMode]: z.infer<(typeof stationResponses)[M]> };
export function stationCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stationCanonical).join(',') + ']';
  const x = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(x)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stationCanonical(x[k]))
      .join(',') +
    '}'
  );
}
export const stationHash = (domain: string, value: unknown) =>
  'sha256:' +
  createHash('sha256')
    .update(domain + '\0' + stationCanonical(value))
    .digest('hex');
export function parseStationResponse<M extends StationMode>(
  mode: M,
  raw: unknown,
  request: StationRequest,
  now: number,
): StationResponses[M] {
  const r = stationResponses[mode].parse(raw);
  for (const key of ['requestId', 'communityId', 'streamId', 'incarnationHash'] as const)
    if (r[key] !== request[key]) throw Error('STATION_SCOPE_MISMATCH');
  if (
    r.checkedAtMs > now + 1000 ||
    r.validUntilMs <= now ||
    r.validUntilMs <= r.checkedAtMs ||
    r.validUntilMs - r.checkedAtMs > 5000
  )
    throw Error('STATION_AUTHORIZATION_EXPIRED');
  if (mode === 'publications') {
    const q = stationRequests.publications.parse(request),
      p = stationResponses.publications.parse(r);
    if (
      p.throughSequence < q.afterSequence ||
      (q.throughSequence !== null && q.throughSequence !== p.throughSequence) ||
      p.items.length > q.limit
    )
      throw Error('STATION_PAGE_INVALID');
    p.items.forEach((item, i) => {
      if (item.sequence !== q.afterSequence + i + 1) throw Error('STATION_SEQUENCE_GAP');
    });
    const end = q.afterSequence + p.items.length;
    if (
      end > p.throughSequence ||
      p.complete !== (end === p.throughSequence) ||
      p.nextAfterSequence !== (p.complete ? null : end) ||
      (!p.complete && p.items.length !== q.limit)
    )
      throw Error('STATION_PAGE_INVALID');
  } else if (mode === 'recipients') {
    const q = stationRequests.recipients.parse(request),
      p = stationResponses.recipients.parse(r);
    if (
      stationCanonical(p.fact) !== stationCanonical(q.fact) ||
      p.items.length > q.limit ||
      p.complete !== (p.nextAfterPlayerId === null)
    )
      throw Error('STATION_PAGE_INVALID');
    let prior = q.afterPlayerId;
    for (const x of p.items) {
      if (
        (prior !== null && x.playerId <= prior) ||
        x.playerId === q.fact.authorPlayerId ||
        x.readThroughSequence >= q.fact.sequence
      )
        throw Error('STATION_RECIPIENT_INVALID');
      prior = x.playerId;
    }
    if (
      p.nextAfterPlayerId !== null &&
      ((q.afterPlayerId !== null && p.nextAfterPlayerId <= q.afterPlayerId) ||
        (prior !== null && p.nextAfterPlayerId < prior))
    )
      throw Error('STATION_CURSOR_INVALID');
  } else {
    const q = stationRequests.eligibility.parse(request),
      p = stationResponses.eligibility.parse(r);
    if (
      stationCanonical(q.fact) !== stationCanonical(p.fact) ||
      stationCanonical(q.recipient) !== stationCanonical(p.recipient) ||
      (p.outcome === 'ALLOW' &&
        (p.currentReadThroughSequence < q.recipient.readThroughSequence ||
          p.currentReadThroughSequence >= q.fact.sequence))
    )
      throw Error('STATION_RECIPIENT_INVALID');
  }
  return r as StationResponses[M];
}
export function createStationSigner(options: {
  privateKey: string;
  issuer: string;
  audience: string;
  keyId: string;
  tenantId: string;
}) {
  const key = createPrivateKey(options.privateKey);
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
    throw Error('STATION_SIGNER_INVALID');
  z.string().uuid().parse(options.tenantId);
  return (mode: StationMode, body: StationRequest, correlationId: string, now = Date.now()) => {
    stationRequests[mode].parse(body);
    const iat = Math.floor(now / 1000),
      path = '/lk/internal/station-notifications/v1/' + mode;
    const header = { alg: 'RS256', kid: options.keyId, typ: 'phub-station-notification-feed+jwt' };
    const claims = {
      iss: options.issuer,
      aud: options.audience,
      sub: 'lk2-station-notification-importer',
      jti: randomUUID(),
      iat,
      nbf: iat,
      exp: iat + 30,
      tenant_id: options.tenantId,
      owner_namespace: 'iSkq6G',
      scope: 'communities.station-notifications.' + mode,
      method: 'POST',
      path,
      body_sha256: stationHash('station-notification-body:v1', body),
      correlation_id: correlationId,
      request_id: body.requestId,
      contract: STATION_CONTRACT,
    };
    const unsigned =
      Buffer.from(stationCanonical(header)).toString('base64url') +
      '.' +
      Buffer.from(stationCanonical(claims)).toString('base64url');
    return unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url');
  };
}
