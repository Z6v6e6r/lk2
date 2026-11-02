import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LegacyCommunityToken } from '@phub/communities';
import { createCommunityActorToken } from './community-actor-token.js';
const actor = {
  tenantKey: 'test',
  tenantId: 'tenant',
  userId: 'user',
  sessionId: 'sid',
  correlationId: 'correlation',
};
afterEach(() => vi.useRealTimers());
describe('community-only in-flight delegation', () => {
  it('coalesces same session only while outstanding; settled calls always recheck auth', async () => {
    let resolve!: (value: string) => void;
    const issue = vi.fn<LegacyCommunityToken>(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const token = createCommunityActorToken(issue);
    const a = token(actor),
      b = token({ ...actor, correlationId: 'other' });
    await Promise.resolve();
    expect(issue).toHaveBeenCalledOnce();
    resolve('synthetic');
    expect(await Promise.all([a, b])).toEqual(['synthetic', 'synthetic']);
    const c = token(actor);
    await Promise.resolve();
    expect(issue).toHaveBeenCalledTimes(2);
    resolve('fresh');
    expect(await c).toBe('fresh');
  });
  it('never shares other tenant/user/sid and fails closed at capacity without evicting', async () => {
    const resolvers: ((value: string) => void)[] = [];
    const issue = vi.fn<LegacyCommunityToken>(
      () =>
        new Promise((done) => {
          resolvers.push(done);
        }),
    );
    const token = createCommunityActorToken(issue, { maxInFlight: 4 });
    const reads = [
      token(actor),
      token({ ...actor, tenantId: 'other' }),
      token({ ...actor, userId: 'other' }),
      token({ ...actor, sessionId: 'other' }),
    ];
    await expect(token({ ...actor, sessionId: 'fifth' })).rejects.toThrow('UNAVAILABLE');
    expect(token(actor)).toBe(reads[0]);
    expect(issue).toHaveBeenCalledTimes(4);
    resolvers.forEach((done) => done('synthetic'));
    await Promise.all(reads);
  });
  it('rejection and timeout remove only their own pending promise, permitting a fresh auth check', async () => {
    const issue = vi
      .fn<LegacyCommunityToken>()
      .mockRejectedValueOnce(new Error('revoked'))
      .mockResolvedValueOnce('fresh');
    const token = createCommunityActorToken(issue);
    await expect(token(actor)).rejects.toThrow('revoked');
    expect(await token(actor)).toBe('fresh');
    vi.useFakeTimers();
    const never = vi.fn<LegacyCommunityToken>(() => new Promise(() => {}));
    const timed = createCommunityActorToken(never, { timeoutMs: 20 });
    const first = expect(timed(actor)).rejects.toThrow('UNAVAILABLE');
    await vi.advanceTimersByTimeAsync(20);
    await first;
    never.mockResolvedValueOnce('after-timeout');
    expect(await timed(actor)).toBe('after-timeout');
    expect(never).toHaveBeenCalledTimes(2);
  });
});
