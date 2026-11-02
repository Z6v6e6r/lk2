import type {
  BookingPreferences,
  BookingPreferencesUpdateRequest,
  ProfilePrivacySettings,
  ProfilePrivacyUpdateRequest,
} from '@phub/api-sdk';
export type ProfileSettingsResource = 'privacy' | 'preferences';
export interface ProfileSettingsInputs {
  privacy: ProfilePrivacyUpdateRequest;
  preferences: BookingPreferencesUpdateRequest;
}
export interface ProfileSettingsResults {
  privacy: ProfilePrivacySettings;
  preferences: BookingPreferences;
}
export interface NativeProfileSettingsRequest {
  resource: ProfileSettingsResource;
  body: string;
  key: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).sort().join(',') === keys.sort().join(',');
export function readProfileSettingsBody(
  resource: ProfileSettingsResource,
  body: string,
): ProfileSettingsInputs[ProfileSettingsResource] {
  const fail = () => {
    throw new Error('NATIVE_REQUEST_REJECTED');
  };
  if (body.length > 8192 || body.includes('\\')) fail();
  const v: unknown = JSON.parse(body);
  if (!record(v) || !Number.isSafeInteger(v.expectedVersion) || Number(v.expectedVersion) < 0)
    return fail();
  const keys =
    resource === 'privacy'
      ? ['expectedVersion', 'contactPolicy', 'chatPolicy']
      : [
          'expectedVersion',
          'favoriteStationIds',
          'preferredTimeWindows',
          'useHistory',
          'recommendFriends',
          'recommendationDisplay',
        ];
  if (!exact(v, keys)) fail();
  for (const key of keys)
    if ((body.match(new RegExp('"' + key + '"\\s*:', 'g')) ?? []).length !== 1) fail();
  if (resource === 'privacy') {
    if (
      typeof v.contactPolicy !== 'string' ||
      !['AUTHORIZED', 'NOBODY'].includes(v.contactPolicy) ||
      typeof v.chatPolicy !== 'string' ||
      !['AUTHORIZED', 'NOBODY'].includes(v.chatPolicy)
    )
      fail();
  } else if (resource === 'preferences') {
    if (
      !Array.isArray(v.favoriteStationIds) ||
      v.favoriteStationIds.length > 3 ||
      v.favoriteStationIds.some((id) => typeof id !== 'string' || !uuid.test(id)) ||
      new Set(v.favoriteStationIds).size !== v.favoriteStationIds.length
    )
      fail();
    if (
      typeof v.useHistory !== 'boolean' ||
      typeof v.recommendFriends !== 'boolean' ||
      typeof v.recommendationDisplay !== 'string' ||
      !['CARDS', 'ROWS'].includes(v.recommendationDisplay)
    )
      fail();
    if (!Array.isArray(v.preferredTimeWindows) || v.preferredTimeWindows.length > 14) return fail();
    const seen = new Set<string>();
    for (const w of v.preferredTimeWindows) {
      if (
        !record(w) ||
        !exact(w, ['weekday', 'startsAt', 'endsAt']) ||
        typeof w.weekday !== 'string' ||
        !['ANY', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].includes(w.weekday) ||
        typeof w.startsAt !== 'string' ||
        typeof w.endsAt !== 'string' ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.startsAt) ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.endsAt) ||
        w.startsAt >= w.endsAt
      )
        return fail();
      const identity = JSON.stringify([w.weekday, w.startsAt, w.endsAt]);
      if (seen.has(identity)) fail();
      seen.add(identity);
    }
    for (const key of ['weekday', 'startsAt', 'endsAt'])
      if (
        (body.match(new RegExp('"' + key + '"\\s*:', 'g')) ?? []).length !==
        v.preferredTimeWindows.length
      )
        fail();
  } else fail();
  return v as unknown as ProfileSettingsInputs[ProfileSettingsResource];
}
export function profileSettingsPath(resource: ProfileSettingsResource): string {
  if (resource !== 'privacy' && resource !== 'preferences')
    throw new Error('NATIVE_REQUEST_REJECTED');
  return '/profile/' + (resource === 'privacy' ? 'privacy' : 'booking-preferences');
}
/** Same account-scoped version/body always reconstructs the same explicit retry key; no token storage. */
export async function profileSettingsCommand<R extends ProfileSettingsResource>(
  resource: R,
  input: ProfileSettingsInputs[R],
): Promise<NativeProfileSettingsRequest> {
  const parsed = readProfileSettingsBody(resource, JSON.stringify(input));
  const body =
    resource === 'privacy'
      ? JSON.stringify({
          expectedVersion: parsed.expectedVersion,
          contactPolicy: (parsed as ProfilePrivacyUpdateRequest).contactPolicy,
          chatPolicy: (parsed as ProfilePrivacyUpdateRequest).chatPolicy,
        })
      : JSON.stringify({
          expectedVersion: parsed.expectedVersion,
          favoriteStationIds: (parsed as BookingPreferencesUpdateRequest).favoriteStationIds,
          preferredTimeWindows: (
            parsed as BookingPreferencesUpdateRequest
          ).preferredTimeWindows.map((w) => ({
            weekday: w.weekday,
            startsAt: w.startsAt,
            endsAt: w.endsAt,
          })),
          useHistory: (parsed as BookingPreferencesUpdateRequest).useHistory,
          recommendFriends: (parsed as BookingPreferencesUpdateRequest).recommendFriends,
          recommendationDisplay: (parsed as BookingPreferencesUpdateRequest).recommendationDisplay,
        });
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(resource + '\n' + body)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  return { resource, body, key: `profile-settings:${resource}:${hash}` };
}
/** Match the existing SDK compatibility defaults; shared by both concrete native consumers. */
export function profileSettingsResult<R extends ProfileSettingsResource>(
  resource: R,
  value: ProfileSettingsResults[R],
): ProfileSettingsResults[R] {
  if (resource === 'privacy') return value;
  const v = value as BookingPreferences;
  return {
    ...v,
    recommendFriends: typeof v.recommendFriends === 'boolean' ? v.recommendFriends : true,
    recommendationDisplay: v.recommendationDisplay === 'ROWS' ? 'ROWS' : 'CARDS',
  } as ProfileSettingsResults[R];
}
export const profileSettingsIdentity = (r: NativeProfileSettingsRequest) =>
  JSON.stringify([r.resource, r.key, r.body]);
