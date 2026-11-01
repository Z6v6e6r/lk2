import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import fixture from './fixtures/quarter-create-owner-v1.json';
import {
  parseQuarterAdmission,
  parseQuarterOutcome,
  parseQuarterInput,
  qcAdmissionHash,
  qcPrepareHash,
  qcOperationId,
  qcEqual,
} from './quarter-create.js';
const raw = fixture.admission;
function receipt() {
  return {
    schemaVersion: 1,
    operationId: raw.preparation.operationId,
    admissionRequestSha256: '',
    actor: { tenantId: raw.preparation.actor.tenantId, userId: raw.preparation.actor.userId },
    target: raw.target,
    providerExerciseId: 'synthetic-original-exercise',
    providerBookingId: 'synthetic-original-booking',
    entitlement: {
      subscriptionInstanceId: 'instance:synthetic-create',
      policyVersion: 3,
      policyDigest: 'sha256:' + 'a'.repeat(64),
      usageOperationId: 'usage-original',
      reservedUnits: 1,
    },
    confirmedAt: '2035-04-01T09:00:00.000Z',
  };
}
afterEach(() => vi.useRealTimers());
describe('frozen quarter owner wire', () => {
  it('uses exact paired LK/CUP fixture bytes and canonical preparation/admission', async () => {
    expect(
      createHash('sha256')
        .update(readFileSync(new URL('./fixtures/quarter-create-owner-v1.json', import.meta.url)))
        .digest('hex'),
    ).toBe('7d69645b0ce2aea081e723462b97d201560df19e4e2c2a120cd0801e49cb14b0');
    const q = await parseQuarterAdmission(raw);
    expect(q).toEqual(raw);
    expect(
      await qcPrepareHash({
        contractVersion: 1,
        action: 'CREATE_GAME',
        subscriptionId: q.subscriptionId,
        target: q.target,
      }),
    ).toBe(q.preparation.requestSha256);
    expect(
      await qcOperationId(
        q.preparation.actor.tenantId,
        q.preparation.actor.userId,
        q.preparation.idempotencyKeySha256,
      ),
    ).toBe(q.preparation.operationId);
  });
  it.each(['target', 'price', 'actor', 'extra', 'digest'])(
    'rejects changed %s before dispatch',
    async (mode) => {
      const q = structuredClone(raw);
      if (mode === 'target') q.target.durationMinutes = 90;
      if (mode === 'price') q.preparation.pricing.quarterPriceMinor = 600000;
      if (mode === 'actor') q.preparation.actor.userId = q.target.draftId;
      if (mode === 'extra') Object.assign(q.preparation, { token: 'not-a-real-token' });
      if (mode === 'digest') q.preparation.sha256 = 'sha256:' + 'a'.repeat(64);
      await expect(parseQuarterAdmission(q)).rejects.toThrow();
    },
  );
  it('accepts historic receipt with independent fresh observation and JSONB key order', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2035-04-01T09:00:30Z'));
    const q = await parseQuarterAdmission(raw),
      r = receipt();
    r.admissionRequestSha256 = await qcAdmissionHash(q);
    const outcome = await parseQuarterOutcome(
      {
        contractVersion: 1,
        operationId: r.operationId,
        operation: { status: 'CONFIRMED', receipt: r },
        registration: { status: 'UNKNOWN', asOf: '2035-04-01T09:00:20.000Z' },
      },
      q,
    );
    expect(outcome.status).toBe('CONFIRMED');
    expect(outcome.registration.status).toBe('UNKNOWN');
    expect(qcEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });
  it.each(['foreign', 'units', 'time', 'field', 'registration'])(
    'rejects receipt %s',
    async (mode) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2035-04-01T09:00:30Z'));
      const q = await parseQuarterAdmission(raw),
        r = receipt();
      r.admissionRequestSha256 = await qcAdmissionHash(q);
      if (mode === 'foreign') r.actor.userId = q.target.draftId;
      if (mode === 'units') r.entitlement.reservedUnits = 4;
      if (mode === 'time') r.confirmedAt = '2036-01-01T00:00:00.000Z';
      if (mode === 'field') Object.assign(r, { providerToken: 'forbidden' });
      await expect(
        parseQuarterOutcome(
          {
            contractVersion: 1,
            operationId: r.operationId,
            operation: { status: 'CONFIRMED', receipt: r },
            registration: {
              status: 'CONFIRMED',
              asOf: mode === 'registration' ? null : '2035-04-01T09:00:20.000Z',
            },
          },
          q,
        ),
      ).rejects.toThrow();
    },
  );
  it('refuses public provider IDs and unsupported options', () => {
    expect(() =>
      parseQuarterInput({
        stationId: raw.target.stationId,
        courtId: raw.target.courtId,
        startsAt: raw.target.startsAt,
        subscriptionId: raw.subscriptionId,
        visibility: 'PRIVATE',
      }),
    ).toThrow();
  });
});

it.each(['operation-array', 'registration-array', 'rejection-string', 'rejection-array'])(
  'rejects non-scalar wire values: %s',
  async (mode) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2035-04-01T09:00:30Z'));
    const q = await parseQuarterAdmission(raw),
      r = receipt();
    r.admissionRequestSha256 = await qcAdmissionHash(q);
    const rejected = {
      schemaVersion: 1,
      outcome: 'REJECTED',
      operationId: r.operationId,
      admissionRequestSha256: r.admissionRequestSha256,
      actor: r.actor,
      target: r.target,
      reason: 'PROVIDER_REJECTED',
      providerStatusCode: mode === 'rejection-array' ? [422] : '422',
      providerRejectedAt: r.confirmedAt,
      rejectedAt: r.confirmedAt,
      entitlement: {
        subscriptionInstanceId: 'instance:synthetic-create',
        usageOperationId: 'usage-original',
        operationState: 'FAILED',
        compensationState: 'APPLIED',
        releaseReason: 'PROVIDER_REJECTED',
        providerBookingId: null,
      },
    };
    await expect(
      parseQuarterOutcome(
        {
          contractVersion: 1,
          operationId: r.operationId,
          operation: {
            status:
              mode === 'operation-array'
                ? ['CONFIRMED']
                : mode.startsWith('rejection')
                  ? 'REJECTED'
                  : 'CONFIRMED',
            receipt: mode.startsWith('rejection') ? rejected : r,
          },
          registration: {
            status: mode === 'registration-array' ? ['UNKNOWN'] : 'UNKNOWN',
            asOf: null,
          },
        },
        q,
      ),
    ).rejects.toThrow();
  },
);
