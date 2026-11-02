import { expect, it } from 'vitest';
import {
  profileSettingsCommand,
  readProfileSettingsBody,
} from '../../web/src/native-profile-settings.js';
import { nativeProfileSettingsRequest } from './native-profile-settings-request.js';
import { config } from './ios/testing/cabinet-fixtures.js';
const privacy = { expectedVersion: 2, contactPolicy: 'NOBODY', chatPolicy: 'AUTHORIZED' } as const;
const preferences = {
  expectedVersion: 2,
  favoriteStationIds: [],
  preferredTimeWindows: [{ weekday: 'MON', startsAt: '09:00', endsAt: '12:00' }],
  useHistory: false,
  recommendFriends: true,
  recommendationDisplay: 'ROWS',
} as const;
it('reconstructs the original canonical key and changes it only for a different version/body', async () => {
  const a = await profileSettingsCommand('privacy', privacy),
    b = await profileSettingsCommand('privacy', {
      chatPolicy: 'AUTHORIZED',
      contactPolicy: 'NOBODY',
      expectedVersion: 2,
    });
  expect(a).toEqual(b);
  expect(a.key).toMatch(/^profile-settings:privacy:[0-9a-f]{64}$/);
  expect(
    (await profileSettingsCommand('privacy', { ...privacy, expectedVersion: 3 })).key,
  ).not.toBe(a.key);
  expect(
    (await profileSettingsCommand('privacy', { ...privacy, contactPolicy: 'AUTHORIZED' })).key,
  ).not.toBe(a.key);
});
it('accepts only the exact authenticated PUT namespace with its resource key', async () => {
  const command = await profileSettingsCommand('privacy', privacy);
  const url = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}/profile/privacy`;
  const init = {
    method: 'PUT',
    body: command.body,
    headers: {
      authorization: 'Bearer synthetic-access',
      'content-type': 'application/json',
      'idempotency-key': command.key,
    },
  };
  expect(nativeProfileSettingsRequest(url, init, config)).toEqual(command);
  for (const suffix of ['?userId=other', '/other', '/'])
    expect(() => nativeProfileSettingsRequest(url + suffix, init, config)).toThrow();
  for (const headers of [
    { ...init.headers, cookie: 'synthetic' },
    { ...init.headers, authorization: '' },
    { ...init.headers, 'idempotency-key': command.key.replace('privacy', 'preferences') },
  ])
    expect(() => nativeProfileSettingsRequest(url, { ...init, headers }, config)).toThrow();
  expect(() => nativeProfileSettingsRequest(url, { ...init, method: 'POST' }, config)).toThrow();
  expect(nativeProfileSettingsRequest(url, { method: 'GET' }, config)).toBeNull();
});
it.each([
  { ...privacy, expectedVersion: true },
  { ...privacy, expectedVersion: -1 },
  { ...privacy, expectedVersion: 0.5 },
  { ...privacy, expectedVersion: 9007199254740992 },
  { ...privacy, chatPolicy: ['AUTHORIZED'] },
  { ...privacy, userId: 'other' },
])('rejects malformed privacy body %j', (value) =>
  expect(() => readProfileSettingsBody('privacy', JSON.stringify(value))).toThrow(),
);
it.each([
  { ...preferences, useHistory: 1 },
  { ...preferences, recommendFriends: 'true' },
  { ...preferences, recommendationDisplay: ['ROWS'] },
  { ...preferences, favoriteStationIds: ['invalid'] },
  {
    ...preferences,
    favoriteStationIds: [
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
    ],
  },
  {
    ...preferences,
    preferredTimeWindows: [{ weekday: 'MON', startsAt: '12:00', endsAt: '09:00' }],
  },
  {
    ...preferences,
    preferredTimeWindows: [{ weekday: 'MON', startsAt: '09:00', endsAt: '12:00', admin: true }],
  },
  {
    ...preferences,
    preferredTimeWindows: [
      preferences.preferredTimeWindows[0],
      preferences.preferredTimeWindows[0],
    ],
  },
])('rejects malformed preferences %j', (value) =>
  expect(() => readProfileSettingsBody('preferences', JSON.stringify(value))).toThrow(),
);
it('rejects duplicate and escaped keys while preserving valid windows', () => {
  expect(() =>
    readProfileSettingsBody(
      'privacy',
      '{"expectedVersion":1,"expectedVersion":2,"contactPolicy":"NOBODY","chatPolicy":"NOBODY"}',
    ),
  ).toThrow();
  expect(() =>
    readProfileSettingsBody(
      'privacy',
      JSON.stringify(privacy).replace('expectedVersion', 'expected\\u0056ersion'),
    ),
  ).toThrow();
  expect(readProfileSettingsBody('preferences', JSON.stringify(preferences))).toEqual(preferences);
});
