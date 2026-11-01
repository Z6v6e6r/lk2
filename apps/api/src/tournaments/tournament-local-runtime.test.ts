import { describe, it, expect, vi } from 'vitest';
import { createTournamentLocalRuntime } from './tournament-local-runtime.js';
import { TournamentLocalError, type TournamentOwnerReceipt } from '@phub/domain';
import type { TournamentAttempt, TournamentLocalRepository } from '@phub/database';
import type { TournamentLocalOwnerClient } from '@phub/legacy-games-adapter';
const id = '11111111-1111-4111-a111-111111111111',
  op = '22222222-2222-4222-a222-222222222222';
const actor = {
  tenantId: id,
  tenantKey: 'local',
  userId: id,
  sessionId: id,
  correlationId: 'synthetic',
};
function fixture() {
  const identity = { providerClientId: '7', providerMappingId: id, providerTenantKey: 'tenant' };
  let row: TournamentAttempt | null = null;
  const receipt: TournamentOwnerReceipt = {
    schemaVersion: 1,
    tournamentId: id,
    operation: {
      operationId: op,
      action: 'JOIN',
      outcome: 'REGISTERED',
      reason: 'REGISTERED',
      generation: op,
      committedAt: '2026-10-31T12:00:00Z',
    },
    registration: { status: 'REGISTERED', asOf: '2026-10-31T12:00:01Z' },
  };
  const repository = {
    ready: vi.fn(async () => await Promise.resolve(true)),
    context: vi.fn(async () => await Promise.resolve(identity)),
    read: vi.fn<TournamentLocalRepository['read']>(async () => await Promise.resolve(row)),
    registeredJoinCandidate: vi.fn((): Promise<TournamentAttempt | null> => Promise.resolve(null)),
    begin: vi.fn<TournamentLocalRepository['begin']>(async () => {
      await Promise.resolve();
      row = {
        id: op,
        tournamentId: id,
        request: { action: 'JOIN' },
        command: { schemaVersion: 1, action: 'JOIN', tournamentId: id, date: '2026-11-01' },
        ownerOperationId: op,
        identity,
        state: 'READY',
        receipt: null,
        originalJoinId: null,
      };
      return row;
    }),
    claim: vi.fn<TournamentLocalRepository['claim']>(async () => {
      await Promise.resolve();
      if (row) row.state = 'DISPATCHED';
      return id;
    }),
    complete: vi.fn<TournamentLocalRepository['complete']>(async () => {
      await Promise.resolve();
      if (row) {
        row.receipt = receipt;
        row.state = 'COMPLETED';
      }
      return row;
    }),
  } satisfies TournamentLocalRepository;
  const client = {
    identity: vi.fn(async () => await Promise.resolve({ tenantKey: 'tenant', clientId: '7' })),
    prepare: vi.fn(async () => await Promise.resolve(undefined)),
    command: vi.fn(async () => await Promise.resolve(receipt)),
    read: vi.fn<TournamentLocalOwnerClient['read']>(async () => await Promise.resolve(receipt)),
  };
  const date = vi.fn(async () => await Promise.resolve('2026-11-01')),
    token = vi.fn(async () => await Promise.resolve('synthetic'));
  const runtime = createTournamentLocalRuntime({ enabled: true, repository, client, date, token });
  return {
    runtime,
    repository,
    client,
    date,
    token,
    get: () => row,
    set: (x: TournamentAttempt | null) => {
      row = x;
    },
    receipt,
  };
}
describe('concrete tournament runtime', () => {
  it('pins date and actor before dispatch then separates fresh read', async () => {
    const f = fixture();
    const r = await f.runtime.execute(actor, id, 'original-command-key', { action: 'JOIN' });
    expect(r.operation.status).toBe('REGISTERED');
    expect(r.registration.status).toBe('REGISTERED');
    expect(f.client.prepare).toHaveBeenCalledWith(
      'synthetic',
      id,
      '2026-11-01',
      actor.correlationId,
    );
    expect(f.repository.claim).toHaveBeenCalledTimes(1);
  });
  it('lost owner ACK retry uses original body/key and never re-prepares', async () => {
    const f = fixture();
    f.client.command.mockRejectedValueOnce(new Error('ACK_LOST'));
    expect(
      (await f.runtime.execute(actor, id, 'original-command-key', { action: 'JOIN' })).operation
        .status,
    ).toBe('UNKNOWN');
    const first = f.client.command.mock.calls[0];
    f.date.mockResolvedValue('2027-01-01');
    const r = await f.runtime.retry(actor, id, op);
    expect(r.operation.status).toBe('REGISTERED');
    expect(f.client.command.mock.calls[1]).toEqual(first);
    expect(f.client.prepare).toHaveBeenCalledTimes(1);
    expect(f.repository.begin).toHaveBeenCalledTimes(1);
  });
  it('unknown GET cannot execute, claim or finalize even if owner returns committed row', async () => {
    const f = fixture();
    f.client.command.mockRejectedValueOnce(new Error());
    await f.runtime.execute(actor, id, 'original-command-key', { action: 'JOIN' });
    f.repository.claim.mockClear();
    f.repository.complete.mockClear();
    f.client.command.mockClear();
    expect((await f.runtime.read(actor, id)).result?.operation.status).toBe('UNKNOWN');
    expect(f.repository.claim).not.toHaveBeenCalled();
    expect(f.repository.complete).not.toHaveBeenCalled();
    expect(f.client.command).not.toHaveBeenCalled();
  });
  it('read404 never proves absence or clears original custody', async () => {
    const f = fixture();
    f.client.command.mockRejectedValueOnce(new Error());
    await f.runtime.execute(actor, id, 'original-command-key', { action: 'JOIN' });
    f.client.read.mockRejectedValue(
      new TournamentLocalError('TOURNAMENT_LOCAL_OWNER_NOT_FOUND', 404),
    );
    expect((await f.runtime.read(actor, id)).result?.operation.status).toBe('UNKNOWN');
    expect(f.get()).not.toBeNull();
  });
  it('identity or local mapping drift cannot dispatch original operation', async () => {
    const f = fixture();
    f.client.command.mockRejectedValueOnce(new Error());
    await f.runtime.execute(actor, id, 'original-command-key', { action: 'JOIN' });
    f.client.identity.mockResolvedValue({ tenantKey: 'tenant', clientId: 'different' });
    await expect(f.runtime.retry(actor, id, op)).rejects.toMatchObject({ status: 403 });
    expect(f.client.command).toHaveBeenCalledTimes(1);
  });
  it('unsupported preparation and absent retry never reserve or command', async () => {
    const f = fixture();
    f.client.prepare.mockRejectedValue(
      new TournamentLocalError('TOURNAMENT_LOCAL_UNSUPPORTED', 409),
    );
    await expect(
      f.runtime.execute(actor, id, 'original-command-key', { action: 'JOIN' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.repository.begin).not.toHaveBeenCalled();
    await expect(f.runtime.retry(actor, id, op)).rejects.toMatchObject({ status: 404 });
    expect(f.client.command).not.toHaveBeenCalled();
  });
  it('completed replay only reads, preserving historical success after leave/rejoin', async () => {
    const f = fixture();
    await f.runtime.execute(actor, id, 'original-command-key', { action: 'JOIN' });
    f.client.read.mockResolvedValue({
      ...f.receipt,
      registration: { status: 'UNKNOWN', asOf: f.receipt.registration.asOf },
    });
    const r = await f.runtime.retry(actor, id, op);
    expect(r.operation.status).toBe('REGISTERED');
    expect(r.registration.status).toBe('UNKNOWN');
    expect(f.client.command).toHaveBeenCalledTimes(1);
  });
  it('same key changed action cannot fall through to new LEAVE', async () => {
    const f = fixture();
    await f.runtime.execute(actor, id, 'original-command-key', { action: 'JOIN' });
    await expect(
      f.runtime.execute(actor, id, 'original-command-key', {
        action: 'LEAVE',
        originalJoinOperationId: op,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.client.command).toHaveBeenCalledTimes(1);
  });
  it('disabled or absent table reports command unavailable without identity or owner calls', async () => {
    const f = fixture();
    const disabled = createTournamentLocalRuntime({ enabled: false, repository: f.repository });
    expect(await disabled.read(actor, id)).toEqual({ commandsEnabled: false, result: null });
    f.repository.ready.mockResolvedValue(false);
    expect(await f.runtime.read(actor, id)).toEqual({ commandsEnabled: false, result: null });
    expect(f.client.identity).not.toHaveBeenCalled();
    expect(f.client.command).not.toHaveBeenCalled();
  });
  it('registered A survives latest rejected B and remains exact original LEAVE authority', async () => {
    const f = fixture();
    await f.runtime.execute(actor, id, 'first-command-key', { action: 'JOIN' });
    const original = structuredClone(f.get()!);
    const rejected = {
      ...original,
      id,
      ownerOperationId: id,
      receipt: {
        ...f.receipt,
        operation: {
          ...f.receipt.operation,
          operationId: id,
          outcome: 'REJECTED' as const,
          reason: 'MEMBERSHIP_EXISTS' as const,
          generation: null,
        },
      },
    };
    f.set(rejected);
    f.repository.registeredJoinCandidate.mockResolvedValue(original);
    f.client.command.mockClear();
    const current = await f.runtime.read(actor, id);
    expect(current.result?.operation.id).toBe(op);
    expect(current.result?.registration.status).toBe('REGISTERED');
    expect(f.client.command).not.toHaveBeenCalled();
    f.repository.read.mockImplementation((_scope, selector) =>
      Promise.resolve(selector?.id === op ? original : null),
    );
    f.repository.begin.mockImplementation((_a, _id, _hash, input, identity, date) =>
      Promise.resolve({
        ...original,
        id,
        request: input,
        identity,
        command: {
          schemaVersion: 1,
          action: 'LEAVE',
          tournamentId: id,
          date,
          originalJoinOperationId: op,
        },
        originalJoinId: op,
        receipt: null,
        state: 'READY',
      }),
    );
    f.client.command.mockRejectedValueOnce(new Error('ACK_LOST')); // Exact original LEAVE dispatched; ambiguous remains recoverable.
    await f.runtime.execute(actor, id, 'leave-command-key', {
      action: 'LEAVE',
      originalJoinOperationId: current.result!.operation.id,
    });
    expect(f.client.command).toHaveBeenCalledWith(
      'synthetic',
      expect.any(String),
      expect.objectContaining({ action: 'LEAVE', originalJoinOperationId: op }),
      op,
      actor.correlationId,
    );
    expect(f.repository.begin).toHaveBeenLastCalledWith(
      actor,
      id,
      expect.any(String),
      { action: 'LEAVE', originalJoinOperationId: op },
      original.identity,
      '2026-11-01',
    );
  });
  it.each(['unknown', 'foreign', 'explicit', 'pending'])(
    'does not bypass latest %s with a historical JOIN',
    async (mode) => {
      const f = fixture();
      await f.runtime.execute(actor, id, 'first-command-key', { action: 'JOIN' });
      const original = structuredClone(f.get()!);
      const latest = {
        ...original,
        id,
        ownerOperationId: id,
        receipt:
          mode === 'pending'
            ? null
            : {
                ...f.receipt,
                operation: {
                  ...f.receipt.operation,
                  operationId: id,
                  outcome: 'REJECTED' as const,
                  reason: 'MEMBERSHIP_EXISTS' as const,
                  generation: null,
                },
              },
      };
      f.set(latest);
      f.repository.registeredJoinCandidate.mockResolvedValue(
        mode === 'foreign'
          ? { ...original, identity: { ...original.identity, providerClientId: 'different' } }
          : original,
      );
      f.client.read.mockImplementation((_token, _command, ownerId) =>
        Promise.resolve(
          ownerId === op
            ? {
                ...f.receipt,
                registration: { status: 'UNKNOWN', asOf: f.receipt.registration.asOf },
              }
            : (latest.receipt ?? f.receipt),
        ),
      );
      f.client.command.mockClear();
      const result = await f.runtime.read(actor, id, mode === 'explicit' ? { id } : {});
      expect(result.result?.operation.id).toBe(id);
      expect(f.client.command).not.toHaveBeenCalled();
      if (mode === 'explicit' || mode === 'pending')
        expect(f.repository.registeredJoinCandidate).not.toHaveBeenCalled();
    },
  );
});
