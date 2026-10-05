import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { LocalPasswordResetRepository } from '@phub/database/password-reset';

import {
  hashLocalPassword,
  normalizeLoginEmail,
  reservePasswordLoginSlot,
  validLocalPassword,
  verifyLocalPassword,
} from './local-password.js';
import type { PasswordLoginLimiter } from './password-login-limiter.js';

/** Narrow trusted server transport. Acceptance is not proof: only returning the random token is. */
export interface PasswordResetEmailSender {
  send(
    this: void,
    input: {
      readonly emailKey: string;
      readonly proofId: string;
      readonly resetToken: string;
      readonly idempotencyKey: string;
      readonly expiresInSeconds: 600;
      readonly signal: AbortSignal;
    },
  ): Promise<'accepted'>;
}
export class PasswordResetError extends Error {
  constructor(
    readonly code:
      | 'AUTH_RECOVERY_INVALID'
      | 'AUTH_RECOVERY_UNAVAILABLE'
      | 'AUTH_RECOVERY_LIMITED'
      | 'AUTH_PASSWORD_POLICY_INVALID',
  ) {
    super(code);
  }
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const opaqueKey = /^[A-Za-z0-9._:-]{8,128}$/;
function commandKeyHash(tenantId: string, key: string): string {
  if (!uuid.test(tenantId) || !opaqueKey.test(key))
    throw new PasswordResetError('AUTH_RECOVERY_INVALID');
  return digest(JSON.stringify(['LOCAL_PASSWORD_RESET_V1', tenantId, key]));
}

/** Internal only until a reviewed sender, enrollment and public recovery contract exist. */
export class LocalPasswordResetService {
  constructor(
    private readonly options: {
      readonly repository: LocalPasswordResetRepository;
      readonly limiter: PasswordLoginLimiter;
      readonly sender?: PasswordResetEmailSender;
    },
  ) {}

  async start(input: {
    readonly tenantId: string;
    readonly email: string;
    readonly idempotencyKey: string;
    readonly ip: string;
  }): Promise<{ proofId: string; expiresInSeconds: 600 }> {
    if (!this.options.sender) throw new PasswordResetError('AUTH_RECOVERY_UNAVAILABLE');
    const emailKey = normalizeLoginEmail(input.email);
    if (!emailKey) throw new PasswordResetError('AUTH_RECOVERY_INVALID');
    const key = commandKeyHash(input.tenantId, input.idempotencyKey);
    let release: (() => void) | undefined;
    try {
      release = reservePasswordLoginSlot();
      if (!(await this.options.limiter.allow(input.tenantId, emailKey, input.ip)))
        throw new PasswordResetError('AUTH_RECOVERY_LIMITED');
      const proofId = randomUUID();
      const resetToken = randomBytes(32).toString('base64url');
      const command = {
        tenantId: input.tenantId,
        proofId,
        tokenHash: digest(resetToken),
        commandKeyHash: key,
      };
      const prepared = await this.options.repository.prepare({ ...command, emailKey });
      // Never return recipient, UUID, credential state or the code to the requesting client.
      if (prepared.outcome !== 'prepared') return { proofId, expiresInSeconds: 600 };
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          this.options.sender.send({
            emailKey: prepared.emailKey,
            proofId,
            resetToken,
            idempotencyKey: input.idempotencyKey,
            expiresInSeconds: 600,
            signal: controller.signal,
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new PasswordResetError('AUTH_RECOVERY_UNAVAILABLE'));
            }, 5000);
            timer.unref();
          }),
        ]);
        if (result !== 'accepted' || !(await this.options.repository.activate(command)))
          throw new PasswordResetError('AUTH_RECOVERY_UNAVAILABLE');
      } catch {
        // Ambiguous delivery is never retried: a possibly delivered unconsumed code remains unusable.
        await this.options.repository.cancel(command);
        throw new PasswordResetError('AUTH_RECOVERY_UNAVAILABLE');
      } finally {
        if (timer) clearTimeout(timer);
      }
      return { proofId, expiresInSeconds: 600 };
    } catch (error) {
      if (error instanceof PasswordResetError) throw error;
      throw new PasswordResetError('AUTH_RECOVERY_UNAVAILABLE');
    } finally {
      release?.();
    }
  }

  async complete(input: {
    readonly tenantId: string;
    readonly proofId: string;
    readonly resetToken: string;
    readonly idempotencyKey: string;
    readonly newPassword: string;
    readonly correlationId: string;
    readonly ip: string;
  }): Promise<void> {
    const key = commandKeyHash(input.tenantId, input.idempotencyKey);
    if (
      !uuid.test(input.proofId) ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.resetToken) ||
      Buffer.from(input.resetToken, 'base64url').toString('base64url') !== input.resetToken ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(input.correlationId)
    )
      throw new PasswordResetError('AUTH_RECOVERY_INVALID');
    if (!validLocalPassword(input.newPassword))
      throw new PasswordResetError('AUTH_PASSWORD_POLICY_INVALID');
    const command = {
      tenantId: input.tenantId,
      proofId: input.proofId,
      tokenHash: digest(input.resetToken),
      commandKeyHash: key,
    };
    let release: (() => void) | undefined;
    try {
      release = reservePasswordLoginSlot();
      // Independent from email issuance; keys contain only the high-entropy public proof UUID.
      if (!(await this.options.limiter.allow(input.tenantId, input.proofId, input.ip)))
        throw new PasswordResetError('AUTH_RECOVERY_LIMITED');
      for (let attempt = 0; attempt < 2; attempt++) {
        const snapshot = await this.options.repository.inspect(command);
        if (!snapshot) throw new PasswordResetError('AUTH_RECOVERY_INVALID');
        let newPasswordHash: string | undefined;
        if (snapshot.consumed) {
          if (!(await verifyLocalPassword(input.newPassword, snapshot.passwordHash)))
            throw new PasswordResetError('AUTH_RECOVERY_INVALID');
        } else newPasswordHash = await hashLocalPassword(input.newPassword);
        const result = await this.options.repository.commit({
          ...command,
          snapshot,
          correlationId: input.correlationId,
          ...(newPasswordHash ? { newPasswordHash } : {}),
        });
        if (result === 'changed' || result === 'replayed') return;
        if (result !== 'retry') throw new PasswordResetError('AUTH_RECOVERY_INVALID');
      }
      throw new PasswordResetError('AUTH_RECOVERY_INVALID');
    } catch (error) {
      if (error instanceof PasswordResetError) throw error;
      throw new PasswordResetError('AUTH_RECOVERY_UNAVAILABLE');
    } finally {
      release?.();
    }
  }
}
