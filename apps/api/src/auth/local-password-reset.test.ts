import { createHash, randomUUID } from 'node:crypto';

import type {
  LocalPasswordResetRepository,
  PasswordResetSnapshot,
} from '@phub/database/password-reset';
import { describe, expect, it, vi } from 'vitest';

import { hashLocalPassword, reservePasswordLoginSlot } from './local-password.js';
import {
  LocalPasswordResetService,
  type PasswordResetEmailSender,
} from './local-password-reset.js';

const tenantId = randomUUID();
const proofId = randomUUID();
const key = 'synthetic-command-key';
const token = Buffer.alloc(32, 7).toString('base64url');
const password = 'synthetic new password 2026';
const complete = {
  tenantId,
  proofId,
  resetToken: token,
  idempotencyKey: key,
  newPassword: password,
  correlationId: 'synthetic-reset',
  ip: '192.0.2.1',
};
const snapshot: PasswordResetSnapshot = {
  credentialId: randomUUID(),
  userId: randomUUID(),
  generation: 1,
  passwordHash: 'unused original hash',
  consumed: false,
};
function setup() {
  const repository: LocalPasswordResetRepository = {
    prepare: vi.fn().mockResolvedValue({ outcome: 'prepared', emailKey: 'enrolled@example.test' }),
    activate: vi.fn().mockResolvedValue(true),
    cancel: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue(snapshot),
    commit: vi.fn().mockResolvedValue('changed'),
  };
  const limiter = { allow: vi.fn().mockResolvedValue(true) };
  const sender: PasswordResetEmailSender = { send: vi.fn().mockResolvedValue('accepted') };
  const service = new LocalPasswordResetService({ repository, limiter, sender });
  return { repository, limiter, sender, service };
}
const start = { tenantId, email: 'REQUESTED@example.test', idempotencyKey: key, ip: '192.0.2.1' };

describe('internal enrolled email password recovery', () => {
  it('fails closed without a configured trusted sender and never looks up an account', async () => {
    const { repository, limiter } = setup();
    const service = new LocalPasswordResetService({ repository, limiter });
    await expect(service.start(start)).rejects.toMatchObject({ code: 'AUTH_RECOVERY_UNAVAILABLE' });
    expect(repository.prepare).not.toHaveBeenCalled();
  });
  it('uses only the stored login binding recipient and hides raw token and account identity', async () => {
    const { service, sender, repository } = setup();
    const result = await service.start(start);
    const message = vi.mocked(sender.send).mock.calls[0]![0];
    const stored = vi.mocked(repository.prepare).mock.calls[0]![0];
    expect(message.emailKey).toBe('enrolled@example.test');
    expect(stored.emailKey).toBe('requested@example.test');
    expect(message.resetToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stored.tokenHash).toBe(createHash('sha256').update(message.resetToken).digest('hex'));
    expect(JSON.stringify(stored)).not.toContain(message.resetToken);
    expect(result).toEqual({ proofId: message.proofId, expiresInSeconds: 600 });
    expect(repository.activate).toHaveBeenCalledOnce();
  });
  it.each(['invalid', 'conflict', 'limited'] as const)(
    'keeps unknown/disabled, repeated and cooldown results neutral (%s)',
    async (outcome) => {
      const { service, sender, repository } = setup();
      vi.mocked(repository.prepare).mockResolvedValue({ outcome });
      expect(Object.keys(await service.start(start)).sort()).toEqual([
        'expiresInSeconds',
        'proofId',
      ]);
      expect(sender.send).not.toHaveBeenCalled();
      expect(repository.activate).not.toHaveBeenCalled();
    },
  );
  it('does not activate or retry an ambiguous email failure and redacts its details', async () => {
    const { service, sender, repository } = setup();
    vi.mocked(sender.send).mockRejectedValue(new Error('synthetic private transport payload'));
    await expect(service.start(start)).rejects.toMatchObject({
      message: 'AUTH_RECOVERY_UNAVAILABLE',
    });
    expect(sender.send).toHaveBeenCalledOnce();
    expect(repository.cancel).toHaveBeenCalledOnce();
    expect(repository.activate).not.toHaveBeenCalled();
  });
  it('aborts a stalled delivery at five seconds and cancels its pending proof', async () => {
    vi.useFakeTimers();
    try {
      const { service, sender, repository } = setup();
      vi.mocked(sender.send).mockImplementation(() => new Promise(() => {}));
      const assertion = expect(service.start(start)).rejects.toMatchObject({
        code: 'AUTH_RECOVERY_UNAVAILABLE',
      });
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
      expect(vi.mocked(sender.send).mock.calls[0]![0].signal.aborted).toBe(true);
      expect(repository.cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it('compensates when activation committed but its response was lost', async () => {
    const { service, repository } = setup();
    vi.mocked(repository.activate).mockRejectedValue(
      new Error('synthetic committed activation response lost'),
    );
    await expect(service.start(start)).rejects.toMatchObject({ code: 'AUTH_RECOVERY_UNAVAILABLE' });
    expect(repository.cancel).toHaveBeenCalledOnce();
    expect(vi.mocked(repository.cancel).mock.calls[0]![0]).toEqual(
      vi.mocked(repository.activate).mock.calls[0]![0],
    );
  });
  it('cancels an accepted message if proof activation loses its generation fence', async () => {
    const { service, repository } = setup();
    vi.mocked(repository.activate).mockResolvedValue(false);
    await expect(service.start(start)).rejects.toMatchObject({ code: 'AUTH_RECOVERY_UNAVAILABLE' });
    expect(repository.cancel).toHaveBeenCalledOnce();
  });
  it('rejects denied/unavailable admission before any proof lookup', async () => {
    const { service, limiter, repository } = setup();
    limiter.allow.mockResolvedValue(false);
    await expect(service.complete(complete)).rejects.toMatchObject({
      code: 'AUTH_RECOVERY_LIMITED',
    });
    limiter.allow.mockRejectedValue(new Error('synthetic redis payload'));
    await expect(service.complete(complete)).rejects.toMatchObject({
      message: 'AUTH_RECOVERY_UNAVAILABLE',
    });
    expect(repository.inspect).not.toHaveBeenCalled();
  });
  it('shares the existing whole-operation capacity without queueing and releases it', async () => {
    const { service, repository } = setup();
    const release1 = reservePasswordLoginSlot();
    const release2 = reservePasswordLoginSlot();
    try {
      await expect(service.complete(complete)).rejects.toMatchObject({
        code: 'AUTH_RECOVERY_UNAVAILABLE',
      });
      expect(repository.inspect).not.toHaveBeenCalled();
    } finally {
      release1();
      release2();
    }
    vi.mocked(repository.inspect).mockResolvedValue(undefined);
    await expect(service.complete(complete)).rejects.toMatchObject({
      code: 'AUTH_RECOVERY_INVALID',
    });
    expect(repository.inspect).toHaveBeenCalledOnce();
  });
  it('rejects invalid proof and password policy before credential mutation', async () => {
    const { service, repository } = setup();
    await expect(service.complete({ ...complete, resetToken: '123456' })).rejects.toMatchObject({
      code: 'AUTH_RECOVERY_INVALID',
    });
    await expect(service.complete({ ...complete, newPassword: 'short' })).rejects.toMatchObject({
      code: 'AUTH_PASSWORD_POLICY_INVALID',
    });
    vi.mocked(repository.inspect).mockResolvedValue(undefined);
    await expect(service.complete(complete)).rejects.toMatchObject({
      code: 'AUTH_RECOVERY_INVALID',
    });
    expect(repository.commit).not.toHaveBeenCalled();
  });
  it('recovers a lost response only with the same new password, without a second reset', async () => {
    const { service, repository } = setup();
    let current = snapshot;
    vi.mocked(repository.inspect).mockImplementation(() => Promise.resolve(current));
    vi.mocked(repository.commit).mockImplementation((input) => {
      if (input.newPasswordHash) {
        current = {
          ...snapshot,
          generation: 2,
          passwordHash: input.newPasswordHash,
          consumed: true,
        };
        throw new Error('synthetic committed but response lost');
      }
      return Promise.resolve('replayed');
    });
    await expect(service.complete(complete)).rejects.toMatchObject({
      code: 'AUTH_RECOVERY_UNAVAILABLE',
    });
    await service.complete(complete);
    expect(vi.mocked(repository.commit).mock.calls[1]![0].newPasswordHash).toBeUndefined();
    await expect(
      service.complete({ ...complete, newPassword: 'different valid password 2026' }),
    ).rejects.toMatchObject({ code: 'AUTH_RECOVERY_INVALID' });
    expect(repository.commit).toHaveBeenCalledTimes(2);
  });
  it('rechecks a concurrent first commit through the canonical credential hash', async () => {
    const { service, repository } = setup();
    const newHash = await hashLocalPassword(password);
    vi.mocked(repository.inspect)
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({ ...snapshot, generation: 2, passwordHash: newHash, consumed: true });
    vi.mocked(repository.commit).mockResolvedValueOnce('retry').mockResolvedValueOnce('replayed');
    await service.complete(complete);
    expect(repository.inspect).toHaveBeenCalledTimes(2);
    expect(vi.mocked(repository.commit).mock.calls[1]![0].newPasswordHash).toBeUndefined();
  });
  it('never retries an invalid or superseded proof as a new reset', async () => {
    const { service, repository } = setup();
    vi.mocked(repository.commit).mockResolvedValue('invalid');
    await expect(service.complete(complete)).rejects.toMatchObject({
      code: 'AUTH_RECOVERY_INVALID',
    });
    expect(repository.commit).toHaveBeenCalledOnce();
  });
});
