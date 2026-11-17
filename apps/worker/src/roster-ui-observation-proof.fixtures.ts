import { createHash } from 'node:crypto';
import type { LegacyGameRosterMembershipSnapshot } from '@phub/legacy-games-adapter';
import {
  localVivaExerciseAssociationId,
  localVivaProfileAssociationId,
} from '@phub/legacy-games-adapter';
import { attestExactRosterPlayerMappings } from '@phub/database';
import {
  canonicalUiObservationJson,
  uiObservationSha256,
  UI_OBSERVATION_POLICY,
  type RosterUiObservationEnvelope,
} from './roster-ui-observation-proof.js';
export function uiObservationFixture() {
  const gameId = '11111111-1111-4111-8111-111111111111',
    exercise = '55555555-5555-4555-8555-555555555555',
    station = '66666666-6666-4666-8666-666666666666';
  const clients = Array.from({ length: 4 }, (_, i) => `33333333-3333-4333-8333-33333333333${i}`);
  const users = Array.from({ length: 4 }, (_, i) => `44444444-4444-4444-8444-44444444444${i}`);
  const source: LegacyGameRosterMembershipSnapshot = {
    externalId: 'private-source-game',
    externalAliases: ['raw-game'],
    externalVersion: 'a'.repeat(64),
    sourceObservationSha256: 'e'.repeat(64),
    providerExerciseId: exercise,
    providerStationId: station,
    providerCourtId: null,
    vivaExerciseExternalId: localVivaExerciseAssociationId(exercise),
    title: 'Synthetic private title',
    kind: 'FRIENDLY',
    visibility: 'PRIVATE',
    cancelled: false,
    startsAt: '2099-11-16T06:00:00Z',
    endsAt: '2099-11-16T07:00:00Z',
    timezone: 'Europe/Moscow',
    station: {
      externalId: 'station',
      externalAliases: [station],
      name: 'Synthetic station',
      courtExternalId: null,
      courtName: null,
    },
    capacity: 4,
    waitlistEnabled: true,
    paymentMode: 'SPLIT',
    levelFrom: null,
    levelTo: null,
    organizerExternalId: localVivaProfileAssociationId(clients[0]!),
    participants: clients.map((id, i) => ({
      externalId: localVivaProfileAssociationId(id),
      externalAliases: [id],
      displayName: `Private test name ${i}`,
      level: null,
      levelValue: null,
      role: i === 0 ? 'ORGANIZER' : 'PLAYER',
      avatarSourceUrl: null,
      sourceStatus: 'CONFIRMED',
    })),
  };
  const mappings = source.participants.flatMap((p, i) =>
    [p.externalId, ...p.externalAliases!].map((id) => ({
      external_id: id,
      internal_id: users[i]!,
      sync_status: 'synced',
      sync_error_code: null,
    })),
  );
  const frames = clients.flatMap((client, i) =>
    [
      { id: `identity-${i}`, role: 'selectedClientUuid', text: `Selected exact client ${client}` },
      {
        id: `booking-${i}`,
        role: 'activeBookingPaid',
        text: 'Active booking 09:00–10:00 Запись Оплачено',
      },
      {
        id: `link-${i}`,
        role: 'sameExerciseCopiedUiLink',
        text: `https://cabinet.vivacrm.ru/schedule?exerciseId=${exercise}&stationId=${station}`,
      },
      {
        id: `usage-${i}`,
        role: 'specificUsageAndAcquisition',
        text: 'Тестовый абонемент; applied usage for this booking; 25 → 24',
      },
    ].map((f) => ({
      id: f.id,
      role: f.role,
      observedAt: '2099-11-16T05:00:00Z',
      toolCallPointer: `synthetic-call-${f.id}`,
      fieldPath: 'allowlisted.original.ax',
      originalToolTextExcerpt: f.text,
      excerptSha256: createHash('sha256').update(f.text).digest('hex'),
    })),
  );
  const body: RosterUiObservationEnvelope['body'] = {
    schema: UI_OBSERVATION_POLICY,
    originAuthenticated: false,
    authorizesProviderWrite: false,
    readerId: 'synthetic-reader',
    providerOrigin: 'https://cabinet.vivacrm.ru',
    providerTenantKey: 'synthetic-provider',
    tenantKey: 'local-padel',
    gameId,
    operationId: 'synthetic-ui-operation',
    sourceVersion: source.externalVersion,
    sourceObservationSha256: source.sourceObservationSha256,
    sourceSnapshotSha256: uiObservationSha256(source),
    playerMappingsSha256: attestExactRosterPlayerMappings(source, mappings).sha256,
    providerExerciseId: exercise,
    providerStationId: station,
    providerCourtId: null,
    startsAt: source.startsAt,
    endsAt: source.endsAt,
    capacity: 4,
    paymentMode: 'SPLIT',
    capturedAt: '2099-11-16T05:00:00Z',
    expiresAt: '2099-11-16T05:15:00Z',
    captureSetSha256: uiObservationSha256(frames),
    captures: frames,
    seats: clients.map((client, i) => ({
      userId: users[i]!,
      sourceAssociationId: source.participants[i]!.externalId,
      providerClientId: client,
      beneficiaryClientId: client,
      activeGuestIdentityCaptureId: `identity-${i}`,
      activeBookingCaptureId: `booking-${i}`,
      exerciseLinkCaptureId: `link-${i}`,
      usageCaptureId: `usage-${i}`,
      captureIds: [`identity-${i}`, `booking-${i}`, `link-${i}`, `usage-${i}`],
      matchingActiveBookings: 1,
      matchingUsageRows: 1,
      familyOrBeneficiaryAmbiguity: false,
      bookingCreatedAt: '2099-11-15T12:00:00Z',
      usageCreatedAt: '2099-11-15T12:01:00Z',
      entitlementLabel: 'Тестовый абонемент',
      acquisition: i < 2 ? 'CASH_PURCHASED_ENTITLEMENT' : 'ADMIN_ISSUED_ZERO_PRICE_ENTITLEMENT',
      remainingBefore: 25,
      remainingAfter: 24,
      bookingPaymentLabel: 'Оплачено',
      settlement: 'SETTLED_BY_SUBSCRIPTION_UI_OBSERVATION',
      active: true,
      cancelled: false,
      usageReversed: false,
      outstandingMinor: 0,
      hiddenProviderIds: 'UNAVAILABLE_NOT_OBSERVED',
    })),
  };
  const envelope: RosterUiObservationEnvelope = {
    body,
    review: {
      schema: 'INDEPENDENT_UI_OBSERVATION_REVIEW_V1',
      reviewerId: 'synthetic-independent-reviewer',
      reviewedAt: '2099-11-16T05:01:00Z',
      toolCallPointer: 'synthetic-independent-review-call',
      bodySha256: uiObservationSha256(body),
      captureSetSha256: body.captureSetSha256,
      fullClientUuidEquality: true,
      fourDistinctActiveBeneficiaries: true,
      exactOccurrenceAndAppliedUsage: true,
      noDuplicateFamilyOrReversalAmbiguity: true,
      noFinancialOrProviderWrite: true,
    },
  };
  const seal = () => {
    body.captureSetSha256 = uiObservationSha256(body.captures);
    envelope.review.captureSetSha256 = body.captureSetSha256;
    envelope.review.bodySha256 = uiObservationSha256(body);
    return {
      bytes: Buffer.from(canonicalUiObservationJson(envelope)),
      sha: uiObservationSha256(envelope),
    };
  };
  return {
    source,
    mappings,
    envelope,
    seal,
    gameId,
    clients,
    users,
    now: new Date('2099-11-16T05:02:00Z'),
  };
}
