import { describe, expect, it, vi } from 'vitest';
import {
  ApiClientError,
  BookedOperationAdmissionUncertainError,
  PadlHubApiClient,
} from './index.js';
import type { BookedOperationAdmissionRequest } from '@phub/api-contracts';

const request: BookedOperationAdmissionRequest = {
  action: 'JOIN_GAME',
  target: { id: '17000000-0000-4000-8000-000000000001', expectedRevision: 1 },
  paymentIntent: 'USE_SUBSCRIPTION',
};
const key = 'synthetic-same-attempt-key';
function client(fetchImplementation: typeof fetch) {
  return new PadlHubApiClient({
    baseUrl: 'https://api.example.test',
    tenantKey: 'synthetic',
    platform: 'web',
    appVersion: 'admission-recovery-test',
    sessionMode: 'memory',
    initialAccessToken: 'fixture',
    fetchImplementation,
  });
}
describe('admission-only uncertain recovery', () => {
  it.each(['wire-503', 'lost-response', 'lost-response-body'] as const)(
    'retains the immutable original JOIN request/key for %s and never retries automatically',
    async (failure) => {
      const submitted = structuredClone(request);
      const fetchImplementation = vi.fn<typeof fetch>((_url, init) => {
        expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(key);
        expect(init?.body).toBe(JSON.stringify(request));
        expect(init?.method).toBe('POST');
        submitted.target.expectedRevision = 2;
        if (failure === 'lost-response')
          return Promise.reject(new TypeError('Synthetic response loss'));
        return Promise.resolve(
          failure === 'wire-503'
            ? Response.json(
                {
                  code: 'BOOKED_OPERATION_ADMISSION_UNAVAILABLE',
                  message: 'Legacy rejection text',
                  correlationId: 'synthetic-correlation',
                },
                { status: 503 },
              )
            : new Response('{truncated', { status: 202 }),
        );
      });
      const sdk = client(fetchImplementation);
      const error: unknown = await sdk
        .admitBookedOperation(submitted, key)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BookedOperationAdmissionUncertainError);
      expect(error).toMatchObject({
        status: 503,
        code: 'BOOKED_OPERATION_ADMISSION_UNAVAILABLE',
        operationStatus: 'UNKNOWN',
        recoveryAction: 'KEEP_SAME_ATTEMPT',
        canStartNewPurchase: false,
        request,
        idempotencyKey: key,
        message:
          'Статус операции не подтверждён. Сохраните текущую попытку; новую покупку не начинайте.',
      });
      if (!(error instanceof BookedOperationAdmissionUncertainError))
        throw Error('Expected recovery error');
      expect(Object.isFrozen(error.request)).toBe(true);
      expect(Object.isFrozen(error.request.target)).toBe(true);
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
      expect(error.correlationId).toBe(failure === 'wire-503' ? 'synthetic-correlation' : '');
    },
  );
  it.each([400, 401, 403, 409])('keeps definitive HTTP %s errors unchanged', async (status) => {
    const transport = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json(
          {
            code: 'SYNTHETIC_DENY',
            message: 'Операция не принята.',
            correlationId: 'synthetic-correlation',
          },
          { status },
        ),
      ),
    );
    const error: unknown = await client(transport)
      .admitBookedOperation(request, key)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).not.toBeInstanceOf(BookedOperationAdmissionUncertainError);
    expect(error).toMatchObject({
      status,
      code: 'SYNTHETIC_DENY',
      message: 'Операция не принята.',
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
