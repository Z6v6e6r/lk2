import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNativeApiFetch,
  type AndroidSessionPlugin,
  type NativeReadObservation,
} from './native-api-fetch.js';
import { safeReadHeaders, safeReadShape } from './native-read-observation.js';

const privateValue = 'PRIVATE_SENTINEL_phone_mail_token_signed_url';
const config = {
  apiBaseUrl: 'https://lk2.padlhub.su',
  tenantKey: 'local-padel',
  appVersion: 'test',
};
const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}/`;
const cid = '00000000-0000-4000-8000-000000000001';
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
const response = (status: number, value: unknown, headers: Record<string, string> = {}) => ({
  status,
  source: 'network' as const,
  body: encode(value),
  headers: { 'content-type': 'application/json', ...headers },
});
function fixture() {
  const plugin = {
    configuration: vi.fn(),
    request: vi.fn<AndroidSessionPlugin['request']>(),
    refreshUpcomingBookings: vi
      .fn<NonNullable<AndroidSessionPlugin['refreshUpcomingBookings']>>()
      .mockResolvedValue({ state: 'refreshed' }),
    cancelUpcomingBookingsRefresh: vi.fn().mockResolvedValue({ state: 'cancelled' }),
  };
  const observe = vi.fn<(observation: NativeReadObservation) => void>();
  return {
    plugin,
    observe,
    fetch: createNativeApiFetch(config, plugin, undefined, undefined, observe),
  };
}
afterEach(() => vi.useRealTimers());

describe('bounded ordinary read observations', () => {
  it('records both outcomes without retaining body values, unknown keys, or credentials', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T21:00:00Z'));
    const { plugin, observe, fetch } = fixture();
    plugin.request
      .mockResolvedValueOnce(
        response(
          200,
          {
            userId: privateValue,
            displayName: privateValue,
            [privateValue]: privateValue,
            avatarUrl: `https://example.invalid/?token=${privateValue}`,
          },
          {
            'cache-control': 'private, max-age=15, stale-while-revalidate=45',
            'retry-after': '15',
            'set-cookie': privateValue,
            authorization: privateValue,
          },
        ),
      )
      .mockResolvedValueOnce(
        response(
          403,
          { code: 'TENANT_ACCESS_DENIED', message: privateValue },
          { 'cache-control': 'private, no-store' },
        ),
      );
    const first = await fetch(root + 'profile', { headers: { 'x-correlation-id': cid } });
    const firstPayload: unknown = await first.json();
    expect(firstPayload).toMatchObject({ displayName: privateValue });
    await fetch(root + 'bookings/upcoming', { headers: { 'x-correlation-id': cid } });
    const completed = observe.mock.calls.map(([entry]) => entry).filter((entry) => entry.complete);
    expect(completed.map((entry) => [entry.section, entry.path, entry.trace?.[0]?.status])).toEqual(
      [
        ['profile', '/profile', 200],
        ['bookings', '/bookings/upcoming', 403],
      ],
    );
    expect(completed[0]?.trace?.[0]).toMatchObject({
      observedAt: '2026-10-12T21:00:00.000Z',
      source: 'network',
      shape: 'object',
      fields: ['avatarUrl', 'displayName', 'userId'],
      headers: {
        contentType: 'application/json',
        cacheControl: 'private, max-age=15, stale-while-revalidate=45',
        retryAfter: '15 seconds',
      },
      correlationId: cid,
    });
    expect(completed[1]?.trace?.[0]?.code).toBe('TENANT_ACCESS_DENIED');
    expect(JSON.stringify(observe.mock.calls)).not.toContain(privateValue);
    expect(plugin.request).toHaveBeenCalledTimes(2);
    expect(plugin.refreshUpcomingBookings).not.toHaveBeenCalled();
  });

  it.each([undefined, ['JOB_ACCEPTED', 'RELAY_ACCEPTED', 'COMPLETED'] as const])(
    'separates initial GET, closed ACK and failed final GET (%s)',
    async (milestones) => {
      const { plugin, observe, fetch } = fixture();
      plugin.request
        .mockResolvedValueOnce(response(503, { code: 'BOOKINGS_PROJECTION_STALE' }))
        .mockResolvedValueOnce(response(503, { code: 'BOOKINGS_PROJECTION_INVALID' }));
      plugin.refreshUpcomingBookings.mockResolvedValue({
        state: 'refreshed',
        ...(milestones ? { milestones } : {}),
      });
      const result = await fetch(root + 'bookings/upcoming');
      expect(result.status).toBe(503);
      const initial = observe.mock.calls[0]![0];
      expect(initial.complete).toBe(false);
      expect(initial.trace?.map((event) => event.stage)).toEqual(['initial-get']);
      const final = observe.mock.lastCall![0];
      expect(final.failure?.code).toBe('BOOKINGS_PROJECTION_INVALID');
      expect(final.trace!.length).toBeLessThanOrEqual(5);
      expect(final.trace?.map((event) => event.stage)).toEqual([
        'initial-get',
        ...(milestones ? ['job', 'relay-results', 'complete'] : ['native-refresh']),
        'final-get',
      ]);
      expect(
        final.trace
          ?.filter((event) => event.source === 'native-ack')
          .every(
            (event) =>
              event.status === undefined &&
              event.correlationId === undefined &&
              event.headers === undefined,
          ),
      ).toBe(true);
      expect(plugin.refreshUpcomingBookings).toHaveBeenCalledOnce();
      expect(plugin.request).toHaveBeenCalledTimes(2);
    },
  );

  it('retains the initial read when native refresh fails without inventing an HTTP status or final GET', async () => {
    const { plugin, observe, fetch } = fixture();
    plugin.request.mockResolvedValue(response(503, { code: 'BOOKINGS_PROJECTION_STALE' }));
    plugin.refreshUpcomingBookings.mockRejectedValue({
      code: 'NATIVE_BOOKINGS_DELEGATION_REJECTED',
      message: privateValue,
      data: privateValue,
    });
    await expect(fetch(root + 'bookings/upcoming')).rejects.toThrow();
    const final = observe.mock.lastCall![0];
    expect(final.trace?.map((event) => [event.stage, event.status])).toEqual([
      ['initial-get', 503],
      ['native-refresh', undefined],
    ]);
    expect(final.trace?.[1]?.code).toBe('NATIVE_BOOKINGS_DELEGATION_REJECTED');
    expect(JSON.stringify(observe.mock.calls)).not.toContain(privateValue);
    expect(plugin.request).toHaveBeenCalledOnce();
  });

  it('does not append late coalesced milestones to a newer read or after cancellation', async () => {
    const { plugin, observe, fetch } = fixture();
    let finish!: (
      ack: Awaited<ReturnType<NonNullable<AndroidSessionPlugin['refreshUpcomingBookings']>>>,
    ) => void;
    plugin.refreshUpcomingBookings.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    plugin.request
      .mockResolvedValueOnce(response(503, { code: 'BOOKINGS_PROJECTION_STALE' }))
      .mockResolvedValueOnce(response(503, { code: 'BOOKINGS_PROJECTION_STALE' }))
      .mockResolvedValue(response(200, { state: 'READY', items: [] }));
    const first = fetch(root + 'bookings/upcoming', { headers: { 'x-correlation-id': cid } });
    await vi.waitFor(() => expect(plugin.refreshUpcomingBookings).toHaveBeenCalledOnce());
    const second = fetch(root + 'bookings/upcoming');
    await vi.waitFor(() => expect(plugin.request).toHaveBeenCalledTimes(2));
    observe.mockClear();
    finish({ state: 'refreshed', milestones: ['JOB_ACCEPTED', 'RELAY_ACCEPTED', 'COMPLETED'] });
    await Promise.all([first, second]);
    expect(
      observe.mock.calls.map(([entry]) => entry).filter((entry) => entry.complete),
    ).toHaveLength(1);
    expect(JSON.stringify(observe.mock.calls)).not.toContain(cid);
    expect(plugin.refreshUpcomingBookings).toHaveBeenCalledOnce();
    expect(plugin.request).toHaveBeenCalledTimes(4);
    observe.mockClear();
    await fetch.cancelUpcomingBookingsRefresh();
    expect(observe.mock.calls.map(([entry]) => entry.trace)).toEqual([[], []]);
  });

  it('takes cache origin only from native metadata and refuses mismatched response correlation', async () => {
    const { plugin, observe, fetch } = fixture();
    plugin.request
      .mockResolvedValueOnce({
        ...response(
          200,
          {},
          {
            'x-phub-cache-state': 'network',
            'x-correlation-id': '00000000-0000-4000-8000-000000000002',
          },
        ),
        cache: { state: 'stale', savedAt: 123 },
      })
      .mockResolvedValueOnce(response(200, {}, { 'x-phub-cache-state': 'stale' }));
    await fetch(root + 'profile', { headers: { 'x-correlation-id': cid } });
    expect(observe.mock.lastCall![0].trace?.[0]).toMatchObject({ source: 'stale-cache' });
    expect(observe.mock.lastCall![0].trace?.[0]).not.toHaveProperty('correlationId');
    await fetch(root + 'profile');
    expect(observe.mock.lastCall![0].trace?.[0]?.source).toBe('network');
  });

  it('distinguishes a synthetic local response from an old bridge with unknown provenance', async () => {
    const { plugin, observe, fetch } = fixture();
    const legacy = { status: 200, body: encode({}), headers: { 'x-phub-source': 'network' } };
    plugin.request
      .mockResolvedValueOnce({
        ...response(401, { code: 'AUTH_SESSION_REVOKED' }),
        source: 'local',
      })
      .mockResolvedValueOnce(legacy);
    await fetch(root + 'profile');
    expect(observe.mock.lastCall![0].trace?.[0]?.source).toBe('local');
    await fetch(root + 'profile');
    expect(observe.mock.lastCall![0].trace?.[0]?.source).toBe('unknown');
  });

  it.each([
    { milestones: ['RELAY_ACCEPTED', 'JOB_ACCEPTED', 'COMPLETED'] },
    { milestones: ['JOB_ACCEPTED', 'RELAY_ACCEPTED', privateValue] },
    { milestones: ['JOB_ACCEPTED', 'RELAY_ACCEPTED', 'COMPLETED', privateValue] },
  ])('refuses unreviewed milestone receipt without another GET', async ({ milestones }) => {
    const { plugin, observe, fetch } = fixture();
    plugin.request.mockResolvedValue(response(503, { code: 'BOOKINGS_PROJECTION_STALE' }));
    plugin.refreshUpcomingBookings.mockResolvedValue({
      state: 'refreshed',
      milestones,
    } as unknown as Awaited<
      ReturnType<NonNullable<AndroidSessionPlugin['refreshUpcomingBookings']>>
    >);
    await expect(fetch(root + 'bookings/upcoming')).rejects.toThrow();
    expect(plugin.request).toHaveBeenCalledOnce();
    expect(observe.mock.lastCall![0].trace?.map((event) => event.stage)).toEqual([
      'initial-get',
      'native-refresh',
    ]);
    expect(JSON.stringify(observe.mock.calls)).not.toContain(privateValue);
  });

  it('does not let unrelated or newly observed malformed headers change a valid response', async () => {
    const { plugin, observe, fetch } = fixture();
    plugin.request.mockResolvedValue(
      response(
        200,
        { userId: privateValue },
        { 'x-debug': '\r\n' + privateValue, 'cache-control': '\r\n' + privateValue },
      ),
    );
    const result = await fetch(root + 'profile');
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBeNull();
    expect(await result.json()).toEqual({ userId: privateValue });
    expect(observe.mock.lastCall![0].trace?.[0]?.headers?.cacheControl).toBe('OTHER');
    expect(JSON.stringify(observe.mock.calls)).not.toContain(privateValue);
  });
});

describe('closed shape and header redaction', () => {
  it.each([
    privateValue,
    [privateValue],
    null,
    { [privateValue]: privateValue },
    { message: privateValue.repeat(100000) },
  ])('keeps bounded metadata only for %s', (payload) => {
    expect(JSON.stringify(safeReadShape(encode(payload), 'profile'))).not.toContain(privateValue);
  });
  it('does not retain malformed JSON or nested field names', () => {
    expect(safeReadShape(btoa('{invalid'), 'profile')).toEqual({ shape: 'invalid', fields: [] });
    expect(safeReadShape('!', 'profile')).toEqual({ shape: 'invalid', fields: [] });
    expect(
      safeReadShape(
        encode({ level: { [privateValue]: privateValue }, phoneE164: privateValue }),
        'profile',
      ),
    ).toEqual({ shape: 'object', fields: ['level'] });
  });
  it.each([
    { 'content-type': privateValue, 'cache-control': privateValue, 'retry-after': privateValue },
    {
      'content-type': 'application/json\r\nX-Secret: ' + privateValue,
      'cache-control': 'private, no-store, token=' + privateValue,
      'retry-after': '86401',
    },
    {
      'Content-Type': 'application/json',
      'content-type': 'text/plain',
      'cache-control': 'private, no-store, no-store',
      'retry-after': '01',
    },
  ])('rejects arbitrary, injected and duplicate header values', (headers) => {
    expect(safeReadHeaders(headers)).toEqual({
      contentType: 'OTHER',
      cacheControl: 'OTHER',
      retryAfter: 'OTHER',
    });
    expect(JSON.stringify(safeReadHeaders(headers))).not.toContain(privateValue);
  });
  it('canonicalizes only a real bounded HTTP date and keeps missing fields absent', () => {
    expect(safeReadHeaders({ 'retry-after': 'Mon, 12 Oct 2026 21:00:00 GMT' })).toEqual({
      contentType: 'ABSENT',
      cacheControl: 'ABSENT',
      retryAfter: '2026-10-12T21:00:00.000Z',
    });
    expect(safeReadHeaders({ 'retry-after': 'Tue, 12 Oct 2026 21:00:00 GMT' }).retryAfter).toBe(
      'OTHER',
    );
  });
});
