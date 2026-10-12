import { ApiClientError } from '@phub/api-sdk';
import { expect, it } from 'vitest';
import { sanitizedNativeSessionError, sessionFailureDetails } from './session-failure.js';

it.each([
  'NATIVE_STORAGE_UNAVAILABLE',
  'NATIVE_CACHE_UNAVAILABLE',
  'NATIVE_TLS_REJECTED',
  'NATIVE_RESPONSE_REJECTED',
  'NATIVE_BOOKINGS_PLAN_REJECTED',
  'NATIVE_BOOKINGS_JOB_REJECTED',
  'NATIVE_BOOKINGS_JOB_TRANSPORT_REJECTED',
  'NATIVE_BOOKINGS_JOB_MEDIA_REJECTED',
  'NATIVE_BOOKINGS_JOB_JSON_REJECTED',
  'NATIVE_BOOKINGS_JOB_CONTRACT_REJECTED',
  'NATIVE_BOOKINGS_JOB_COMMAND_REJECTED',
  'NATIVE_BOOKINGS_JOB_ID_REJECTED',
  'NATIVE_BOOKINGS_JOB_EXPIRY_REJECTED',
  'NATIVE_BOOKINGS_JOB_DATE_REJECTED',
  'NATIVE_BOOKINGS_JOB_EXPIRED_REJECTED',
  'NATIVE_BOOKINGS_JOB_LIFETIME_REJECTED',
  'NATIVE_BOOKINGS_DELEGATION_REJECTED',
  'NATIVE_BOOKINGS_DELEGATION_TRANSPORT_REJECTED',
  'NATIVE_BOOKINGS_DELEGATION_MEDIA_REJECTED',
  'NATIVE_BOOKINGS_DELEGATION_JSON_REJECTED',
  'NATIVE_BOOKINGS_DELEGATION_CONTRACT_REJECTED',
  'NATIVE_BOOKINGS_DELEGATION_TOKEN_REJECTED',
  'NATIVE_BOOKINGS_DELEGATION_EXPIRY_REJECTED',
  'NATIVE_BOOKINGS_DELEGATION_DATE_REJECTED',
  'NATIVE_BOOKINGS_DELEGATION_EXPIRED_REJECTED',
  'NATIVE_BOOKINGS_DELEGATION_TIMING_REJECTED',
  'NATIVE_BOOKINGS_LIST_REJECTED',
  'NATIVE_BOOKINGS_DETAILS_REJECTED',
  'NATIVE_BOOKINGS_RESULT_REJECTED',
  'NATIVE_BOOKINGS_COMPLETION_REJECTED',
  'NATIVE_REDIRECT_REJECTED',
  'NATIVE_REQUEST_REJECTED',
  'NATIVE_OAUTH_PENDING',
])('retains only the reviewed native diagnostic %s', (code) => {
  const safe = sanitizedNativeSessionError({
    code,
    message: 'private-native-detail',
    cause: 'private',
  });
  expect(safe).toBeInstanceOf(ApiClientError);
  expect(safe).toMatchObject({ status: 503, code: 'NATIVE_SESSION_UNAVAILABLE' });
  expect(sessionFailureDetails(safe).code).toBe(code);
  expect(JSON.stringify(safe)).not.toContain('private');
  expect(safe.cause).toBeUndefined();
});

it('keeps network failures retryable without retaining the native error', () => {
  const safe = sanitizedNativeSessionError({
    code: 'NATIVE_NETWORK_UNAVAILABLE',
    message: 'private',
  });
  expect(safe).toBeInstanceOf(TypeError);
  expect(sessionFailureDetails(safe).code).toBe('NATIVE_NETWORK_UNAVAILABLE');
  expect(safe.message).not.toContain('private');
  expect(safe.cause).toBeUndefined();
});

it.each([undefined, { code: 'unreviewed-private-code', message: 'private' }, new Error('private')])(
  'redacts unknown native failures',
  (error) => {
    const safe = sanitizedNativeSessionError(error);
    expect(sessionFailureDetails(safe).code).toBe('NATIVE_SESSION_UNAVAILABLE');
    expect(JSON.stringify(safe)).not.toContain('private');
  },
);

it('does not widen the reviewed job-diagnostic family for an unknown suffix', () => {
  const safe = sanitizedNativeSessionError({
    code: 'NATIVE_BOOKINGS_JOB_NEW_PRIVATE_REASON_REJECTED',
    message: 'private-job-payload',
  });
  expect(sessionFailureDetails(safe).code).toBe('NATIVE_SESSION_UNAVAILABLE');
  expect(JSON.stringify(safe)).not.toContain('private-job-payload');
});

it('redacts an unknown delegation suffix and ignores untrusted response metadata', () => {
  const safe = sanitizedNativeSessionError({
    code: 'NATIVE_BOOKINGS_DELEGATION_NEW_PRIVATE_REASON_REJECTED',
    message: 'private-token',
    accessToken: 'private-token',
    expiresAt: 'private-expiry',
    cause: 'private-provider-response',
  });
  expect(sessionFailureDetails(safe).code).toBe('NATIVE_SESSION_UNAVAILABLE');
  expect(JSON.stringify(safe)).not.toContain('private');
  expect(safe.cause).toBeUndefined();
});

it('displays only the HTTP status for server errors and a fixed code for other failures', () => {
  expect(sessionFailureDetails(new ApiClientError('private', 503, 'private', 'private')).code).toBe(
    'HTTP_503',
  );
  expect(sessionFailureDetails(new Error('private')).code).toBe('SESSION_CHECK_FAILED');
  expect(sessionFailureDetails({ diagnosticCode: 'private' }).code).toBe('SESSION_CHECK_FAILED');
});
