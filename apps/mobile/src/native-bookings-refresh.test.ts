import { describe, expect, it, vi } from 'vitest';
import {
  createNativeApiFetch,
  type AndroidSessionPlugin,
  type NativeReadObservation,
} from './native-api-fetch.js';
import { sessionFailureDetails } from './session-failure.js';

const config = {
  apiBaseUrl: 'https://lk2.padlhub.su',
  tenantKey: 'local-padel',
  appVersion: 'test',
};
const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}`;
const response = (status: number, value: unknown) => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(value)).toString('base64'),
});
const stale = response(503, { code: 'BOOKINGS_PROJECTION_STALE' });
const fresh = {
  state: 'READY',
  version: 'synthetic-server-version',
  generatedAt: '2099-01-01T00:00:00.000Z',
  staleAt: '2099-01-01T00:01:00.000Z',
  items: [{ id: 'synthetic-canonical-item', title: 'Игра' }],
};
function native() {
  return {
    configuration: vi.fn(),
    request: vi.fn<AndroidSessionPlugin['request']>(),
    refreshUpcomingBookings: vi.fn().mockResolvedValue({ state: 'refreshed' }),
    cancelUpcomingBookingsRefresh: vi.fn().mockResolvedValue({ state: 'cancelled' }),
  };
}

describe('fixed native upcoming-bookings refresh', () => {
  it.each([
    stale,
    response(200, { state: 'UNAVAILABLE' }),
    response(200, { ...fresh, staleAt: '2000-01-01T00:00:00.000Z' }),
  ])(
    'refreshes an unavailable projection and returns only the ordinary server reread',
    async (initial) => {
      const plugin = native();
      const observe = vi.fn();
      plugin.request.mockResolvedValueOnce(initial).mockResolvedValueOnce(response(200, fresh));
      const fetch = createNativeApiFetch(config, plugin, undefined, undefined, observe);
      const result = await fetch(`${root}/bookings/upcoming`);
      expect(await result.json()).toEqual(fresh);
      expect(plugin.refreshUpcomingBookings.mock.calls).toEqual([[]]);
      expect(plugin.request.mock.calls.map(([request]) => [request.path, request.method])).toEqual([
        ['/user/api/v1/local-padel/bookings/upcoming', 'GET'],
        ['/user/api/v1/local-padel/bookings/upcoming', 'GET'],
      ]);
      expect(observe).toHaveBeenLastCalledWith(
        expect.objectContaining({ section: 'bookings', failure: null, complete: true }),
      );
    },
  );

  it.each([
    [`${root}/profile`, stale],
    [`${root}/bookings/upcoming?limit=50`, stale],
    [`${root}/bookings/upcoming`, response(403, { code: 'TENANT_ACCESS_DENIED' })],
    [`${root}/bookings/upcoming`, response(503, { code: 'UNKNOWN_FAILURE' })],
    [`${root}/bookings/upcoming`, response(200, fresh)],
  ])('does not expand the fixed capability for %s', async (url, initial) => {
    const plugin = native();
    plugin.request.mockResolvedValue(initial);
    await createNativeApiFetch(config, plugin)(url);
    expect(plugin.refreshUpcomingBookings).not.toHaveBeenCalled();
    expect(plugin.request).toHaveBeenCalledOnce();
  });

  it('shares one provider refresh between concurrent reads', async () => {
    const plugin = native();
    let finish!: (value: { state: string }) => void;
    plugin.refreshUpcomingBookings.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    plugin.request
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(stale)
      .mockResolvedValue(response(200, fresh));
    const fetch = createNativeApiFetch(config, plugin);
    const first = fetch(`${root}/bookings/upcoming`);
    const second = fetch(`${root}/bookings/upcoming`);
    await vi.waitFor(() => expect(plugin.refreshUpcomingBookings).toHaveBeenCalledOnce());
    finish({ state: 'refreshed' });
    expect((await Promise.all([first, second])).every((value) => value.ok)).toBe(true);
    expect(plugin.request).toHaveBeenCalledTimes(4);
  });

  it('retires the refresh before logout cleanup and never rereads or publishes its late result', async () => {
    const plugin = native();
    let finish!: (value: { state: string }) => void;
    plugin.refreshUpcomingBookings.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    plugin.request.mockResolvedValue(stale);
    const observe = vi.fn();
    const fetch = createNativeApiFetch(config, plugin, undefined, undefined, observe);
    const pending = fetch(`${root}/bookings/upcoming`);
    const discarded = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(plugin.refreshUpcomingBookings).toHaveBeenCalledOnce());
    expect(observe).toHaveBeenCalledOnce();
    expect(observe.mock.calls[0]![0]).toMatchObject({ complete: false });
    observe.mockClear();
    await fetch.cancelUpcomingBookingsRefresh();
    expect(observe.mock.calls.map(([entry]) => (entry as NativeReadObservation).trace)).toEqual([
      [],
      [],
    ]);
    observe.mockClear();
    finish({ state: 'refreshed' });
    await discarded;
    expect(plugin.cancelUpcomingBookingsRefresh.mock.calls).toEqual([[]]);
    expect(plugin.request).toHaveBeenCalledOnce();
    expect(observe).not.toHaveBeenCalled();
  });

  it('cancels the native operation when the consumer aborts', async () => {
    const plugin = native();
    let finish!: (value: { state: string }) => void;
    plugin.refreshUpcomingBookings.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    plugin.request.mockResolvedValue(stale);
    const fetch = createNativeApiFetch(config, plugin);
    const controller = new AbortController();
    const pending = fetch(`${root}/bookings/upcoming`, { signal: controller.signal });
    const discarded = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(plugin.refreshUpcomingBookings).toHaveBeenCalledOnce());
    controller.abort();
    finish({ state: 'refreshed' });
    await discarded;
    expect(plugin.cancelUpcomingBookingsRefresh).toHaveBeenCalledOnce();
    expect(plugin.request).toHaveBeenCalledOnce();
  });

  it('keeps a failed refresh bounded and never constructs an empty successful response', async () => {
    const plugin = native();
    plugin.request.mockResolvedValue(stale);
    plugin.refreshUpcomingBookings.mockRejectedValue({
      code: 'NATIVE_REFRESH_UNAVAILABLE',
      message: 'synthetic-private-provider-payload',
      cause: { accessToken: 'synthetic-private-provider-token' },
    });
    const failure: unknown = await createNativeApiFetch(
      config,
      plugin,
    )(`${root}/bookings/upcoming`).catch((error: unknown) => error);
    expect(sessionFailureDetails(failure).code).toBe('NATIVE_REFRESH_UNAVAILABLE');
    expect(JSON.stringify(failure)).not.toContain('synthetic-private');
    expect(plugin.request).toHaveBeenCalledOnce();
    expect(plugin.refreshUpcomingBookings).toHaveBeenCalledOnce();
  });

  it('rejects additional data on the new bridge acknowledgement', async () => {
    const plugin = native();
    plugin.request.mockResolvedValue(stale);
    plugin.refreshUpcomingBookings.mockResolvedValue({
      state: 'refreshed',
      token: 'synthetic-private-token',
    });
    const failure: unknown = await createNativeApiFetch(
      config,
      plugin,
    )(`${root}/bookings/upcoming`).catch((error: unknown) => error);
    expect(sessionFailureDetails(failure).code).toBe('NATIVE_REQUEST_REJECTED');
    expect(JSON.stringify(failure)).not.toContain('synthetic-private-token');
    expect(plugin.request).toHaveBeenCalledOnce();
  });
});
