import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { uiObservationFixture } from './roster-ui-observation-proof.fixtures.js';
import {
  assertUiObservationFresh,
  canonicalUiObservationJson,
  parseUiObservationProof,
  verifyUiObservationMembership,
  readUiObservationStdin,
  UI_OBSERVATION_MAX_BYTES,
} from './roster-ui-observation-proof.js';
it('admits four exact reviewed subscription observations and creates PAID only after the proof join', () => {
  const f = uiObservationFixture(),
    p = f.seal(),
    parsed = parseUiObservationProof(p.bytes, p.sha);
  expect(f.source.participants.every((p) => !Object.hasOwn(p, 'paymentState'))).toBe(true);
  assertUiObservationFresh(parsed.envelope, f.now);
  const verified = verifyUiObservationMembership({
    envelope: parsed.envelope,
    source: f.source,
    mappings: f.mappings,
    tenantKey: 'local-padel',
    gameId: f.gameId,
    operationId: f.envelope.body.operationId,
    providerTenantKey: 'synthetic-provider',
  });
  expect(verified.snapshot.participants.map((p) => p.paymentState)).toEqual([
    'PAID',
    'PAID',
    'PAID',
    'PAID',
  ]);
  expect(verified.snapshot).not.toHaveProperty('providerExerciseId');
  expect(verified.snapshot).not.toHaveProperty('sourceObservationSha256');
  expect(
    f.envelope.body.seats.filter((s) => s.acquisition === 'ADMIN_ISSUED_ZERO_PRICE_ENTITLEMENT'),
  ).toHaveLength(2);
});
it.each(['duplicate-key', 'whitespace', 'bad-utf8', 'oversize', 'wrong-hash', 'extra-key'])(
  'rejects unreviewed or ambiguous encoding %s',
  (scenario) => {
    const f = uiObservationFixture(),
      p = f.seal();
    let bytes: Uint8Array = p.bytes,
      sha = p.sha;
    if (scenario === 'duplicate-key')
      bytes = Buffer.from(
        canonicalUiObservationJson(f.envelope).replace('"body":', '"body":{},"body":'),
      );
    if (scenario === 'whitespace')
      bytes = Buffer.from(' ' + canonicalUiObservationJson(f.envelope));
    if (scenario === 'bad-utf8') bytes = new Uint8Array([255]);
    if (scenario === 'oversize') bytes = new Uint8Array(UI_OBSERVATION_MAX_BYTES + 1);
    if (scenario === 'wrong-hash') sha = 'f'.repeat(64);
    if (scenario === 'extra-key')
      bytes = Buffer.from(
        canonicalUiObservationJson({ ...f.envelope, unreviewed: 'private-canary' }),
      );
    expect(() => parseUiObservationProof(bytes, sha)).toThrow(/LEGACY_GAME_UI_OBSERVATION_/);
  },
);
it.each([
  'missing-seat',
  'duplicate-user',
  'reused-capture',
  'family',
  'cancelled',
  'reversal',
  'due',
  'no-debit',
  'future-usage',
  'future-booking',
  'self-review',
  'capture-hash',
  'review-hash',
  'wide-ttl',
])('rejects unsupported observation %s', (scenario) => {
  const f = uiObservationFixture(),
    b = f.envelope.body,
    s = b.seats[0]!;
  if (scenario === 'missing-seat') b.seats.pop();
  if (scenario === 'duplicate-user') b.seats[1]!.userId = s.userId;
  if (scenario === 'reused-capture') b.seats[1]!.usageCaptureId = s.usageCaptureId;
  if (scenario === 'family') Object.assign(s, { familyOrBeneficiaryAmbiguity: true });
  if (scenario === 'cancelled') Object.assign(s, { cancelled: true });
  if (scenario === 'reversal') Object.assign(s, { usageReversed: true });
  if (scenario === 'due') Object.assign(s, { outstandingMinor: 1 });
  if (scenario === 'no-debit') s.remainingAfter = s.remainingBefore;
  if (scenario === 'future-usage') s.usageCreatedAt = '2099-11-16T05:10:00Z';
  if (scenario === 'future-booking') s.bookingCreatedAt = '2099-11-16T05:10:00Z';
  if (scenario === 'self-review') f.envelope.review.reviewerId = b.readerId;
  if (scenario === 'capture-hash') b.captures[0]!.excerptSha256 = 'f'.repeat(64);
  if (scenario === 'wide-ttl') b.expiresAt = '2099-11-16T05:16:00Z';
  let p = f.seal();
  if (scenario === 'review-hash') {
    f.envelope.review.bodySha256 = 'f'.repeat(64);
    p = {
      bytes: Buffer.from(canonicalUiObservationJson(f.envelope)),
      sha: createHash('sha256').update(canonicalUiObservationJson(f.envelope)).digest('hex'),
    };
  }
  expect(() => parseUiObservationProof(p.bytes, p.sha)).toThrow(/LEGACY_GAME_UI_OBSERVATION_/);
});
it.each([
  'https://auth.vivacrm.invalid/openid-connect/auth?client_id=x&state=private-canary',
  'https://x.invalid/#state=private-canary',
  'session_state=private-canary',
  'Bearer private-canary',
  'access_token=private-canary',
])('excludes authentication material before admitting capture: %s', (value) => {
  const f = uiObservationFixture();
  f.envelope.body.captures[0]!.originalToolTextExcerpt = value;
  f.envelope.body.captures[0]!.excerptSha256 = createHash('sha256').update(value).digest('hex');
  const p = f.seal();
  expect(() => parseUiObservationProof(p.bytes, p.sha)).toThrow('PRIVATE_CAPTURE');
});
it.each([
  'game',
  'operation',
  'tenant',
  'provider-tenant',
  'source-version',
  'raw-status',
  'snapshot',
  'mapping',
  'beneficiary',
  'exercise',
])('rejects mismatched source/binding %s', (scenario) => {
  const f = uiObservationFixture();
  const b = f.envelope.body;
  if (scenario === 'game') b.gameId = '99999999-9999-4999-8999-999999999999';
  if (scenario === 'operation') b.operationId = 'other-operation';
  if (scenario === 'tenant') b.tenantKey = 'other-tenant';
  if (scenario === 'provider-tenant') b.providerTenantKey = 'other-provider';
  if (scenario === 'source-version') b.sourceVersion = 'f'.repeat(64);
  if (scenario === 'raw-status') b.sourceObservationSha256 = 'f'.repeat(64);
  if (scenario === 'snapshot') b.sourceSnapshotSha256 = 'f'.repeat(64);
  if (scenario === 'mapping') b.playerMappingsSha256 = 'f'.repeat(64);
  if (scenario === 'beneficiary') b.seats[0]!.userId = '99999999-9999-4999-8999-999999999999';
  if (scenario === 'exercise') b.providerExerciseId = '99999999-9999-4999-8999-999999999999';
  expect(() =>
    verifyUiObservationMembership({
      envelope: f.envelope,
      source: f.source,
      mappings: f.mappings,
      tenantKey: 'local-padel',
      gameId: f.gameId,
      operationId: 'synthetic-ui-operation',
      providerTenantKey: 'synthetic-provider',
    }),
  ).toThrow(/LEGACY_GAME_UI_OBSERVATION_/);
});
it.each(['2099-11-16T04:59:59Z', '2099-11-16T05:00:30Z', '2099-11-16T05:15:01Z'])(
  'rejects future/unreviewed/expired proof at %s',
  (time) => {
    const f = uiObservationFixture();
    expect(() => assertUiObservationFresh(f.envelope, new Date(time))).toThrow('EXPIRED');
  },
);
it('bounds stdin before allocating the complete proof and rejects non-byte streams', async () => {
  await expect(
    readUiObservationStdin(
      (async function* () {
        await Promise.resolve();
        yield new Uint8Array(UI_OBSERVATION_MAX_BYTES);
        yield new Uint8Array(1);
      })(),
    ),
  ).rejects.toThrow('SIZE');
  await expect(
    readUiObservationStdin(
      (async function* () {
        await Promise.resolve();
        yield 'private-canary';
      })(),
    ),
  ).rejects.toThrow('ENCODING');
});
