import { describe, expect, it, vi } from 'vitest';
import type { IOSSessionPlugin } from './session.js';
import { createCabinetData } from './cabinet-data.js';
import {
  auth,
  config,
  fixtureReply,
  nativeResult,
  syntheticSession,
  viewerId,
  homeDashboard,
} from './testing/cabinet-fixtures.js';

type NativeResponse = Awaited<ReturnType<IOSSessionPlugin['request']>>;
function deferred() {
  let resolve!: (value: NativeResponse) => void;
  const promise = new Promise<NativeResponse>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('cabinet and native session lifecycle', () => {
  it('uses one SDK session for private reads and sends neither bearer nor cookie on public games', async () => {
    const request = vi.fn<IOSSessionPlugin['request']>(
      async (input) => await Promise.resolve(fixtureReply(input)),
    );
    const session = syntheticSession(request);
    await session.restore();
    const data = createCabinetData(session, viewerId);
    await data.profile();
    await data.games();
    expect(request.mock.calls[1]![0]).toMatchObject({
      operation: 'read',
      resource: 'profile',
      headers: { authorization: `Bearer ${auth.accessToken}`, 'x-app-platform': 'ios' },
    });
    const publicRequest = request.mock.calls[2]![0];
    expect(publicRequest.resource).toBe('publicGames');
    expect(
      Object.keys(publicRequest.headers).some((name) => /authorization|cookie/i.test(name)),
    ).toBe(false);
  });

  it('coalesces refresh after concurrent 401s and retries both reads with the successor', async () => {
    const rotation = deferred();
    let refreshCount = 0;
    const request = vi.fn<IOSSessionPlugin['request']>(async (input) => {
      if (input.operation === 'refresh') {
        refreshCount++;
        return await Promise.resolve(refreshCount === 1 ? nativeResult(auth) : rotation.promise);
      }
      if (
        input.operation === 'read' &&
        input.headers.authorization === `Bearer ${auth.accessToken}`
      )
        return await Promise.resolve(nativeResult({ code: 'AUTH_SESSION_EXPIRED' }, 401));
      return await Promise.resolve(fixtureReply(input));
    });
    const session = syntheticSession(request);
    await session.restore();
    const data = createCabinetData(session, viewerId);
    const profile = data.profile();
    const bookings = data.bookings();
    await vi.waitFor(() => expect(refreshCount).toBe(2));
    rotation.resolve(nativeResult({ ...auth, accessToken: 'synthetic-successor' }));
    await expect(profile).resolves.toMatchObject({ userId: viewerId });
    await expect(bookings).resolves.toMatchObject({ state: 'READY' });
    expect(refreshCount).toBe(2);
    expect(session.getSnapshot().status).toBe('signed-in');
  });

  it('starts revocation immediately and discards a late read before another login', async () => {
    const read = deferred();
    const request = vi.fn<IOSSessionPlugin['request']>(
      async (input) =>
        await Promise.resolve(input.operation === 'read' ? read.promise : fixtureReply(input)),
    );
    const session = syntheticSession(request);
    await session.restore();
    const pending = createCabinetData(session, viewerId).profile();
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const logout = session.logout();
    expect(session.getSnapshot().status).toBe('checking');
    expect(request.mock.calls.some(([input]) => input.operation === 'logout')).toBe(true);
    await expect(session.verify(viewerId, '1234')).rejects.toThrow('Session operation in progress');
    read.resolve(nativeResult(homeDashboard.profile));
    await rejected;
    await logout;
    expect(request.mock.calls.at(-1)![0].operation).toBe('logout');
    expect(session.getSnapshot().status).toBe('signed-out');
    await session.verify(viewerId, '1234');
    expect(session.getSnapshot().status).toBe('signed-in');
  });

  it('waits for a late SDK rotation after logout so its access cannot enter a new lifecycle', async () => {
    const rotation = deferred();
    let refreshes = 0;
    let reads = 0;
    const request = vi.fn<IOSSessionPlugin['request']>(async (input) => {
      if (input.operation === 'refresh' && ++refreshes > 1) return rotation.promise;
      if (input.operation === 'read' && ++reads === 1)
        return await Promise.resolve(nativeResult({ code: 'AUTH_SESSION_EXPIRED' }, 401));
      return await Promise.resolve(fixtureReply(input));
    });
    const session = syntheticSession(request);
    await session.restore();
    const data = createCabinetData(session, viewerId);
    const pending = data.profile();
    const discarded = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(refreshes).toBe(2));
    const logout = session.logout();
    expect(request.mock.calls.at(-1)![0].operation).toBe('logout');
    expect(session.getSnapshot().status).toBe('checking');
    rotation.resolve(nativeResult({ ...auth, accessToken: 'synthetic-late-access' }));
    await discarded;
    await logout;
    expect(session.getSnapshot().status).toBe('signed-out');
    const count = request.mock.calls.length;
    await expect(data.profile()).rejects.toMatchObject({ code: 'NATIVE_REQUEST_REJECTED' });
    expect(request.mock.calls).toHaveLength(count);
  });

  it('revokes a native credential on final 401; failed revocation stays pending, never a fresh login', async () => {
    const request = vi.fn<IOSSessionPlugin['request']>(async (input) => {
      if (input.operation === 'read')
        return await Promise.resolve(nativeResult({ code: 'AUTH_SESSION_REVOKED' }, 401));
      if (input.operation === 'logout')
        return await Promise.resolve(nativeResult({ code: 'UNAVAILABLE' }, 503));
      return await Promise.resolve(fixtureReply(input));
    });
    const session = syntheticSession(request);
    await session.restore();
    await expect(createCabinetData(session, viewerId).profile()).rejects.toMatchObject({
      status: 401,
    });
    expect(session.getSnapshot()).toEqual({ status: 'offline', retry: 'logout' });
    await expect(session.verify(viewerId, '1234')).rejects.toMatchObject({
      code: 'NATIVE_REQUEST_REJECTED',
    });
    request.mockImplementation(async (input) => await Promise.resolve(fixtureReply(input)));
    await session.logout();
    expect(session.getSnapshot().status).toBe('signed-out');
  });

  it('rejects cross-account profile/home data, unavailable bookings and unsupported date filtering', async () => {
    const session = syntheticSession(async (input) => {
      if (input.resource === 'bookings')
        return await Promise.resolve(nativeResult({ state: 'UNAVAILABLE', items: [] }));
      return await Promise.resolve(fixtureReply(input));
    });
    await session.restore();
    const data = createCabinetData(session, 'other-account');
    for (const load of [data.profile, data.home, data.dashboard])
      await expect(load()).rejects.toMatchObject({ code: 'NATIVE_ACCOUNT_MISMATCH' });
    await expect(data.bookings()).rejects.toThrow('Bookings unavailable');
    await expect(data.recommendations({ localDate: '2026-09-27' })).rejects.toThrow('Selected-day');
    expect(session.configuration.apiBaseUrl).toBe(config.apiBaseUrl);
  });
});
