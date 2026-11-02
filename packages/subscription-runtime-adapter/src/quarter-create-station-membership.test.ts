import { expect, it } from 'vitest';
import { quarterFixture } from './quarter-create.test-fixture.js';
import { quarterStationFixture } from './quarter-create-station.test-fixture.js';
import {
  parseQuarterStationMarker,
  quarterStationConfirmed,
  quarterStationGeneration,
  quarterStationIntent,
  quarterStationRequest,
} from './quarter-create-station-membership.js';
import { parseStationRequest } from './station-membership.js';
it('explicit CREATE kind, exact immutable capsule and receipt reload; private proof is not JOIN', async () => {
  const f = await quarterFixture(),
    m = await quarterStationFixture(f.admission),
    c = await quarterStationConfirmed(m, f.receipt);
  expect(m.request.activity.kind).toBe('GAME_CREATE');
  expect(await parseQuarterStationMarker(c, f.receipt)).toEqual(c);
  expect(
    parseStationRequest(
      {
        contractVersion: 1,
        operationId: c.request.operationId,
        admissionId: c.response.admission.admissionId,
        admissionBindingSha256: c.response.admission.bindingSha256,
        confirmation: {
          kind: 'GAME_CREATE_ORGANIZER',
          generationId: c.generationId,
          activityId: f.request.target.draftId,
        },
      },
      'confirmation',
    ),
  ).toBeDefined();
  for (const bad of [
    { ...m, admissionSha256: 'sha256:' + 'a'.repeat(64) },
    { ...m, request: { ...m.request, activity: { ...m.request.activity, kind: 'GAME' } } },
    { ...m, actor: { ...m.actor, playerId: 'foreign' } },
    { ...c, generationId: f.request.target.draftId },
    { ...c, receiptSha256: 'sha256:' + 'b'.repeat(64) },
  ])
    await expect(parseQuarterStationMarker(bad, f.receipt)).rejects.toThrow();
  await expect(
    parseQuarterStationMarker(c, { ...f.receipt, providerBookingId: 'other' }),
  ).rejects.toThrow();
});
it('same original booking keeps generation across operation/key/capsule changes; another booking differs', async () => {
  const a = await quarterFixture(),
    b = await quarterFixture({ key: 'synthetic-quarter-second-key' });
  const r = {
    ...b.receipt,
    providerExerciseId: a.receipt.providerExerciseId,
    providerBookingId: a.receipt.providerBookingId,
  };
  expect(await quarterStationGeneration(a.admission, a.receipt)).toBe(
    await quarterStationGeneration(b.admission, r),
  );
  expect(await quarterStationGeneration(b.admission, b.receipt)).not.toBe(
    await quarterStationGeneration(a.admission, a.receipt),
  );
});
it('only finite exact receiver outcomes settle; disabled, malformed, array reason cannot downgrade', async () => {
  const f = await quarterFixture(),
    m = await quarterStationFixture(f.admission, true);
  expect((await parseQuarterStationMarker(m)).outcome).toBe('OWNER_ADMISSION');
  for (const reason of ['DISABLED', 'OWNER_UNAVAILABLE', ['MEMBERSHIP_BLOCKED'], null])
    await expect(
      parseQuarterStationMarker({
        ...m,
        response: { ...m.response, admission: { ...m.response.admission, reason } },
      }),
    ).rejects.toThrow();
});

function reversedJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedJsonKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reversedJsonKeys(child)]),
    );
  return value;
}
it('JSONB key-order roundtrip preserves original capsule through INTENT, owner request and confirmed receipt', async () => {
  const f = await quarterFixture(),
    original = await quarterStationFixture(f.admission),
    intent = await quarterStationIntent(f.admission),
    persistedIntent = reversedJsonKeys(intent),
    originalStoredBytes = JSON.stringify(persistedIntent);
  const loaded = await parseQuarterStationMarker(persistedIntent);
  if (loaded.outcome !== 'INTENT') throw new Error('expected original intent');
  const request = await quarterStationRequest(loaded.admission);
  expect(request).toEqual(original.request);
  expect(JSON.stringify(loaded.admission)).toBe(JSON.stringify(f.admission));
  expect(loaded.admissionSha256).toBe(intent.admissionSha256);
  expect(JSON.stringify(persistedIntent)).toBe(originalStoredBytes);
  const owner = await parseQuarterStationMarker(
    reversedJsonKeys({
      ...loaded,
      outcome: 'OWNER_ADMISSION',
      actor: original.actor,
      request,
      response: original.response,
    }),
  );
  if (owner.outcome !== 'OWNER_ADMISSION') throw new Error('expected original owner admission');
  const confirmed = await quarterStationConfirmed(owner, f.receipt),
    expected = await quarterStationConfirmed(original, f.receipt),
    reloaded = await parseQuarterStationMarker(
      reversedJsonKeys(confirmed),
      reversedJsonKeys(f.receipt),
    );
  expect(confirmed).toEqual(expected);
  expect(reloaded).toEqual(expected);
  if (reloaded.outcome !== 'CONFIRMED_FACT') throw new Error('expected original confirmed fact');
  expect(await quarterStationRequest(reloaded.admission)).toEqual(original.request);
  expect(await quarterStationGeneration(reloaded.admission, f.receipt)).toBe(expected.generationId);
  expect(reloaded.receiptSha256).toBe(expected.receiptSha256);
  expect(reloaded.admissionSha256).toBe(intent.admissionSha256);
});
