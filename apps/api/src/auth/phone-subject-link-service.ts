import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  IdentityProviderError,
  normalizePhoneE164,
  type IdentityProviderPort,
  type VerifiedExternalIdentity,
} from '@phub/auth';
import type { AppConfig } from '@phub/config';
import type { PhoneSubjectLinkRepository, SubjectLinkCommandIdentity } from '@phub/database';

import { AuthServiceError, type AuthRepository, type TenantAuthBinding } from './auth-service.js';
import {
  SUBJECT_LINK_PURPOSE,
  type SubjectLinkChallenge,
  type SubjectLinkChallengeStore,
} from './subject-link-challenge-store.js';

const OTP_PATTERN = /^\d{4}$/;
const TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

export interface PhoneSubjectLinkServiceOptions {
  readonly config: AppConfig;
  readonly repository: PhoneSubjectLinkRepository;
  readonly authRepository: Pick<AuthRepository, 'resolveTenantAuthBinding'>;
  readonly challengeStore: SubjectLinkChallengeStore;
  readonly vivaProvider: IdentityProviderPort;
  readonly now?: () => Date;
}

export interface PhoneSubjectLinkActor {
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly audience: 'client';
}

function sameDigest(left: string, right: string): boolean {
  return (
    /^[0-9a-f]{64}$/.test(left) &&
    /^[0-9a-f]{64}$/.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
  );
}

export class PhoneSubjectLinkService {
  private readonly now: () => Date;

  public constructor(private readonly options: PhoneSubjectLinkServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private enabled(): void {
    if (!this.options.config.AUTH_PHONE_SUBJECT_LINK_ENABLED) {
      throw new AuthServiceError('AUTH_SUBJECT_LINK_DISABLED');
    }
    if (
      this.options.vivaProvider.key !== 'VIVA' ||
      (this.options.config.VIVA_MODE !== 'sandbox' &&
        this.options.config.VIVA_MODE !== 'production')
    ) {
      throw new AuthServiceError('AUTH_PROVIDER_UNAVAILABLE');
    }
  }

  private hmac(label: string, values: readonly string[]): string {
    const hmac = createHmac('sha256', this.options.config.JWT_REFRESH_SECRET).update(label);
    for (const value of values) hmac.update('\0').update(value);
    return hmac.digest('hex');
  }

  private uuid(label: string, values: readonly string[]): string {
    const bytes = Buffer.from(this.hmac(label, values), 'hex').subarray(0, 16);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  private phoneHash(phoneE164: string): string {
    return this.hmac('auth-subject-link-phone', [phoneE164]);
  }

  private async binding(actor: PhoneSubjectLinkActor): Promise<TenantAuthBinding> {
    if (!TENANT_KEY_PATTERN.test(actor.tenantKey)) throw new AuthServiceError('TENANT_KEY_INVALID');
    const binding = await this.options.authRepository.resolveTenantAuthBinding(actor.tenantKey);
    if (!binding) throw new AuthServiceError('TENANT_NOT_FOUND');
    if (binding.tenantId !== actor.tenantId || binding.provider !== 'VIVA') {
      throw new AuthServiceError('AUTH_SUBJECT_LINK_UNAVAILABLE');
    }
    return binding;
  }

  private commandIdentity(input: {
    readonly actor: PhoneSubjectLinkActor;
    readonly familyId: string;
    readonly challengeId: string;
    readonly idempotencyKey: string;
  }): SubjectLinkCommandIdentity {
    const common = [
      SUBJECT_LINK_PURPOSE,
      input.actor.tenantId,
      input.actor.userId,
      input.familyId,
      input.actor.audience,
    ];
    return {
      tenantId: input.actor.tenantId,
      actorUserId: input.actor.userId,
      sessionFamilyId: input.familyId,
      audience: input.actor.audience,
      challengeId: input.challengeId,
      commandKeyHash: this.hmac('auth-subject-link-command-key', [...common, input.idempotencyKey]),
      requestHash: this.hmac('auth-subject-link-request', [...common, input.challengeId]),
    };
  }

  private mapProviderError(error: unknown): never {
    if (error instanceof IdentityProviderError) throw new AuthServiceError(error.code);
    throw new AuthServiceError('AUTH_PROVIDER_UNAVAILABLE');
  }

  public async start(input: {
    readonly actor: PhoneSubjectLinkActor;
    readonly phone: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<{
    readonly challengeId: string;
    readonly expiresAt: string;
    readonly resendAfterSeconds: number;
  }> {
    this.enabled();
    const phoneE164 = normalizePhoneE164(input.phone);
    if (!phoneE164) throw new AuthServiceError('AUTH_PHONE_INVALID');
    const [binding, session] = await Promise.all([
      this.binding(input.actor),
      this.options.repository.readSessionContext({
        tenantId: input.actor.tenantId,
        actorUserId: input.actor.userId,
        presentedSessionId: input.actor.sessionId,
      }),
    ]);
    if (!session) throw new AuthServiceError('AUTH_SESSION_REVOKED');
    if (!session.phoneE164 || session.phoneE164 !== phoneE164) {
      throw new AuthServiceError('AUTH_SUBJECT_LINK_UNAVAILABLE');
    }

    const challengeId = this.uuid('auth-subject-link-challenge', [
      input.actor.tenantId,
      input.actor.userId,
      session.familyId,
      input.idempotencyKey,
    ]);
    const current = await this.options.challengeStore.get(challengeId);
    const now = this.now();
    if (current) {
      if (
        current.tenantId !== input.actor.tenantId ||
        current.actorUserId !== input.actor.userId ||
        current.sessionFamilyId !== session.familyId ||
        current.providerTenantKey !== binding.providerTenantKey ||
        !sameDigest(current.phoneHash, this.phoneHash(phoneE164))
      ) {
        throw new AuthServiceError('IDEMPOTENCY_KEY_CONFLICT');
      }
      return {
        challengeId: current.id,
        expiresAt: current.expiresAt,
        resendAfterSeconds: Math.max(
          0,
          Math.ceil((Date.parse(current.resendAt) - now.getTime()) / 1000),
        ),
      };
    }

    const challenge: SubjectLinkChallenge = {
      id: challengeId,
      purpose: SUBJECT_LINK_PURPOSE,
      tenantId: input.actor.tenantId,
      tenantKey: binding.tenantKey,
      actorUserId: input.actor.userId,
      sessionFamilyId: session.familyId,
      audience: input.actor.audience,
      provider: 'VIVA',
      providerTenantKey: binding.providerTenantKey,
      phoneHash: this.phoneHash(phoneE164),
      attempts: 0,
      expiresAt: new Date(
        now.getTime() + this.options.config.AUTH_CHALLENGE_TTL_SECONDS * 1000,
      ).toISOString(),
      resendAt: new Date(
        now.getTime() + this.options.config.AUTH_CHALLENGE_RESEND_SECONDS * 1000,
      ).toISOString(),
    };
    const reserved = await this.options.challengeStore.put(
      challenge,
      this.options.config.AUTH_CHALLENGE_TTL_SECONDS,
      this.options.config.AUTH_CHALLENGE_RESEND_SECONDS,
    );
    if (!reserved) throw new AuthServiceError('AUTH_RATE_LIMITED');

    try {
      await this.options.vivaProvider.requestPhoneCode({
        phoneE164,
        providerTenantKey: binding.providerTenantKey,
        correlationId: input.correlationId,
      });
    } catch (error) {
      // The provider may have accepted an SMS before the response was lost. Preserve the challenge
      // and cooldown so retrying the same command never sends a second code automatically.
      this.mapProviderError(error);
    }
    return {
      challengeId,
      expiresAt: challenge.expiresAt,
      resendAfterSeconds: this.options.config.AUTH_CHALLENGE_RESEND_SECONDS,
    };
  }

  public async verify(input: {
    readonly actor: PhoneSubjectLinkActor;
    readonly challengeId: string;
    readonly code: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<{ readonly status: 'linked' | 'unchanged' }> {
    this.enabled();
    if (!OTP_PATTERN.test(input.code)) throw new AuthServiceError('AUTH_CODE_INVALID');
    const session = await this.options.repository.readSessionContext({
      tenantId: input.actor.tenantId,
      actorUserId: input.actor.userId,
      presentedSessionId: input.actor.sessionId,
    });
    if (!session) throw new AuthServiceError('AUTH_SESSION_REVOKED');
    const command = this.commandIdentity({
      actor: input.actor,
      familyId: session.familyId,
      challengeId: input.challengeId,
      idempotencyKey: input.idempotencyKey,
    });
    const receipt = await this.options.repository.inspectCommand(command);
    if (receipt.outcome === 'replayed') {
      return { status: receipt.result === 'LINKED' ? 'linked' : 'unchanged' };
    }
    if (receipt.outcome !== 'missing') throw new AuthServiceError('IDEMPOTENCY_KEY_CONFLICT');
    if (!session.phoneE164) throw new AuthServiceError('AUTH_SUBJECT_LINK_UNAVAILABLE');

    const [binding, challenge] = await Promise.all([
      this.binding(input.actor),
      this.options.challengeStore.get(input.challengeId),
    ]);
    if (
      !challenge ||
      challenge.purpose !== SUBJECT_LINK_PURPOSE ||
      challenge.tenantId !== input.actor.tenantId ||
      challenge.tenantKey !== input.actor.tenantKey ||
      challenge.actorUserId !== input.actor.userId ||
      challenge.sessionFamilyId !== session.familyId ||
      challenge.audience !== input.actor.audience ||
      challenge.provider !== 'VIVA' ||
      challenge.providerTenantKey !== binding.providerTenantKey
    ) {
      throw new AuthServiceError('AUTH_CODE_EXPIRED');
    }
    if (
      Date.parse(challenge.expiresAt) <= this.now().getTime() ||
      challenge.attempts >= this.options.config.AUTH_CHALLENGE_MAX_ATTEMPTS
    ) {
      await this.options.challengeStore.delete(challenge.id);
      throw new AuthServiceError('AUTH_CODE_EXPIRED');
    }
    if (!sameDigest(challenge.phoneHash, this.phoneHash(session.phoneE164))) {
      await this.options.challengeStore.delete(challenge.id);
      throw new AuthServiceError('AUTH_SUBJECT_LINK_UNAVAILABLE');
    }

    const claimId = randomUUID();
    if (!(await this.options.challengeStore.claim(challenge.id, claimId, 30))) {
      throw new AuthServiceError('AUTH_CHALLENGE_IN_PROGRESS');
    }

    let identity: VerifiedExternalIdentity;
    try {
      const verification = await this.options.vivaProvider.verifyPhoneCode({
        phoneE164: session.phoneE164,
        code: input.code,
        providerTenantKey: challenge.providerTenantKey,
        correlationId: input.correlationId,
      });
      identity = 'identity' in verification ? verification.identity : verification;
      if (
        normalizePhoneE164(identity.phoneE164 ?? '') !== session.phoneE164 ||
        !identity.issuer ||
        !identity.subject
      ) {
        throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
      }
    } catch (error) {
      if (error instanceof IdentityProviderError && error.code === 'AUTH_CODE_INVALID') {
        const attempts = await this.options.challengeStore.incrementAttempts(challenge.id);
        if (attempts !== undefined && attempts >= this.options.config.AUTH_CHALLENGE_MAX_ATTEMPTS) {
          await this.options.challengeStore.delete(challenge.id);
        } else {
          await this.options.challengeStore.release(challenge.id, claimId);
        }
      } else {
        await this.options.challengeStore.release(challenge.id, claimId);
      }
      this.mapProviderError(error);
    }

    const completed = await this.options.repository.completeCommand({
      ...command,
      presentedSessionId: input.actor.sessionId,
      phoneE164: session.phoneE164,
      issuer: identity.issuer,
      subject: identity.subject,
      correlationId: input.correlationId,
    });
    if (completed.outcome === 'conflict' || completed.outcome === 'challenge_used') {
      await this.options.challengeStore.release(challenge.id, claimId);
      throw new AuthServiceError('IDEMPOTENCY_KEY_CONFLICT');
    }
    if (completed.outcome === 'invalid_session') {
      await this.options.challengeStore.delete(challenge.id);
      throw new AuthServiceError('AUTH_SESSION_REVOKED');
    }
    if (completed.outcome === 'phone_drift') {
      await this.options.challengeStore.delete(challenge.id);
      throw new AuthServiceError('AUTH_SUBJECT_LINK_UNAVAILABLE');
    }
    if (completed.outcome === 'foreign_subject') {
      await this.options.challengeStore.delete(challenge.id);
      throw new AuthServiceError('AUTH_IDENTITY_CONFLICT');
    }
    if (!('result' in completed)) throw new AuthServiceError('AUTH_PROVIDER_UNAVAILABLE');

    try {
      await this.options.challengeStore.delete(challenge.id);
    } catch {
      // The durable receipt is authoritative. Redis cleanup cannot turn a committed link into an
      // error; the same command key replays without consulting Redis or the provider.
    }
    return { status: completed.result === 'LINKED' ? 'linked' : 'unchanged' };
  }
}
