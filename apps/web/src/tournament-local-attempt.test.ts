import { describe, it, expect, vi } from 'vitest';
import { TournamentLocalAttempts } from './tournament-local-attempt.js';
import type { TournamentLocalResult } from '@phub/api-contracts';
const id = '11111111-1111-4111-a111-111111111111',
  op = '22222222-2222-4222-a222-222222222222';
const result: TournamentLocalResult = {
  tournamentId: id,
  operation: { id: op, action: 'JOIN', status: 'UNKNOWN', reason: null, generation: null },
  registration: { status: 'UNKNOWN', asOf: null },
  retryAfterSeconds: 15,
};
function fixture() {
  const map = new Map<string, string>(),
    storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
    };
  let active = true;
  const gateway = {
    commandTournament: vi.fn(async () => await Promise.resolve(result)),
    retryTournament: vi.fn(async () => await Promise.resolve(result)),
    getTournamentRegistration: vi.fn(
      async (): Promise<{ commandsEnabled: boolean; result: TournamentLocalResult | null }> =>
        await Promise.resolve({ commandsEnabled: true, result }),
    ),
  };
  const locks = {
    request: async <T>(_n: string, _o: unknown, f: () => T | PromiseLike<T>) => await f(),
  };
  const controller = () =>
    new TournamentLocalAttempts(
      { tenantId: id, userId: id },
      storage,
      locks,
      gateway,
      () => active,
    );
  return {
    controller,
    gateway,
    storage,
    locks,
    map,
    stop: () => {
      active = false;
    },
  };
}
describe('tournament browser original request custody', () => {
  it('reload and offline retry retain key, read404/null never erase custody', async () => {
    const f = fixture();
    f.gateway.commandTournament.mockRejectedValueOnce(new TypeError('offline'));
    await expect(f.controller().submit(id, { action: 'JOIN' })).rejects.toThrow();
    const key = f.controller().load(id)!.key;
    f.gateway.getTournamentRegistration.mockResolvedValue({ commandsEnabled: false, result: null });
    expect((await f.controller().read(id)).result).toBeNull();
    expect(f.controller().load(id)!.key).toBe(key);
    await f.controller().submit(id, { action: 'JOIN' });
    expect(f.gateway.commandTournament.mock.calls[1]).toEqual(
      f.gateway.commandTournament.mock.calls[0],
    );
  });
  it('uses existing operation retry, no new command/key', async () => {
    const f = fixture();
    await f.controller().submit(id, { action: 'JOIN' });
    await f.controller().retry(id, result);
    expect(f.gateway.retryTournament).toHaveBeenCalledWith(id, op, op);
    expect(f.gateway.commandTournament).toHaveBeenCalledTimes(1);
  });
  it('queued lock account change prevents HTTP', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    f.locks.request = async (_n, _o, callback) => {
      await gate;
      return await callback();
    };
    const work = f.controller().submit(id, { action: 'JOIN' });
    f.stop();
    release();
    await expect(work).rejects.toThrow('ACCOUNT_CHANGED');
    expect(f.gateway.commandTournament).not.toHaveBeenCalled();
    expect(f.map.size).toBe(0);
  });
  it('late ACK after logout cannot update storage', async () => {
    const f = fixture();
    let release!: (r: TournamentLocalResult) => void;
    f.gateway.commandTournament.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const work = f.controller().submit(id, { action: 'JOIN' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const before = [...f.map.values()];
    f.stop();
    release(result);
    await expect(work).rejects.toThrow('ACCOUNT_CHANGED');
    expect([...f.map.values()]).toEqual(before);
  });
  it('another tab pending body prevents a different generation', async () => {
    const f = fixture();
    await f.controller().submit(id, { action: 'JOIN' });
    await expect(
      f.controller().submit(id, { action: 'LEAVE', originalJoinOperationId: op }),
    ).rejects.toThrow('PENDING');
    expect(f.gateway.commandTournament).toHaveBeenCalledTimes(1);
  });
  it('forged response generation retains custody and no roster success', async () => {
    const f = fixture();
    f.gateway.commandTournament.mockResolvedValue({
      ...result,
      operation: { ...result.operation, status: 'REGISTERED', generation: id },
    });
    await expect(f.controller().submit(id, { action: 'JOIN' })).rejects.toThrow('RESPONSE_INVALID');
    expect(f.controller().load(id)).not.toBeNull();
  });
});
