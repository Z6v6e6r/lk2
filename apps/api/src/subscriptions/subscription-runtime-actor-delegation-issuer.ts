import { createHash, createPrivateKey, randomUUID } from 'node:crypto';

import { importPKCS8, SignJWT } from 'jose';
import type { ManagedSubscriptionRuntimeV1QuoteRequest } from '@phub/subscription-runtime-adapter';

const actionSet = new Set(['CREATE_GAME', 'JOIN_GAME']);
const correlationPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;
const keyIdPattern = /^[A-Za-z0-9._:-]{3,64}$/;
const printableAsciiPattern = /^[!-~]+$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class SubscriptionRuntimeActorDelegationError extends Error {
  public constructor(
    public readonly code:
      | 'SUBSCRIPTION_RUNTIME_DELEGATION_CONFIGURATION_INVALID'
      | 'SUBSCRIPTION_RUNTIME_DELEGATION_INPUT_INVALID',
  ) {
    super(code);
  }
}

export function subscriptionRuntimeRequestSha256(
  input: ManagedSubscriptionRuntimeV1QuoteRequest,
): string {
  const canonical = {
    contractVersion: 1,
    action: input.action,
    target: {
      kind: input.target.kind,
      id: input.target.id,
      expectedRevision: input.target.expectedRevision ?? null,
    },
    preferredSubscriptionInstanceId: input.preferredSubscriptionInstanceId ?? null,
    paymentIntent: input.paymentIntent,
  };
  return `sha256:${createHash('sha256')
    .update(`subscription-runtime-quote:v1\0${JSON.stringify(canonical)}`, 'utf8')
    .digest('hex')}`;
}

export function subscriptionRuntimeIdempotencyKeySha256(key: string): string {
  return `sha256:${createHash('sha256').update(key, 'utf8').digest('hex')}`;
}

export class SubscriptionRuntimeActorDelegationIssuer {
  public constructor(
    private readonly options: {
      readonly privateKeyPem: string;
      readonly keyId: string;
      readonly issuer: string;
      readonly audience: string;
      readonly ttlSeconds: number;
    },
  ) {
    if (
      !options.privateKeyPem.includes('-----BEGIN PRIVATE KEY-----') ||
      !keyIdPattern.test(options.keyId) ||
      !printableAsciiPattern.test(options.issuer) ||
      options.issuer.length > 512 ||
      !printableAsciiPattern.test(options.audience) ||
      options.audience.length > 256 ||
      !Number.isInteger(options.ttlSeconds) ||
      options.ttlSeconds < 10 ||
      options.ttlSeconds > 60
    ) {
      throw new SubscriptionRuntimeActorDelegationError(
        'SUBSCRIPTION_RUNTIME_DELEGATION_CONFIGURATION_INVALID',
      );
    }
    try {
      const key = createPrivateKey(options.privateKeyPem);
      if (
        key.asymmetricKeyType !== 'rsa' ||
        (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      ) {
        throw new Error('RSA key is too small');
      }
    } catch {
      throw new SubscriptionRuntimeActorDelegationError(
        'SUBSCRIPTION_RUNTIME_DELEGATION_CONFIGURATION_INVALID',
      );
    }
  }

  async issue(input: {
    readonly userId: string;
    readonly tenantId: string;
    readonly tenantKey: string;
    readonly sessionId: string;
    readonly providerClientId: string;
    readonly providerMappingId: string;
    readonly action: 'CREATE_GAME' | 'JOIN_GAME';
    readonly correlationId: string;
    readonly request: ManagedSubscriptionRuntimeV1QuoteRequest;
    readonly idempotencyKey: string;
  }): Promise<string> {
    if (
      !actionSet.has(input.action) ||
      !uuidPattern.test(input.userId) ||
      !uuidPattern.test(input.tenantId) ||
      !uuidPattern.test(input.sessionId) ||
      !uuidPattern.test(input.providerMappingId) ||
      !idPattern.test(input.tenantKey) ||
      !idPattern.test(input.providerClientId) ||
      !correlationPattern.test(input.correlationId) ||
      !correlationPattern.test(input.idempotencyKey)
    ) {
      throw new SubscriptionRuntimeActorDelegationError(
        'SUBSCRIPTION_RUNTIME_DELEGATION_INPUT_INVALID',
      );
    }
    let key: Awaited<ReturnType<typeof importPKCS8>>;
    try {
      key = await importPKCS8(this.options.privateKeyPem, 'RS256');
    } catch {
      throw new SubscriptionRuntimeActorDelegationError(
        'SUBSCRIPTION_RUNTIME_DELEGATION_CONFIGURATION_INVALID',
      );
    }
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      contract_version: 1,
      scope: 'subscription-runtime.quote',
      tenant_id: input.tenantId,
      tenant_key: input.tenantKey,
      sid: input.sessionId,
      provider: 'VIVA',
      provider_client_id: input.providerClientId,
      provider_mapping_id: input.providerMappingId,
      action: input.action,
      correlation_id: input.correlationId,
      request_sha256: subscriptionRuntimeRequestSha256(input.request),
      idempotency_key_sha256: subscriptionRuntimeIdempotencyKeySha256(input.idempotencyKey),
    })
      .setProtectedHeader({
        alg: 'RS256',
        typ: 'phub-subscription-runtime-actor-delegation+jwt',
        kid: this.options.keyId,
      })
      .setIssuer(this.options.issuer)
      .setAudience(this.options.audience)
      .setSubject(input.userId)
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + this.options.ttlSeconds)
      .setJti(randomUUID())
      .sign(key);
    if (token.length > 4096 || !printableAsciiPattern.test(token)) {
      throw new SubscriptionRuntimeActorDelegationError(
        'SUBSCRIPTION_RUNTIME_DELEGATION_CONFIGURATION_INVALID',
      );
    }
    return token;
  }
}
