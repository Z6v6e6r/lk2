import { quarterStationFixture } from '../../../../packages/subscription-runtime-adapter/src/quarter-create-station.test-fixture.js';
import { quarterStationIntent } from '@phub/subscription-runtime-adapter';
import { describe, it, expect, vi } from 'vitest';
import { createQuarterCreateRuntime } from './game-quarter-create-runtime.js';
import { quarterFixture } from '../../../../packages/subscription-runtime-adapter/src/quarter-create.test-fixture.js';
import type { QuarterAttempt, QuarterCreateRepository } from '@phub/database/quarter-create';
import { qcAdmissionHash, type QuarterOutcome } from '@phub/domain/quarter-create';
async function setup(adoptStation = false) {
  const f = await quarterFixture(),
    actor = {
      tenantKey: 'public-tenant',
      tenantId: f.scope.tenantId,
      userId: f.scope.userId,
      sessionId: '11111111-1111-4111-8111-000000000099',
      correlationId: 'synthetic-correlation',
    };
  let a: QuarterAttempt | null = null;
  const repo = {
    ready: vi.fn(async () => {
      await Promise.resolve();
      return true;
    }),
    locations: vi.fn(async () => {
      await Promise.resolve();
      return { items: [] };
    }),
    context: vi.fn(async () => {
      await Promise.resolve();
      return f.context;
    }),
    identity: vi.fn<QuarterCreateRepository['identity']>(async () => {
      await Promise.resolve();
      return {
        providerClientId: f.context.providerClientId,
        providerMappingId: f.context.providerMappingId,
        providerClientSubscriptionId: f.context.providerClientSubscriptionId,
      };
    }),
    read: vi.fn(async () => {
      await Promise.resolve();
      return a;
    }),
    commandRead: vi.fn(async () => {
      await Promise.resolve();
      return a;
    }),
    begin: vi.fn(
      async (
        _s: Parameters<QuarterCreateRepository['begin']>[0],
        _q: Parameters<QuarterCreateRepository['begin']>[1],
        c: Parameters<QuarterCreateRepository['begin']>[2],
        _correlation: string,
        refuse?: boolean,
      ) => {
        await Promise.resolve();
        return (a = {
          id: f.receipt.operationId,
          draftId: f.request.target.draftId,
          request: f.request,
          context: c,
          state: refuse ? 'REFUSED_NOT_DISPATCHED' : 'PREPARING',
          admission: null,
          admissionHash: null,
          receipt: null,
          gameId: null,
          leaseToken: null,
          stationMembership:
            adoptStation && !refuse ? { version: 1, outcome: 'PENDING_ADMISSION' } : null,
        });
      },
    ),
    claimPreparation: vi.fn(async () => {
      await Promise.resolve();
      return '11111111-1111-4111-8111-000000000070' as const;
    }),
    releasePreparation: vi.fn(async () => {
      await Promise.resolve();
      return a;
    }),
    expireStationIntent: vi.fn(async () => {
      await Promise.resolve();
      return a;
    }),
    pinStationPreparation: vi.fn<QuarterCreateRepository['pinStationPreparation']>(
      async (
        _s: Parameters<QuarterCreateRepository['pinStationPreparation']>[0],
        _t: string,
        q: Parameters<QuarterCreateRepository['pinStationPreparation']>[2],
      ) => {
        a = { ...a!, stationMembership: await quarterStationIntent(q) };
        return a;
      },
    ),
    prepared: vi.fn(
      async (
        _s: Parameters<QuarterCreateRepository['prepared']>[0],
        _t: string,
        _q: Parameters<QuarterCreateRepository['prepared']>[2],
        _c: string,
        marker?: Parameters<QuarterCreateRepository['prepared']>[4],
      ) =>
        (a = {
          ...a!,
          state: 'PREPARED',
          ...(marker ? { stationMembership: marker } : {}),
          admission: f.admission,
          admissionHash: await qcAdmissionHash(f.admission),
        }),
    ),
    refusePreparation: vi.fn(async () => {
      await Promise.resolve();
      return (a = { ...a!, state: 'REFUSED_NOT_DISPATCHED' });
    }),
    expirePrepared: vi.fn(async () => {
      await Promise.resolve();
      return a;
    }),
    claimDispatch: vi.fn(async () => {
      await Promise.resolve();
      const recoveryOnly = a!.state === 'DISPATCH_STARTED';
      a = { ...a!, state: 'DISPATCH_STARTED' };
      return { attempt: a, token: '11111111-1111-4111-8111-000000000071' as const, recoveryOnly };
    }),
    complete: vi.fn(
      async (
        _s: Parameters<QuarterCreateRepository['complete']>[0],
        _t: string,
        receipt: Parameters<QuarterCreateRepository['complete']>[2],
        rejected: boolean,
      ) => {
        await Promise.resolve();
        return (a = { ...a!, receipt, state: rejected ? 'REJECTED' : 'CONFIRMED' });
      },
    ),
    project: vi.fn(async () => {
      await Promise.resolve();
      return null;
    }),
  } satisfies QuarterCreateRepository;
  const outcome: QuarterOutcome = {
      status: 'CONFIRMED',
      receipt: f.receipt,
      registration: { status: 'CONFIRMED', asOf: f.receipt.confirmedAt },
      reason: null,
    },
    client = {
      prepare: vi.fn(async () => {
        await Promise.resolve();
        return f.admission;
      }),
      admit: vi.fn(async () => {
        await Promise.resolve();
        return outcome;
      }),
      read: vi.fn(async () => {
        await Promise.resolve();
        return outcome;
      }),
    },
    issuer = {
      issueQuarterCreate: vi.fn(async () => {
        await Promise.resolve();
        return 'synthetic-delegation';
      }),
    },
    token = vi.fn(async () => {
      await Promise.resolve();
      return {
        token: 'synthetic-user-token',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
    });
  const options = { enabled: true, repository: repo, client, issuer, token };
  return {
    f,
    actor,
    repo,
    client,
    issuer,
    token,
    options,
    runtime: createQuarterCreateRuntime(options),
    set: (v: QuarterAttempt) => {
      a = v;
    },
    get: () => a,
  };
}
describe('quarter command and read separation', () => {
  it('persists prepare then dispatch before HTTP; receipt does not invent game or station enrollment', async () => {
    const t = await setup(),
      v = await t.runtime.execute(t.actor, t.f.key, t.f.input);
    expect(v.operation.status).toBe('CONFIRMED');
    expect(v.gameProjection).toEqual({ status: 'PENDING', gameId: null });
    expect(vi.mocked(t.repo.prepared).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(t.repo.claimDispatch).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(t.repo.claimDispatch).mock.invocationCallOrder[0]).toBeLessThan(
      t.client.admit.mock.invocationCallOrder[0]!,
    );
    expect(JSON.stringify(v)).not.toContain('synthetic-exercise');
  });
  it('default off/schema unavailable stops before identity, custody, token or HTTP', async () => {
    const t = await setup();
    await expect(
      createQuarterCreateRuntime({ ...t.options, enabled: false }).execute(
        t.actor,
        t.f.key,
        t.f.input,
      ),
    ).rejects.toThrow();
    vi.mocked(t.repo.ready).mockResolvedValue(false);
    await expect(t.runtime.execute(t.actor, t.f.key, t.f.input)).rejects.toThrow();
    expect(t.repo.context).not.toHaveBeenCalled();
    expect(t.token).not.toHaveBeenCalled();
    expect(t.client.prepare).not.toHaveBeenCalled();
  });
  it('absent recovery records restrictive no-dispatch proof without context/token/provider', async () => {
    const t = await setup(),
      v = await t.runtime.execute(t.actor, t.f.key, t.f.input, true);
    expect(v.operation.status).toBe('REFUSED_NOT_DISPATCHED');
    expect(t.repo.begin).toHaveBeenCalledWith(
      expect.anything(),
      t.f.input,
      null,
      t.actor.correlationId,
      true,
    );
    expect(t.repo.context).not.toHaveBeenCalled();
    expect(t.token).not.toHaveBeenCalled();
    expect(t.client.admit).not.toHaveBeenCalled();
  });
  it('lost admission ACK retains original capsule and recovery_only, never reprepare', async () => {
    const t = await setup();
    t.client.admit.mockRejectedValueOnce(new Error('lost response'));
    const first = await t.runtime.execute(t.actor, t.f.key, t.f.input);
    expect(first.operation.status).toBe('UNKNOWN');
    await t.runtime.execute(t.actor, t.f.key, t.f.input, true);
    expect(t.client.prepare).toHaveBeenCalledOnce();
    expect(t.issuer.issueQuarterCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'admit', recoveryOnly: true, request: t.f.admission }),
    );
    expect(t.client.admit).toHaveBeenNthCalledWith(2, t.f.admission, expect.anything());
  });
  it('GET never completes local unknown even when owner read observes confirmation', async () => {
    const t = await setup();
    t.client.admit.mockRejectedValueOnce(new Error());
    await t.runtime.execute(t.actor, t.f.key, t.f.input);
    const v = await t.runtime.read(t.actor, t.f.key);
    expect(v?.operation.status).toBe('UNKNOWN');
    expect(v?.registration.status).toBe('CONFIRMED');
    expect(t.repo.complete).not.toHaveBeenCalled();
    expect(t.client.admit).toHaveBeenCalledOnce();
  });
  it('historical confirmation with unavailable owner is not current attendance', async () => {
    const t = await setup();
    await t.runtime.execute(t.actor, t.f.key, t.f.input);
    t.client.read.mockRejectedValue(new Error());
    const v = await t.runtime.read(t.actor, t.f.key);
    expect(v?.operation.status).toBe('CONFIRMED');
    expect(v?.registration).toEqual({ status: 'UNKNOWN', asOf: null });
    expect(t.repo.project).toHaveBeenLastCalledWith(expect.anything(), false);
  });
  it('disabled rollback keeps historical custody readable without credentials or remote calls', async () => {
    const t = await setup();
    await t.runtime.execute(t.actor, t.f.key, t.f.input);
    t.client.read.mockClear();
    t.token.mockClear();
    const off = createQuarterCreateRuntime({ enabled: false, repository: t.repo }),
      v = await off.read(t.actor, t.f.key);
    expect(v?.operation.status).toBe('CONFIRMED');
    expect(v?.registration).toEqual({ status: 'UNKNOWN', asOf: null });
    expect(t.client.read).not.toHaveBeenCalled();
    expect(t.token).not.toHaveBeenCalled();
    expect(t.repo.project).toHaveBeenLastCalledWith(expect.anything(), false);
    await expect(off.execute(t.actor, t.f.key, t.f.input, true)).rejects.toThrow();
  });
  it('changed request or post-token identity blocks original admission', async () => {
    const t = await setup();
    t.client.admit.mockRejectedValueOnce(new Error());
    await t.runtime.execute(t.actor, t.f.key, t.f.input);
    await expect(
      t.runtime.execute(
        t.actor,
        t.f.key,
        { ...t.f.input, subscriptionId: t.f.request.target.stationId },
        true,
      ),
    ).rejects.toMatchObject({ code: 'GAME_QUARTER_CREATE_KEY_CONFLICT' });
    vi.mocked(t.repo.identity).mockResolvedValue(null);
    await expect(t.runtime.execute(t.actor, t.f.key, t.f.input, true)).rejects.toThrow();
    expect(t.client.admit).toHaveBeenCalledOnce();
  });
  it('expired no-dispatch terminal never releases a dispatched command', async () => {
    const t = await setup();
    vi.mocked(t.repo.expirePrepared).mockImplementation(async () => {
      await Promise.resolve();
      const a = { ...t.get()!, state: 'EXPIRED_NOT_DISPATCHED' as const };
      t.set(a);
      return a;
    });
    const v = await t.runtime.execute(t.actor, t.f.key, t.f.input);
    expect(v.operation.status).toBe('EXPIRED_NOT_DISPATCHED');
    expect(t.client.admit).not.toHaveBeenCalled();
  });
});

describe('quarter CREATE station admission custody', () => {
  async function adopted() {
    const t = await setup(true),
      m = await quarterStationFixture(t.f.admission);
    const station = {
      signer: { issue: vi.fn(() => 'synthetic-station-delegation') },
      client: {
        admit: vi.fn(async () => {
          await Promise.resolve();
          expect(t.get()?.stationMembership?.outcome).toBe('INTENT');
          expect(t.repo.claimDispatch).not.toHaveBeenCalled();
          return m.response;
        }),
      },
    };
    return {
      ...t,
      m,
      station,
      runtime: createQuarterCreateRuntime({ ...t.options, stationMembership: station }),
    };
  }
  it('pins before station POST and settles before sole original provider dispatch', async () => {
    const t = await adopted();
    expect((await t.runtime.execute(t.actor, t.f.key, t.f.input)).operation.status).toBe(
      'CONFIRMED',
    );
    expect(t.repo.pinStationPreparation).toHaveBeenCalledTimes(1);
    expect(t.station.client.admit).toHaveBeenCalledTimes(1);
    expect(t.client.admit).toHaveBeenCalledTimes(1);
    expect(t.repo.prepared.mock.calls[0]?.[4]).toEqual(t.m);
    expect(t.repo.claimDispatch).toHaveBeenCalledTimes(1);
  });
  it('transport failure holds INTENT and releases own lease; retry reuses exact capsule without new prepare', async () => {
    const t = await adopted();
    t.station.client.admit.mockRejectedValueOnce(new Error('timeout'));
    const first = await t.runtime.execute(t.actor, t.f.key, t.f.input);
    expect(first.operation.status).toBe('PENDING');
    expect(t.repo.claimDispatch).not.toHaveBeenCalled();
    expect(t.repo.releasePreparation).toHaveBeenCalledTimes(1);
    const pinned = structuredClone(t.get()?.stationMembership);
    await t.runtime.read(t.actor, t.f.key);
    expect(t.get()?.stationMembership).toEqual(pinned);
    await t.runtime.execute(t.actor, t.f.key, t.f.input, true);
    expect(t.client.prepare).toHaveBeenCalledTimes(1);
    expect(t.client.admit).toHaveBeenCalledTimes(1);
    expect(t.station.client.admit.mock.calls[0]).toEqual(t.station.client.admit.mock.calls[1]);
  });
  it('missing station transport holds adopted attempt, while null history remains legacy', async () => {
    const t = await setup(true);
    expect((await t.runtime.execute(t.actor, t.f.key, t.f.input)).operation.status).toBe('PENDING');
    expect(t.client.prepare).not.toHaveBeenCalled();
    expect(t.repo.claimDispatch).not.toHaveBeenCalled();
    const legacy = await setup();
    expect(
      (await legacy.runtime.execute(legacy.actor, legacy.f.key, legacy.f.input)).operation.status,
    ).toBe('CONFIRMED');
  });
  it('ambiguous pin ACK does not send station or CREATE; original stored intent survives', async () => {
    const t = await adopted();
    const original = t.repo.pinStationPreparation.getMockImplementation()!;
    t.repo.pinStationPreparation.mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error('lost pin ack');
    });
    await t.runtime.execute(t.actor, t.f.key, t.f.input);
    expect(t.get()?.stationMembership?.outcome).toBe('INTENT');
    expect(t.station.client.admit).not.toHaveBeenCalled();
    expect(t.client.admit).not.toHaveBeenCalled();
    await t.runtime.execute(t.actor, t.f.key, t.f.input, true);
    expect(t.client.prepare).toHaveBeenCalledTimes(1);
  });
  it('explicit blocked membership permits booking without replacing original receiver result', async () => {
    const t = await adopted();
    t.station.client.admit.mockResolvedValue(
      (await quarterStationFixture(t.f.admission, true)).response,
    );
    expect((await t.runtime.execute(t.actor, t.f.key, t.f.input)).operation.status).toBe(
      'CONFIRMED',
    );
    expect(t.get()?.stationMembership?.outcome).toBe('OWNER_ADMISSION');
    expect(t.repo.prepared.mock.calls[0]?.[4]).toMatchObject({
      response: { admission: { reason: 'MEMBERSHIP_BLOCKED' } },
    });
  });
  it('malformed disabled response and signer failure never dispatch or manufacture NO_ENROLLMENT', async () => {
    const t = await adopted();
    t.station.client.admit.mockResolvedValue({
      ...t.m.response,
      admission: { ...t.m.response.admission, reason: 'DISABLED', outcome: 'NO_ENROLLMENT' },
    });
    await t.runtime.execute(t.actor, t.f.key, t.f.input);
    expect(t.repo.claimDispatch).not.toHaveBeenCalled();
    expect(t.get()?.stationMembership?.outcome).toBe('INTENT');
    t.station.signer.issue.mockImplementation(() => {
      throw new Error('signer unavailable');
    });
    await t.runtime.execute(t.actor, t.f.key, t.f.input, true);
    expect(t.repo.claimDispatch).not.toHaveBeenCalled();
  });
  it('expired pinned capsule terminalizes before station or booking; no fresh preparation', async () => {
    const t = await adopted();
    t.station.client.admit.mockRejectedValueOnce(new Error('timeout'));
    await t.runtime.execute(t.actor, t.f.key, t.f.input);
    t.repo.expireStationIntent.mockImplementationOnce(async () => {
      await Promise.resolve();
      const a = t.get()!;
      t.set({ ...a, state: 'EXPIRED_NOT_DISPATCHED', admission: t.f.admission });
      return t.get();
    });
    expect((await t.runtime.execute(t.actor, t.f.key, t.f.input, true)).operation.status).toBe(
      'EXPIRED_NOT_DISPATCHED',
    );
    expect(t.client.prepare).toHaveBeenCalledTimes(1);
    expect(t.station.client.admit).toHaveBeenCalledTimes(1);
    expect(t.client.admit).not.toHaveBeenCalled();
  });
  it('stale preparation lease cannot POST station admission even with an existing pinned intent', async () => {
    const t = await adopted();
    t.station.client.admit.mockRejectedValueOnce(new Error('timeout'));
    await t.runtime.execute(t.actor, t.f.key, t.f.input);
    t.repo.pinStationPreparation.mockResolvedValueOnce(null);
    await t.runtime.execute(t.actor, t.f.key, t.f.input, true);
    expect(t.station.client.admit).toHaveBeenCalledTimes(1);
    expect(t.repo.claimDispatch).not.toHaveBeenCalled();
  });
  it('unready marker schema blocks all owner/provider access before a new attempt', async () => {
    const t = await adopted();
    t.repo.ready.mockResolvedValue(false);
    await expect(t.runtime.execute(t.actor, t.f.key, t.f.input)).rejects.toThrow();
    expect(t.repo.begin).not.toHaveBeenCalled();
    expect(t.client.prepare).not.toHaveBeenCalled();
    expect(t.station.client.admit).not.toHaveBeenCalled();
    expect(t.client.admit).not.toHaveBeenCalled();
  });
});
