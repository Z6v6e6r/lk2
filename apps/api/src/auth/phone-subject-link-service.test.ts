import { IdentityProviderError, type IdentityProviderPort } from '@phub/auth';
import { loadConfig } from '@phub/config';
import type {
  PhoneSubjectLinkRepository,
  SubjectLinkCommandIdentity,
  SubjectLinkCommandInspection,
  SubjectLinkCommandResult,
  SubjectLinkSessionContext,
} from '@phub/database';
import { describe, expect, it } from 'vitest';

import type { AuthRepository, TenantAuthBinding } from './auth-service.js';
import { PhoneSubjectLinkService } from './phone-subject-link-service.js';
import {
  MemorySubjectLinkChallengeStore,
  type SubjectLinkChallengeStore,
} from './subject-link-challenge-store.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const sessionId = '108966ea-d0a3-4b95-b4fc-d0239f351e70';
const familyId = '1a42b12e-b102-4373-a514-3a1ab5451203';
const phone = '+79990000001';
const binding: TenantAuthBinding = {
  tenantId,
  tenantKey: 'local-padel',
  provider: 'VIVA',
  providerTenantKey: 'iSkq6G',
};
const actor = {
  tenantId,
  tenantKey: binding.tenantKey,
  userId,
  sessionId,
  audience: 'client' as const,
};

function config(enabled = true) {
  return loadConfig({
    APP_ENV: 'ci',
    DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
    REDIS_URL: 'redis://localhost:6379',
    RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
    JWT_ISSUER: 'phub-identity',
    JWT_AUDIENCE: 'phub-api',
    JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
    JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
    VIVA_MODE: 'sandbox',
    AUTH_PHONE_SUBJECT_LINK_ENABLED: String(enabled),
  });
}

class FakeSubjectLinkRepository implements PhoneSubjectLinkRepository {
  public session: SubjectLinkSessionContext | undefined = { familyId, phoneE164: phone };
  public completeOverride: SubjectLinkCommandResult | undefined;
  public completeCalls = 0;
  private readonly byKey = new Map<
    string,
    { readonly identity: SubjectLinkCommandIdentity; readonly result: 'LINKED' | 'UNCHANGED' }
  >();
  private readonly byChallenge = new Set<string>();

  public readSessionContext(): Promise<SubjectLinkSessionContext | undefined> {
    return Promise.resolve(this.session);
  }

  public inspectCommand(input: SubjectLinkCommandIdentity): Promise<SubjectLinkCommandInspection> {
    const existing = this.byKey.get(input.commandKeyHash);
    if (existing) {
      return Promise.resolve(
        existing.identity.requestHash === input.requestHash &&
          existing.identity.challengeId === input.challengeId
          ? { outcome: 'replayed', result: existing.result }
          : { outcome: 'conflict' },
      );
    }
    return Promise.resolve(
      this.byChallenge.has(input.challengeId)
        ? { outcome: 'challenge_used' }
        : { outcome: 'missing' },
    );
  }

  public completeCommand(input: SubjectLinkCommandIdentity): Promise<SubjectLinkCommandResult> {
    this.completeCalls += 1;
    if (this.completeOverride) return Promise.resolve(this.completeOverride);
    const result = 'LINKED' as const;
    this.byKey.set(input.commandKeyHash, { identity: input, result });
    this.byChallenge.add(input.challengeId);
    return Promise.resolve({ outcome: 'completed', result });
  }
}

class FakeProvider implements IdentityProviderPort {
  public readonly key = 'VIVA' as const;
  public requests = 0;
  public verifications = 0;
  public requestError: Error | undefined;
  public verifyError: Error | undefined;
  public verifiedPhone = phone;

  public requestPhoneCode(): Promise<void> {
    this.requests += 1;
    return this.requestError ? Promise.reject(this.requestError) : Promise.resolve();
  }

  public verifyPhoneCode() {
    this.verifications += 1;
    if (this.verifyError) return Promise.reject(this.verifyError);
    return Promise.resolve({
      issuer: 'https://kc.vivacrm.test/realms/clients',
      subject: 'provider-subject',
      phoneE164: this.verifiedPhone,
      displayName: 'Verified user',
    });
  }
}

function createFixture(
  input: {
    readonly enabled?: boolean;
    readonly store?: SubjectLinkChallengeStore;
  } = {},
) {
  const repository = new FakeSubjectLinkRepository();
  const provider = new FakeProvider();
  const authRepository = {
    resolveTenantAuthBinding: () => Promise.resolve(binding),
  } satisfies Pick<AuthRepository, 'resolveTenantAuthBinding'>;
  const store = input.store ?? new MemorySubjectLinkChallengeStore();
  const service = new PhoneSubjectLinkService({
    config: config(input.enabled ?? true),
    repository,
    authRepository,
    challengeStore: store,
    vivaProvider: provider,
    now: () => new Date('2026-10-26T12:00:00.000Z'),
  });
  return { service, repository, provider, store };
}

async function start(service: PhoneSubjectLinkService, idempotencyKey = 'start-command-0001') {
  return service.start({ actor, phone, idempotencyKey, correlationId: 'correlation-start-0001' });
}

describe('PhoneSubjectLinkService', () => {
  it('fails closed while the runtime flag is off', async () => {
    const { service, provider } = createFixture({ enabled: false });
    await expect(start(service)).rejects.toMatchObject({
      code: 'AUTH_SUBJECT_LINK_DISABLED',
    });
    expect(provider.requests).toBe(0);
  });

  it('requires the supplied phone to equal the active account phone before SMS', async () => {
    const { service, provider } = createFixture();
    await expect(
      service.start({
        actor,
        phone: '+79990000002',
        idempotencyKey: 'start-command-0001',
        correlationId: 'correlation-start-0001',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_SUBJECT_LINK_UNAVAILABLE' });
    expect(provider.requests).toBe(0);
  });

  it('returns the same generic unavailable class when the active account has no canonical phone', async () => {
    const { service, repository, provider } = createFixture();
    repository.session = { familyId };
    await expect(start(service)).rejects.toMatchObject({
      code: 'AUTH_SUBJECT_LINK_UNAVAILABLE',
    });
    expect(provider.requests).toBe(0);
  });

  it('keeps an ambiguous SMS challenge and does not call the provider on same-key retry', async () => {
    const { service, provider } = createFixture();
    provider.requestError = new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    await expect(start(service)).rejects.toMatchObject({
      code: 'AUTH_PROVIDER_UNAVAILABLE',
    });
    provider.requestError = undefined;
    const recovered = await start(service);
    expect(recovered.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(provider.requests).toBe(1);
  });

  it('completes once and durably replays after Redis cleanup failure without provider reuse', async () => {
    const memory = new MemorySubjectLinkChallengeStore();
    let failCleanup = true;
    const store: SubjectLinkChallengeStore = {
      put: memory.put.bind(memory),
      get: memory.get.bind(memory),
      claim: memory.claim.bind(memory),
      release: memory.release.bind(memory),
      incrementAttempts: memory.incrementAttempts.bind(memory),
      delete: async (challengeId) => {
        if (failCleanup) {
          failCleanup = false;
          throw new Error('redis unavailable');
        }
        await memory.delete(challengeId);
      },
    };
    const { service, repository, provider } = createFixture({ store });
    const challenge = await start(service);
    await expect(
      service.verify({
        actor,
        challengeId: challenge.challengeId,
        code: '1234',
        idempotencyKey: 'verify-command-0001',
        correlationId: 'correlation-verify-0001',
      }),
    ).resolves.toEqual({ status: 'linked' });
    repository.session = { familyId };
    await expect(
      service.verify({
        actor,
        challengeId: challenge.challengeId,
        code: '1234',
        idempotencyKey: 'verify-command-0001',
        correlationId: 'correlation-verify-0002',
      }),
    ).resolves.toEqual({ status: 'linked' });
    expect(provider.verifications).toBe(1);
    expect(repository.completeCalls).toBe(1);
  });

  it('rejects an alternate key for a challenge already consumed by a durable receipt', async () => {
    const { service, provider } = createFixture();
    const challenge = await start(service);
    await service.verify({
      actor,
      challengeId: challenge.challengeId,
      code: '1234',
      idempotencyKey: 'verify-command-0001',
      correlationId: 'correlation-verify-0001',
    });
    await expect(
      service.verify({
        actor,
        challengeId: challenge.challengeId,
        code: '1234',
        idempotencyKey: 'verify-command-0002',
        correlationId: 'correlation-verify-0002',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    expect(provider.verifications).toBe(1);
  });

  it('rejects session-family drift before provider verification', async () => {
    const { service, repository, provider } = createFixture();
    const challenge = await start(service);
    repository.session = { familyId: 'a6d5cb38-9d1f-49be-b294-7bc1addb4420', phoneE164: phone };
    await expect(
      service.verify({
        actor,
        challengeId: challenge.challengeId,
        code: '1234',
        idempotencyKey: 'verify-command-0001',
        correlationId: 'correlation-verify-0001',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_CODE_EXPIRED' });
    expect(provider.verifications).toBe(0);
  });

  it('rejects an expired subject-link challenge before provider verification', async () => {
    const memory = new MemorySubjectLinkChallengeStore();
    const { service, provider } = createFixture({ store: memory });
    const challenge = await start(service);
    const stored = await memory.get(challenge.challengeId);
    if (!stored) throw new Error('challenge missing');
    await memory.delete(stored.id);
    await memory.put({ ...stored, expiresAt: '2026-10-26T11:59:59.000Z' }, 60, 30);
    await expect(
      service.verify({
        actor,
        challengeId: challenge.challengeId,
        code: '1234',
        idempotencyKey: 'verify-command-0001',
        correlationId: 'correlation-verify-0001',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_CODE_EXPIRED' });
    expect(provider.verifications).toBe(0);
  });

  it('rejects a provider phone drift before any database command', async () => {
    const { service, repository, provider } = createFixture();
    const challenge = await start(service);
    provider.verifiedPhone = '+79990000002';
    await expect(
      service.verify({
        actor,
        challengeId: challenge.challengeId,
        code: '1234',
        idempotencyKey: 'verify-command-0001',
        correlationId: 'correlation-verify-0001',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
    expect(repository.completeCalls).toBe(0);
  });

  it('maps a foreign subject to a generic identity conflict', async () => {
    const { service, repository } = createFixture();
    const challenge = await start(service);
    repository.completeOverride = { outcome: 'foreign_subject' };
    await expect(
      service.verify({
        actor,
        challengeId: challenge.challengeId,
        code: '1234',
        idempotencyKey: 'verify-command-0001',
        correlationId: 'correlation-verify-0001',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_IDENTITY_CONFLICT' });
  });

  it('bounds wrong-code attempts and never writes a command', async () => {
    const { service, repository, provider } = createFixture();
    const challenge = await start(service);
    provider.verifyError = new IdentityProviderError('AUTH_CODE_INVALID');
    for (let attempt = 0; attempt < config().AUTH_CHALLENGE_MAX_ATTEMPTS; attempt += 1) {
      await expect(
        service.verify({
          actor,
          challengeId: challenge.challengeId,
          code: '0000',
          idempotencyKey: 'verify-command-0001',
          correlationId: `correlation-verify-000${attempt}`,
        }),
      ).rejects.toMatchObject({ code: 'AUTH_CODE_INVALID' });
    }
    await expect(
      service.verify({
        actor,
        challengeId: challenge.challengeId,
        code: '0000',
        idempotencyKey: 'verify-command-0001',
        correlationId: 'correlation-verify-exhausted',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_CODE_EXPIRED' });
    expect(repository.completeCalls).toBe(0);
  });

  it('stores only an HMAC binding, never the canonical phone', async () => {
    const { service, store } = createFixture();
    const challenge = await start(service);
    const stored = await store.get(challenge.challengeId);
    expect(JSON.stringify(stored)).not.toContain(phone);
    expect(stored?.phoneHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
