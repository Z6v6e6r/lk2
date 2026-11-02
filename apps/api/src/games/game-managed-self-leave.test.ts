import { managedSelfLeaveFixture as f } from '../../../../packages/subscription-runtime-adapter/src/managed-self-leave.test-fixture.js';
import { describe, it, expect, vi } from 'vitest';
import type {
  ManagedSelfLeaveAttempt,
  ManagedSelfLeaveRepository,
} from '@phub/database/managed-self-leave';
import { createManagedSelfLeaveRuntime, managedSelfLeaveBody } from './game-managed-self-leave.js';
function setup(state: ManagedSelfLeaveAttempt['state'] = 'PREPARED') {
  const a: ManagedSelfLeaveAttempt = {
    authority: {
      ...f.identity,
      request: f.request,
      requestSha256: f.requestSha256,
      originalJoinReceipt: f.originalJoinReceipt,
      legacyGameId: f.confirmed.receipt.legacyGameId,
      legacyGameMappingId: f.confirmed.receipt.legacyGameMappingId,
      legacyGameMappingVersion: f.confirmed.receipt.legacyGameMappingVersion,
    },
    state,
    idempotencyKey: 'synthetic-stable-self-leave',
    receipt: null,
    result: null,
    createdAt: '2026-10-31T15:00:00.000Z',
    updatedAt: '2026-10-31T15:00:00.000Z',
  };
  const repository = {
    isNoPayment: vi.fn(() => Promise.resolve(false)),
    readCommand: vi.fn(() => Promise.resolve(null)),
    reconcileUndispatched: vi.fn(() => Promise.resolve(null)),
    readByKey: vi.fn(() => Promise.resolve().then(() => a)),
    read: vi.fn(() => Promise.resolve().then(() => a)),
    begin: vi.fn(() => Promise.resolve().then(() => a)),
    claim: vi.fn(() =>
      Promise.resolve().then(() => ({
        attempt: a,
        leaseToken: 'lease',
        recoveryOnly: state === 'DISPATCH_STARTED',
      })),
    ),
    finalize: vi.fn(() =>
      Promise.resolve().then(() => ({
        ...a,
        state: 'COMPLETED' as const,
        receipt: f.confirmed.receipt,
      })),
    ),
  };
  const client = {
    read: vi.fn(() => Promise.resolve().then(() => f.unknown)),
    admit: vi.fn(() => Promise.resolve().then(() => f.unknown)),
  };
  const boundary = {
    delegationIssuer: {
      issueManagedSelfLeaveRead: vi.fn(() => Promise.resolve().then(() => 'synthetic-read-jwt')),
      issueManagedSelfLeaveAdmission: vi.fn(() =>
        Promise.resolve().then(() => 'synthetic-admission-jwt'),
      ),
    },
    actorContextRepository: {
      resolve: vi.fn(() =>
        Promise.resolve().then(() => ({
          outcome: 'ok' as const,
          providerClientId: f.originalJoinReceipt.providerClientId,
          providerMappingId: f.originalJoinReceipt.providerMappingId,
        })),
      ),
    },
  };
  const issueActorToken = vi.fn(() =>
    Promise.resolve().then(() => ({
      token: 'synthetic-actor-token',
      expiresAt: new Date(Date.now() + 30000).toISOString(),
    })),
  );
  const options = {
    config: {
      APP_ENV: 'ci' as const,
      GAME_MANAGED_SELF_LEAVE_ENABLED: true,
      GAME_COMMERCIAL_JOIN_OWNER_BASE_URL: 'https://owner.example.test',
      GAME_COMMERCIAL_JOIN_OWNER_TIMEOUT_MS: 100,
    },
    pool: {} as never,
    repository: repository as ManagedSelfLeaveRepository,
    boundary,
    client,
    issueActorToken,
  };
  const input = {
    tenantId: f.identity.tenantId,
    actorUserId: f.identity.userId,
    tenantKey: 'iSkq6G',
    sessionId: '77777777-7777-4777-8777-777777777777',
    correlationId: 'synthetic-correlation',
    gameId: f.request.target.id,
    idempotencyKey: a.idempotencyKey,
    requestHash: 'a'.repeat(64),
  };
  return {
    a,
    repository,
    client,
    boundary,
    issueActorToken,
    options,
    input,
    runtime: createManagedSelfLeaveRuntime(options),
  };
}
describe('managed SELF leave runtime orchestration', () => {
  it('fences first dispatch before any actor credential/POST, returns UNKNOWN not success', async () => {
    const x = setup();
    x.repository.readByKey.mockResolvedValueOnce(null as never);
    const r = await x.runtime.execute(x.input);
    expect(r?.operation.status).toBe('UNKNOWN');
    expect(x.repository.begin).toHaveBeenCalledOnce();
    expect(x.repository.claim.mock.invocationCallOrder[0]).toBeLessThan(
      x.issueActorToken.mock.invocationCallOrder[0]!,
    );
    expect(x.boundary.delegationIssuer.issueManagedSelfLeaveAdmission).toHaveBeenCalledWith(
      expect.not.objectContaining({ recoveryOnly: true }),
    );
    expect(x.repository.finalize).not.toHaveBeenCalled();
  });
  it('retry reads original first then signs recovery_only using original body/key without new seat/begin', async () => {
    const x = setup('DISPATCH_STARTED');
    await x.runtime.execute(x.input);
    expect(x.repository.begin).not.toHaveBeenCalled();
    expect(x.client.read.mock.invocationCallOrder[0]).toBeLessThan(
      x.client.admit.mock.invocationCallOrder[0]!,
    );
    expect(x.boundary.delegationIssuer.issueManagedSelfLeaveAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        recoveryOnly: true,
        request: f.request,
        idempotencyKey: x.a.idempotencyKey,
      }),
    );
  });
  it('lost ACK uses read receipt for exact local finalize without another POST', async () => {
    const x = setup('DISPATCH_STARTED');
    x.client.read.mockResolvedValueOnce(f.confirmed);
    expect((await x.runtime.execute(x.input))?.operation.status).toBe('SUCCEEDED');
    expect(x.repository.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ receipt: f.confirmed.receipt }),
    );
    expect(x.client.admit).not.toHaveBeenCalled();
    expect(x.issueActorToken).not.toHaveBeenCalled();
  });
  it('completed local replay survives disabled flag and current mapping drift without external calls', async () => {
    const x = setup('COMPLETED');
    const runtime = createManagedSelfLeaveRuntime({
      ...x.options,
      config: { ...x.options.config, GAME_MANAGED_SELF_LEAVE_ENABLED: false },
    });
    expect((await runtime.execute(x.input))?.operation.status).toBe('SUCCEEDED');
    expect(x.boundary.actorContextRepository.resolve).not.toHaveBeenCalled();
    expect(x.client.read).not.toHaveBeenCalled();
  });
  it('GET and original-key GET are local read-only even for unfinished operations', async () => {
    const x = setup('DISPATCH_STARTED');
    await x.runtime.read({ ...x.input, operationId: x.a.authority.operationId });
    await x.runtime.readByKey(x.input);
    expect(x.client.read).not.toHaveBeenCalled();
    expect(x.repository.finalize).not.toHaveBeenCalled();
    expect(x.repository.claim).not.toHaveBeenCalled();
  });
  it.each(['mapping', 'lease', 'timeout', 'missingOwner'])(
    'fails closed without replacement for %s',
    async (kind) => {
      const x = setup('DISPATCH_STARTED');
      if (kind === 'mapping')
        x.boundary.actorContextRepository.resolve.mockResolvedValueOnce({
          outcome: 'ok',
          providerClientId: 'other',
          providerMappingId: f.originalJoinReceipt.providerMappingId,
        });
      if (kind === 'lease') x.repository.claim.mockResolvedValueOnce(null as never);
      if (kind === 'timeout') x.client.read.mockRejectedValueOnce(new TypeError('timeout'));
      const r = await x.runtime.execute(x.input);
      expect(r?.operation.status).toBe('UNKNOWN');
      expect(x.repository.begin).not.toHaveBeenCalled();
      expect(x.repository.finalize).not.toHaveBeenCalled();
      if (kind !== 'missingOwner') expect(x.client.admit).not.toHaveBeenCalled();
    },
  );
  it('public operation contains no provider receipt, mapping or usage identifiers', () => {
    const x = setup();
    expect(managedSelfLeaveBody(x.a).operation.nextAction).toEqual({
      type: 'WAIT_FOR_RECONCILIATION',
      retryAfterSeconds: 15,
    });
    expect(managedSelfLeaveBody({ ...x.a, state: 'COMPLETED' }).operation.nextAction).toEqual({
      type: 'NONE',
    });
    const body = JSON.stringify(managedSelfLeaveBody(x.a));
    for (const secret of [
      f.originalJoinReceipt.providerClientId,
      f.originalJoinReceipt.bookingId,
      f.originalJoinReceipt.entitlement.usageRef.usageRef,
      x.a.idempotencyKey,
    ])
      expect(body).not.toContain(secret);
  });
});

it('NO_PAYMENT reaches ordinary writer without Viva mapping even with managed gate enabled', async () => {
  const x = setup();
  x.repository.readByKey.mockResolvedValue(null as never);
  x.repository.isNoPayment.mockResolvedValue(true);
  expect(await x.runtime.execute(x.input)).toBeNull();
  expect(x.boundary.actorContextRepository.resolve).not.toHaveBeenCalled();
  expect(x.repository.begin).not.toHaveBeenCalled();
  expect(x.client.admit).not.toHaveBeenCalled();
});
it('reconciliation of an original PREPARED attempt never claims or first-dispatches it', async () => {
  const x = setup();
  expect((await x.runtime.reconcile(x.input)).operation.status).toBe('UNKNOWN');
  expect(x.repository.begin).not.toHaveBeenCalled();
  expect(x.repository.claim).not.toHaveBeenCalled();
  expect(x.client.admit).not.toHaveBeenCalled();
});
it('missing canonical attempt after reconciliation cannot fall through to a new begin', async () => {
  const x = setup();
  x.repository.readByKey.mockResolvedValue(null as never);
  await expect(x.runtime.reconcile(x.input)).rejects.toThrow('GAME_NOT_LEAVABLE');
  expect(x.repository.begin).not.toHaveBeenCalled();
  expect(x.client.admit).not.toHaveBeenCalled();
});
it('reconciliation of an original DISPATCH_STARTED attempt only signs recoveryOnly', async () => {
  const x = setup('DISPATCH_STARTED');
  await x.runtime.reconcile(x.input);
  expect(x.repository.begin).not.toHaveBeenCalled();
  expect(x.boundary.delegationIssuer.issueManagedSelfLeaveAdmission).toHaveBeenCalledWith(
    expect.objectContaining({ recoveryOnly: true }),
  );
});
it('durable refusal and ordinary success read by key need no provider mapping or new mutation', async () => {
  for (const kind of ['NOT_DISPATCHED', 'APPLIED'] as const) {
    const x = setup();
    x.repository.readByKey.mockResolvedValue(null as never);
    x.repository.readCommand.mockResolvedValue({
      kind,
      commandId: f.identity.operationId,
      gameId: x.input.gameId,
      revision: 2,
      createdAt: x.a.createdAt,
      completedAt: x.a.updatedAt,
      idempotencyKeySha256: 'sha256:' + 'a'.repeat(64),
    } as never);
    const result = await x.runtime.readByKey(x.input);
    expect(result?.operation.status).toBe(kind === 'APPLIED' ? 'SUCCEEDED' : 'FAILED');
    expect(Boolean(result?.operation.noDispatch)).toBe(kind === 'NOT_DISPATCHED');
    await x.runtime.execute(x.input);
    expect(x.repository.begin).not.toHaveBeenCalled();
    expect(x.boundary.actorContextRepository.resolve).not.toHaveBeenCalled();
    expect(x.client.admit).not.toHaveBeenCalled();
  }
});
