import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import type {
  LegacyGameRosterMembershipSnapshot,
  LegacyGameSourceSnapshot,
} from '@phub/legacy-games-adapter';
import type { LegacyGameExactPlayerMapping } from '@phub/database';
import { attestExactRosterPlayerMappings } from '@phub/database';

export const UI_OBSERVATION_POLICY =
  'OPERATOR_REVIEWED_VIVA_UI_SUBSCRIPTION_OBSERVATION_V1' as const;
export const UI_OBSERVATION_MAX_BYTES = 524288;
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const uuid = z.string().regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u);
const instant = z.iso.datetime({ offset: true });
const text = z.string().min(1).max(300);
const frame = z
  .object({
    id: text,
    role: text,
    observedAt: instant,
    toolCallPointer: text,
    fieldPath: text,
    originalToolTextExcerpt: z.string().min(1).max(32768),
    excerptSha256: hash,
  })
  .strict();
const seat = z
  .object({
    userId: uuid,
    sourceAssociationId: hash,
    providerClientId: uuid,
    beneficiaryClientId: uuid,
    activeGuestIdentityCaptureId: text,
    exerciseLinkCaptureId: text,
    activeBookingCaptureId: text,
    usageCaptureId: text,
    captureIds: z.array(text).min(4).max(12),
    matchingActiveBookings: z.literal(1),
    matchingUsageRows: z.literal(1),
    familyOrBeneficiaryAmbiguity: z.literal(false),
    bookingCreatedAt: instant,
    usageCreatedAt: instant,
    entitlementLabel: text,
    acquisition: z.enum(['CASH_PURCHASED_ENTITLEMENT', 'ADMIN_ISSUED_ZERO_PRICE_ENTITLEMENT']),
    remainingBefore: z.number().int().positive(),
    remainingAfter: z.number().int().nonnegative(),
    bookingPaymentLabel: z.literal('Оплачено'),
    settlement: z.literal('SETTLED_BY_SUBSCRIPTION_UI_OBSERVATION'),
    active: z.literal(true),
    cancelled: z.literal(false),
    usageReversed: z.literal(false),
    outstandingMinor: z.literal(0),
    hiddenProviderIds: z.literal('UNAVAILABLE_NOT_OBSERVED'),
  })
  .strict();
const bodySchema = z
  .object({
    schema: z.literal(UI_OBSERVATION_POLICY),
    originAuthenticated: z.literal(false),
    authorizesProviderWrite: z.literal(false),
    readerId: text,
    providerOrigin: z.literal('https://cabinet.vivacrm.ru'),
    providerTenantKey: text,
    tenantKey: text,
    gameId: uuid,
    operationId: text,
    sourceVersion: hash,
    sourceObservationSha256: hash,
    sourceSnapshotSha256: hash,
    playerMappingsSha256: hash,
    providerExerciseId: uuid,
    providerStationId: text,
    providerCourtId: text.nullable(),
    startsAt: instant,
    endsAt: instant,
    capacity: z.literal(4),
    paymentMode: z.enum(['SPLIT', 'ORGANIZER_PAYS']),
    capturedAt: instant,
    expiresAt: instant,
    captureSetSha256: hash,
    captures: z.array(frame).min(4).max(24),
    seats: z.array(seat).length(4),
  })
  .strict();
const reviewSchema = z
  .object({
    schema: z.literal('INDEPENDENT_UI_OBSERVATION_REVIEW_V1'),
    reviewerId: text,
    reviewedAt: instant,
    toolCallPointer: text,
    bodySha256: hash,
    captureSetSha256: hash,
    fullClientUuidEquality: z.literal(true),
    fourDistinctActiveBeneficiaries: z.literal(true),
    exactOccurrenceAndAppliedUsage: z.literal(true),
    noDuplicateFamilyOrReversalAmbiguity: z.literal(true),
    noFinancialOrProviderWrite: z.literal(true),
  })
  .strict();
const envelopeSchema = z.object({ body: bodySchema, review: reviewSchema }).strict();
export type RosterUiObservationEnvelope = z.infer<typeof envelopeSchema>;
export function canonicalUiObservationJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalUiObservationJson).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonicalUiObservationJson(v))
        .join(',') +
      '}'
    );
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('LEGACY_GAME_UI_OBSERVATION_ENCODING');
  return result;
}
export function uiObservationSha256(value: unknown): string {
  return createHash('sha256').update(canonicalUiObservationJson(value)).digest('hex');
}
function requireProof(value: unknown, code: string): asserts value {
  if (!value) throw new Error('LEGACY_GAME_UI_OBSERVATION_' + code);
}
export async function readUiObservationStdin(stream: AsyncIterable<unknown>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    requireProof(chunk instanceof Uint8Array, 'ENCODING');
    size += chunk.byteLength;
    requireProof(size <= UI_OBSERVATION_MAX_BYTES, 'SIZE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function parseUiObservationProof(
  bytes: Uint8Array,
  expectedSha: string,
): { envelope: RosterUiObservationEnvelope; proofSha256: string; reviewSha256: string } {
  requireProof(bytes.byteLength > 0 && bytes.byteLength <= UI_OBSERVATION_MAX_BYTES, 'SIZE');
  let parsed: unknown;
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('LEGACY_GAME_UI_OBSERVATION_ENCODING');
  }
  // Exact canonical bytes reject duplicate keys, ambiguous encodings and unreviewed whitespace.
  requireProof(raw === canonicalUiObservationJson(parsed), 'CANONICAL');
  const result = envelopeSchema.safeParse(parsed);
  requireProof(result.success, 'SCHEMA');
  const envelope = result.data,
    proofSha256 = uiObservationSha256(envelope);
  requireProof(proofSha256 === expectedSha, 'HASH');
  const { body, review } = envelope;
  requireProof(
    review.reviewerId !== body.readerId &&
      review.bodySha256 === uiObservationSha256(body) &&
      review.captureSetSha256 === body.captureSetSha256,
    'REVIEW',
  );
  const earliest = Date.parse(body.capturedAt),
    expires = Date.parse(body.expiresAt);
  requireProof(expires > earliest && expires - earliest <= 900000, 'WINDOW');
  requireProof(new Set(body.captures.map((c) => c.id)).size === body.captures.length, 'CAPTURES');
  for (const c of body.captures) {
    requireProof(
      createHash('sha256').update(c.originalToolTextExcerpt).digest('hex') === c.excerptSha256,
      'CAPTURE_HASH',
    );
    requireProof(
      Date.parse(c.observedAt) >= earliest && Date.parse(c.observedAt) <= expires,
      'CAPTURE_TIME',
    );
    // Only allowlisted UI fields belong here; session/authentication material is never evidence.
    requireProof(
      !/authorization|access_token|refresh_token|id_token|session_state|[?&#](?:code|state|nonce|code_challenge|redirect_uri)=|#state|\/(?:oauth|openid-connect)|bearer\s/iu.test(
        c.originalToolTextExcerpt,
      ),
      'PRIVATE_CAPTURE',
    );
  }
  requireProof(body.captureSetSha256 === uiObservationSha256(body.captures), 'CAPTURE_SET');
  requireProof(
    Date.parse(review.reviewedAt) >=
      Math.max(...body.captures.map((c) => Date.parse(c.observedAt))) &&
      Date.parse(review.reviewedAt) <= expires,
    'REVIEW_TIME',
  );
  requireProof(
    new Set(body.seats.map((s) => s.userId)).size === 4 &&
      new Set(body.seats.map((s) => s.providerClientId)).size === 4 &&
      new Set(body.seats.map((s) => s.sourceAssociationId)).size === 4,
    'SEATS',
  );
  const frames = new Map(body.captures.map((c) => [c.id, c]));
  for (const key of [
    'activeGuestIdentityCaptureId',
    'activeBookingCaptureId',
    'exerciseLinkCaptureId',
    'usageCaptureId',
  ] as const)
    requireProof(new Set(body.seats.map((s) => s[key])).size === 4, 'CAPTURE_REUSE');
  for (const s of body.seats) {
    requireProof(
      s.providerClientId === s.beneficiaryClientId && s.remainingBefore - s.remainingAfter === 1,
      'SETTLEMENT',
    );
    const latestSeatCapture = Math.max(
      ...body.captures
        .filter((c) => s.captureIds.includes(c.id))
        .map((c) => Date.parse(c.observedAt)),
    );
    requireProof(
      Date.parse(s.bookingCreatedAt) <= Date.parse(s.usageCreatedAt) &&
        Date.parse(s.usageCreatedAt) <= latestSeatCapture &&
        Date.parse(s.usageCreatedAt) <= Date.parse(review.reviewedAt),
      'SETTLEMENT_TIME',
    );
    requireProof(
      new Set(s.captureIds).size === s.captureIds.length &&
        s.captureIds.every((id) => frames.has(id)) &&
        s.captureIds.includes(s.activeGuestIdentityCaptureId) &&
        s.captureIds.includes(s.exerciseLinkCaptureId) &&
        s.captureIds.includes(s.activeBookingCaptureId) &&
        s.captureIds.includes(s.usageCaptureId),
      'CAPTURE_JOIN',
    );
    requireProof(
      frames
        .get(s.activeGuestIdentityCaptureId)
        ?.originalToolTextExcerpt.includes(s.providerClientId),
      'CLIENT_CAPTURE',
    );
    requireProof(
      frames.get(s.activeBookingCaptureId)?.originalToolTextExcerpt.includes(s.bookingPaymentLabel),
      'BOOKING_CAPTURE',
    );
    requireProof(
      frames
        .get(s.usageCaptureId)
        ?.originalToolTextExcerpt.replace(/\s+/gu, ' ')
        .includes(s.entitlementLabel.replace(/\s+/gu, ' ')),
      'USAGE_CAPTURE',
    );
    const link = frames.get(s.exerciseLinkCaptureId)?.originalToolTextExcerpt;
    requireProof(
      link?.includes(body.providerOrigin) &&
        link.includes(body.providerExerciseId) &&
        link.includes(body.providerStationId),
      'EXERCISE_CAPTURE',
    );
  }
  return { envelope, proofSha256, reviewSha256: uiObservationSha256(review) };
}
export function assertUiObservationFresh(envelope: RosterUiObservationEnvelope, now: Date): void {
  const { body, review } = envelope,
    t = now.getTime();
  requireProof(
    t >= Date.parse(body.capturedAt) &&
      t >= Date.parse(review.reviewedAt) &&
      t <= Date.parse(body.expiresAt),
    'EXPIRED',
  );
}
export function verifyUiObservationMembership(input: {
  envelope: RosterUiObservationEnvelope;
  source: LegacyGameRosterMembershipSnapshot;
  mappings: readonly LegacyGameExactPlayerMapping[];
  tenantKey: string;
  gameId: string;
  operationId: string;
  providerTenantKey: string;
}): {
  snapshot: LegacyGameSourceSnapshot;
  observationSetSha256: string;
} {
  const { body } = input.envelope,
    s = input.source,
    identity = attestExactRosterPlayerMappings(s, input.mappings);
  requireProof(
    body.tenantKey === input.tenantKey &&
      body.gameId === input.gameId &&
      body.operationId === input.operationId &&
      body.providerTenantKey === input.providerTenantKey,
    'TARGET',
  );
  requireProof(
    body.sourceVersion === s.externalVersion &&
      body.sourceObservationSha256 === s.sourceObservationSha256 &&
      body.sourceSnapshotSha256 === uiObservationSha256(s) &&
      body.playerMappingsSha256 === identity.sha256,
    'SOURCE',
  );
  requireProof(
    body.providerExerciseId === s.providerExerciseId &&
      body.providerStationId === s.providerStationId &&
      body.providerCourtId === s.providerCourtId &&
      Date.parse(body.startsAt) === Date.parse(s.startsAt) &&
      Date.parse(body.endsAt) === Date.parse(s.endsAt) &&
      body.capacity === s.capacity &&
      body.paymentMode === s.paymentMode,
    'OCCURRENCE',
  );
  const bySource = new Map(body.seats.map((p) => [p.sourceAssociationId, p]));
  requireProof(s.participants.length === 4 && bySource.size === 4, 'SEATS');
  for (const p of s.participants) {
    const seat = bySource.get(p.externalId);
    requireProof(
      seat &&
        seat.userId === identity.users.get(p.externalId) &&
        p.externalAliases?.includes(seat.providerClientId) &&
        createHash('sha256')
          .update('phub-local-public-clone-v1:player:' + seat.providerClientId)
          .digest('hex') === p.externalId,
      'IDENTITY',
    );
  }
  const {
    sourceObservationSha256: observation,
    providerExerciseId: exercise,
    providerStationId: station,
    providerCourtId: court,
    participants,
    ...base
  } = s;
  requireProof(observation && exercise && station && court !== undefined, 'SOURCE');
  const snapshot: LegacyGameSourceSnapshot = {
    ...base,
    participants: participants.map((p) => ({
      externalId: p.externalId,
      ...(p.externalAliases ? { externalAliases: p.externalAliases } : {}),
      displayName: p.displayName,
      level: p.level,
      levelValue: p.levelValue,
      role: p.role,
      avatarSourceUrl: p.avatarSourceUrl,
      paymentState: 'PAID',
    })),
  };
  const keys = body.seats
    .map((p) =>
      uiObservationSha256({
        policy: UI_OBSERVATION_POLICY,
        providerTenantKey: body.providerTenantKey,
        providerClientId: p.providerClientId,
        exercise: body.providerExerciseId,
        station: body.providerStationId,
        court: body.providerCourtId,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        bookingCreatedAt: p.bookingCreatedAt,
        usageCreatedAt: p.usageCreatedAt,
        entitlementLabel: p.entitlementLabel,
        remainingBefore: p.remainingBefore,
        remainingAfter: p.remainingAfter,
        acquisition: p.acquisition,
        active: p.active,
        cancelled: p.cancelled,
        usageReversed: p.usageReversed,
      }),
    )
    .sort();
  requireProof(new Set(keys).size === 4, 'OBSERVATIONS');
  return { snapshot, observationSetSha256: uiObservationSha256(keys) };
}
