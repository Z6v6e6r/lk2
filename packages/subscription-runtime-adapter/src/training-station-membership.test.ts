import { expect, it } from 'vitest';
import { trainingAuthorityFixture } from './training-registration.test-fixture.js';
import {
  parseTrainingStationMarker,
  verifyTrainingStationMarker,
  trainingStationActor,
  trainingStationRequest,
} from './training-station-membership.js';
import { parseStationMarker, stationAdmissionId } from './station-membership.js';
import { trainingHash } from '@phub/domain/training-registration';
async function fixture() {
  const authority = await trainingAuthorityFixture(),
    actor = trainingStationActor(authority),
    request = trainingStationRequest(authority);
  return {
    authority,
    marker: {
      version: 1 as const,
      outcome: 'OWNER_ADMISSION' as const,
      actor,
      request,
      authoritySha256: await trainingHash(JSON.stringify(authority)),
      response: {
        contractVersion: 1 as const,
        operationId: request.operationId,
        replayed: false,
        admission: {
          outcome: 'ADMITTED' as const,
          admissionId: stationAdmissionId(actor.tenantId, request.operationId),
          communityId: 'synthetic',
          membershipEpoch: 0,
          reason: 'ELIGIBLE',
          bindingSha256: 'sha256:' + 'a'.repeat(64),
        },
      },
    },
  };
}
it('private training marker is bound to original authority, station, actor and operation', async () => {
  const { authority, marker } = await fixture();
  expect(await parseTrainingStationMarker(marker)).toEqual(marker);
  await expect(verifyTrainingStationMarker(marker, authority)).resolves.toBeUndefined();
  for (const forged of [
    { ...marker, authoritySha256: 'sha256:' + 'b'.repeat(64) },
    { ...marker, request: { ...marker.request, stationId: 'other-studio' } },
    { ...marker, actor: { ...marker.actor, playerId: 'other-player' } },
  ])
    await expect(verifyTrainingStationMarker(forged, authority)).rejects.toThrow();
});
it('TRAINING cannot be parsed as a GAME snapshot marker or carry client extras', async () => {
  const { marker } = await fixture();
  expect(() => parseStationMarker(marker)).toThrow();
  await expect(parseTrainingStationMarker({ ...marker, userToken: 'synthetic' })).rejects.toThrow();
  await expect(
    parseTrainingStationMarker({
      ...marker,
      request: { ...marker.request, activity: { ...marker.request.activity, kind: 'GAME' } },
    }),
  ).rejects.toThrow();
});
it('pinned authority mutation and unknown marker states fail closed', async () => {
  const { authority } = await fixture();
  await expect(
    parseTrainingStationMarker({ version: 1, outcome: 'INTENT', authority }),
  ).resolves.toMatchObject({ outcome: 'INTENT' });
  const forged = structuredClone(authority);
  forged.request.preparation.target.providerStudioId = 'other-studio';
  await expect(
    parseTrainingStationMarker({ version: 1, outcome: 'INTENT', authority: forged }),
  ).rejects.toThrow();
  await expect(parseTrainingStationMarker({ version: 1, outcome: 'UNKNOWN' })).rejects.toThrow();
});

it('JSONB key-order roundtrip normalizes pinned authority before order-sensitive authority hashing', async () => {
  const { authority } = await fixture();
  const reorder = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(reorder)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => b.localeCompare(a))
              .map(([key, item]) => [key, reorder(item)]),
          )
        : value;
  const raw = { version: 1, outcome: 'INTENT', authority: reorder(authority) };
  const parsed = await parseTrainingStationMarker(raw);
  if (parsed.outcome !== 'INTENT') throw new Error('fixture');
  expect(JSON.stringify(parsed.authority)).toBe(JSON.stringify(authority));
  expect(await trainingHash(JSON.stringify(parsed.authority))).toBe(
    await trainingHash(JSON.stringify(authority)),
  );
  expect(JSON.stringify(raw.authority)).not.toBe(JSON.stringify(authority));
});
