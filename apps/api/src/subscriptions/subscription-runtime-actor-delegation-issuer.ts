import {
  parseTrainingRequest,
  parseTrainingAdmission,
  trainingHash,
  trainingRequestHash,
  trainingOperationId,
  trainingPrivateId,
  trainingUuid,
  type TrainingRequest,
  type TrainingAdmission,
} from '@phub/domain/training-registration';
import { createHash, createPrivateKey, randomUUID } from 'node:crypto';

import { importPKCS8, SignJWT } from 'jose';
import {
  MANAGED_SELF_LEAVE_ADMISSION_PATH,
  MANAGED_SELF_LEAVE_READ_PREFIX,
  MANAGED_SELF_LEAVE_ADMISSION_SCOPE,
  MANAGED_SELF_LEAVE_READ_SCOPE,
  managedSelfLeaveOperationId,
  managedSelfLeaveRequestSha256,
  type ManagedSelfLeaveRequest,
  MANAGED_JOIN_PREFLIGHT_PATH,
  MANAGED_JOIN_ADMISSION_PATH,
  MANAGED_JOIN_READ_PREFIX,
  MANAGED_JOIN_PREFLIGHT_SCOPE,
  managedJoinPreflightSha256,
  managedJoinAdmissionSha256,
  type ManagedJoinPreflightRequest,
  type ManagedJoinAdmissionRequest,
  BOOKED_OPERATION_READ_PREFIX,
  BOOKED_OPERATION_READ_SCOPE,
  BOOKED_OPERATION_ADMISSION_PATH,
  BOOKED_OPERATION_ADMISSION_SCOPE,
  bookedOperationAdmissionId,
  bookedOperationAdmissionRequestSha256,
  type BookedOperationAdmissionRequest,
  type ManagedSubscriptionRuntimeV1QuoteRequest,
} from '@phub/subscription-runtime-adapter';

const actionSet = new Set(['CREATE_GAME', 'JOIN_GAME']);
const correlationPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;
const keyIdPattern = /^[A-Za-z0-9._:-]{3,64}$/;
const printableAsciiPattern = /^[!-~]+$/;
const pkcs8PrivateKeyHeader = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
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
      !options.privateKeyPem.startsWith(pkcs8PrivateKeyHeader) ||
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

  trainingSigningIdentity(): { issuer: string; audience: string } {
    return { issuer: this.options.issuer, audience: this.options.audience };
  }
  async issueTrainingRegistration(input: {
    mode: 'prepare' | 'admit' | 'read';
    tenantId: string;
    userId: string;
    sessionId: string;
    providerClientId: string;
    providerMappingId: string;
    providerClientSubscriptionId: string;
    keySha256: string;
    operationId: string;
    request: TrainingRequest | TrainingAdmission;
    correlationId: string;
    actorToken: { token: string; expiresAt: string };
    recoveryOnly?: true;
  }): Promise<string> {
    const { mode } = input;
    if (
      !['prepare', 'admit', 'read'].includes(mode) ||
      ![
        input.tenantId,
        input.userId,
        input.sessionId,
        input.providerMappingId,
        input.operationId,
      ].every(trainingUuid) ||
      ![input.providerClientId, input.providerClientSubscriptionId].every(trainingPrivateId) ||
      !/^sha256:[a-f0-9]{64}$/.test(input.keySha256) ||
      input.keySha256.length !== 71 ||
      !correlationPattern.test(input.correlationId) ||
      /[\r\n]/.test(input.correlationId) ||
      !printableAsciiPattern.test(input.actorToken.token) ||
      input.actorToken.token.length < 16 ||
      input.actorToken.token.length > 4096 ||
      !Number.isFinite(Date.parse(input.actorToken.expiresAt)) ||
      new Date(input.actorToken.expiresAt).toISOString() !== input.actorToken.expiresAt ||
      Date.parse(input.actorToken.expiresAt) <= Date.now() ||
      (input.recoveryOnly !== undefined && (mode !== 'admit' || input.recoveryOnly !== true)) ||
      (await trainingOperationId(input.tenantId, input.userId, input.keySha256)) !==
        input.operationId
    )
      throw new SubscriptionRuntimeActorDelegationError(
        'SUBSCRIPTION_RUNTIME_DELEGATION_INPUT_INVALID',
      );
    const request =
      mode === 'prepare'
        ? parseTrainingRequest(input.request)
        : await parseTrainingAdmission(input.request);
    if ('preparation' in request) {
      const p = (request as TrainingAdmission).preparation;
      if (
        p.operationId !== input.operationId ||
        p.actor.tenantId !== input.tenantId ||
        p.actor.userId !== input.userId ||
        p.actor.providerMappingId !== input.providerMappingId ||
        p.actor.providerClientId !== input.providerClientId ||
        p.subscription.providerClientSubscriptionId !== input.providerClientSubscriptionId
      )
        throw new SubscriptionRuntimeActorDelegationError(
          'SUBSCRIPTION_RUNTIME_DELEGATION_INPUT_INVALID',
        );
    }
    const path =
      mode === 'prepare'
        ? '/lk/integrations/v1/training-registration-preparations'
        : mode === 'admit'
          ? '/lk/integrations/v1/training-registration-admissions'
          : '/lk/integrations/v1/training-registrations/' + input.operationId;
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      contract_version: 1,
      scope: 'subscription-runtime.training-registration.' + mode,
      caller: 'lk2-api',
      method: mode === 'read' ? 'GET' : 'POST',
      path,
      tenant_id: input.tenantId,
      tenant_key: 'iSkq6G',
      sid: input.sessionId,
      provider: 'VIVA',
      provider_client_id: input.providerClientId,
      provider_mapping_id: input.providerMappingId,
      subscription_id: request.subscriptionId,
      provider_client_subscription_id: input.providerClientSubscriptionId,
      operation_id: input.operationId,
      idempotency_key_sha256: input.keySha256,
      target_id: request.target.id,
      date_hint: request.target.dateHint,
      actor_token_sha256: await trainingHash(input.actorToken.token),
      actor_token_expires_at: input.actorToken.expiresAt,
      correlation_id: input.correlationId,
      request_sha256:
        mode === 'read'
          ? await trainingHash(
              'training-registration-read:v1\0' +
                JSON.stringify({ operationId: input.operationId }),
            )
          : await trainingRequestHash(request),
      ...(input.recoveryOnly ? { recovery_only: true } : {}),
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
      .setExpirationTime(
        Math.min(
          now + this.options.ttlSeconds,
          Math.floor(Date.parse(input.actorToken.expiresAt) / 1000),
        ),
      )
      .setJti(randomUUID())
      .sign(await importPKCS8(this.options.privateKeyPem, 'RS256'));
  }

  async issueManagedSelfLeaveAdmission(input: {
    readonly userId: string;
    readonly tenantId: string;
    readonly tenantKey: string;
    readonly sessionId: string;
    readonly providerClientId: string;
    readonly providerMappingId: string;
    readonly operationId: string;
    readonly correlationId: string;
    readonly idempotencyKey: string;
    readonly request: ManagedSelfLeaveRequest;
    readonly legacyGameId: string;
    readonly legacyGameMappingId: string;
    readonly legacyGameMappingVersion: string;
    readonly actorToken: { readonly token: string; readonly expiresAt: string };
    readonly recoveryOnly?: true;
  }): Promise<string> {
    const keyHash = subscriptionRuntimeIdempotencyKeySha256(input.idempotencyKey);
    const opaque = (value: unknown): value is string =>
      typeof value === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value) &&
      !/[\r\n]/.test(value);
    if (
      input.idempotencyKey.length < 16 ||
      input.idempotencyKey.length > 128 ||
      !opaque(input.legacyGameId) ||
      !uuidPattern.test(input.legacyGameMappingId) ||
      input.legacyGameMappingId !== input.legacyGameMappingId.toLowerCase() ||
      !opaque(input.legacyGameMappingVersion) ||
      input.legacyGameMappingVersion.length > 128 ||
      (input.recoveryOnly !== undefined && input.recoveryOnly !== true) ||
      !input.actorToken ||
      !/^[!-~]{16,4096}$/.test(input.actorToken.token) ||
      /[\r\n]/.test(input.actorToken.token) ||
      !Number.isFinite(Date.parse(input.actorToken.expiresAt)) ||
      new Date(input.actorToken.expiresAt).toISOString() !== input.actorToken.expiresAt ||
      Date.parse(input.actorToken.expiresAt) <= Date.now() + 5000 ||
      (await managedSelfLeaveOperationId({
        tenantId: input.tenantId,
        userId: input.userId,
        idempotencyKeySha256: keyHash,
      })) !== input.operationId
    )
      throw new SubscriptionRuntimeActorDelegationError(
        'SUBSCRIPTION_RUNTIME_DELEGATION_INPUT_INVALID',
      );
    return this.signManagedSelfLeave(
      input,
      {
        request_sha256: await managedSelfLeaveRequestSha256(input.request),
        idempotency_key_sha256: keyHash,
        actor_token_sha256:
          'sha256:' + createHash('sha256').update(input.actorToken.token).digest('hex'),
        actor_token_expires_at: input.actorToken.expiresAt,
        legacy_game_id: input.legacyGameId,
        legacy_game_mapping_id: input.legacyGameMappingId,
        legacy_game_mapping_version: input.legacyGameMappingVersion,
        ...(input.recoveryOnly === true ? { recovery_only: true } : {}),
      },
      false,
    );
  }
  async issueManagedSelfLeaveRead(input: {
    readonly userId: string;
    readonly tenantId: string;
    readonly tenantKey: string;
    readonly sessionId: string;
    readonly providerClientId: string;
    readonly providerMappingId: string;
    readonly operationId: string;
    readonly correlationId: string;
  }): Promise<string> {
    return this.signManagedSelfLeave(input, { receipt_version: 1 }, true);
  }
  private async signManagedSelfLeave(
    input: {
      readonly userId: string;
      readonly tenantId: string;
      readonly tenantKey: string;
      readonly sessionId: string;
      readonly providerClientId: string;
      readonly providerMappingId: string;
      readonly operationId: string;
      readonly correlationId: string;
    },
    claims: Record<string, unknown>,
    read: boolean,
  ): Promise<string> {
    if (
      ![
        input.userId,
        input.tenantId,
        input.sessionId,
        input.providerMappingId,
        input.operationId,
      ].every((v) => v.length === 36 && uuidPattern.test(v) && v === v.toLowerCase()) ||
      input.tenantKey !== 'iSkq6G' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.providerClientId) ||
      /[\r\n]/.test(input.providerClientId) ||
      !correlationPattern.test(input.correlationId) ||
      /[\r\n]/.test(input.correlationId)
    )
      throw new SubscriptionRuntimeActorDelegationError(
        'SUBSCRIPTION_RUNTIME_DELEGATION_INPUT_INVALID',
      );
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      contract_version: 1,
      scope: read ? MANAGED_SELF_LEAVE_READ_SCOPE : MANAGED_SELF_LEAVE_ADMISSION_SCOPE,
      caller: 'lk2-api',
      method: read ? 'GET' : 'POST',
      path: read
        ? MANAGED_SELF_LEAVE_READ_PREFIX + input.operationId
        : MANAGED_SELF_LEAVE_ADMISSION_PATH,
      operation_id: input.operationId,
      tenant_id: input.tenantId,
      tenant_key: input.tenantKey,
      sid: input.sessionId,
      provider: 'VIVA',
      provider_client_id: input.providerClientId,
      provider_mapping_id: input.providerMappingId,
      correlation_id: input.correlationId,
      ...claims,
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
      .sign(await importPKCS8(this.options.privateKeyPem, 'RS256'));
  }

  async issueManagedJoinPreflight(
    input: Omit<
      Parameters<SubscriptionRuntimeActorDelegationIssuer['issueBookedOperationAdmission']>[0],
      'request' | 'reservationId'
    > & { readonly request: ManagedJoinPreflightRequest },
  ): Promise<string> {
    return this.issueManagedJoinCommand(input, true);
  }
  async issueManagedJoinAdmission(
    input: Omit<
      Parameters<SubscriptionRuntimeActorDelegationIssuer['issueBookedOperationAdmission']>[0],
      'request'
    > & { readonly request: ManagedJoinAdmissionRequest; readonly recoveryOnly?: true },
  ): Promise<string> {
    return this.issueManagedJoinCommand(input, false);
  }
  private async issueManagedJoinCommand(
    input: {
      readonly userId: string;
      readonly tenantId: string;
      readonly tenantKey: string;
      readonly sessionId: string;
      readonly providerClientId: string;
      readonly providerMappingId: string;
      readonly providerExerciseId: string;
      readonly targetMappingId: string;
      readonly targetVersion: string;
      readonly startsAt: string;
      readonly durationMinutes: number;
      readonly capacity: number;
      readonly admissible: boolean;
      readonly operationId: string;
      readonly correlationId: string;
      readonly idempotencyKey: string;
      readonly request: ManagedJoinPreflightRequest | ManagedJoinAdmissionRequest;
      /**
       * Backend-issued short-lived user-scoped provider credential for exactly this operation.
       * When present the delegation binds its sha256 and the wire header must carry the same token;
       * the owner refuses a swapped or missing token.
       */
      readonly actorToken?: { readonly token: string; readonly expiresAt: string };
      /** Provider client subscription id resolved server-side for the selected product. */
      readonly providerClientSubscriptionId?: string;
      readonly reservationId?: string;
      readonly recoveryOnly?: true;
    },
    preflight: boolean,
  ): Promise<string> {
    if (
      (input.recoveryOnly !== undefined && input.recoveryOnly !== true) ||
      (preflight && input.recoveryOnly !== undefined)
    )
      throw new SubscriptionRuntimeActorDelegationError(
        'SUBSCRIPTION_RUNTIME_DELEGATION_INPUT_INVALID',
      );
    if (
      !input.actorToken ||
      !input.providerClientSubscriptionId ||
      (preflight ? input.reservationId !== undefined : !uuidPattern.test(input.reservationId ?? ''))
    ) {
      throw new SubscriptionRuntimeActorDelegationError(
        'SUBSCRIPTION_RUNTIME_DELEGATION_INPUT_INVALID',
      );
    }
    const keyHash = subscriptionRuntimeIdempotencyKeySha256(input.idempotencyKey);
    if (
      ![
        input.userId,
        input.tenantId,
        input.sessionId,
        input.providerMappingId,
        input.targetMappingId,
        input.operationId,
      ].every((v) => uuidPattern.test(v) && v === v.toLowerCase()) ||
      !idPattern.test(input.tenantKey) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.providerClientId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.providerExerciseId) ||
      !correlationPattern.test(input.correlationId) ||
      !correlationPattern.test(input.idempotencyKey) ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(input.targetVersion) ||
      !Number.isSafeInteger(input.durationMinutes) ||
      input.durationMinutes < 1 ||
      input.durationMinutes > 1440 ||
      !Number.isInteger(input.capacity) ||
      input.capacity < 1 ||
      input.capacity > 1000 ||
      typeof input.admissible !== 'boolean' ||
      !Number.isFinite(Date.parse(input.startsAt)) ||
      new Date(input.startsAt).toISOString() !== input.startsAt ||
      input.operationId !== bookedOperationAdmissionId(input.tenantId, input.userId, keyHash)
    ) {
      throw new SubscriptionRuntimeActorDelegationError(
        'SUBSCRIPTION_RUNTIME_DELEGATION_INPUT_INVALID',
      );
    }
    if ((input.actorToken === undefined) !== (input.providerClientSubscriptionId === undefined)) {
      throw new SubscriptionRuntimeActorDelegationError(
        'SUBSCRIPTION_RUNTIME_DELEGATION_INPUT_INVALID',
      );
    }
    let actorTokenSha256: string | undefined;
    if (input.actorToken !== undefined) {
      const expiresAtMs = Date.parse(input.actorToken.expiresAt);
      if (
        !printableAsciiPattern.test(input.actorToken.token) ||
        input.actorToken.token.length < 16 ||
        input.actorToken.token.length > 4096 ||
        !Number.isFinite(expiresAtMs) ||
        new Date(expiresAtMs).toISOString() !== input.actorToken.expiresAt ||
        expiresAtMs <= Date.now() ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.providerClientSubscriptionId ?? '') ||
        /[\r\n]/.test(input.providerClientSubscriptionId ?? '')
      ) {
        throw new SubscriptionRuntimeActorDelegationError(
          'SUBSCRIPTION_RUNTIME_DELEGATION_INPUT_INVALID',
        );
      }
      actorTokenSha256 = `sha256:${createHash('sha256')
        .update(input.actorToken.token, 'utf8')
        .digest('hex')}`;
    }
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      contract_version: 2,
      ...(input.recoveryOnly ? { recovery_only: true } : {}),
      scope: preflight ? MANAGED_JOIN_PREFLIGHT_SCOPE : BOOKED_OPERATION_ADMISSION_SCOPE,
      caller: 'lk2-api',
      method: 'POST',
      path: preflight ? MANAGED_JOIN_PREFLIGHT_PATH : MANAGED_JOIN_ADMISSION_PATH,
      operation_id: input.operationId,
      tenant_id: input.tenantId,
      tenant_key: input.tenantKey,
      sid: input.sessionId,
      provider: 'VIVA',
      provider_client_id: input.providerClientId,
      provider_mapping_id: input.providerMappingId,
      correlation_id: input.correlationId,
      request_sha256: preflight
        ? managedJoinPreflightSha256(input.request)
        : managedJoinAdmissionSha256(input.request as ManagedJoinAdmissionRequest),
      idempotency_key_sha256: keyHash,
      target_id: input.request.target.id,
      expected_revision: input.request.target.expectedRevision,
      target_mapping_id: input.targetMappingId,
      provider_exercise_id: input.providerExerciseId,
      target_version: input.targetVersion,
      target_starts_at: input.startsAt,
      target_duration_minutes: input.durationMinutes,
      target_capacity: input.capacity,
      target_admissible: input.admissible,
      ...(input.reservationId ? { reservation_id: input.reservationId } : {}),
      ...(input.actorToken === undefined
        ? {}
        : {
            actor_token_sha256: actorTokenSha256,
            actor_token_expires_at: input.actorToken.expiresAt,
            provider_client_subscription_id: input.providerClientSubscriptionId,
          }),
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
      .sign(await importPKCS8(this.options.privateKeyPem, 'RS256'));
  }

  async issueManagedJoinRead(input: {
    readonly userId: string;
    readonly tenantId: string;
    readonly tenantKey: string;
    readonly sessionId: string;
    readonly providerClientId: string;
    readonly providerMappingId: string;
    readonly operationId: string;
    readonly correlationId: string;
    readonly includeReceipt?: boolean;
  }): Promise<string> {
    if (
      ![
        input.userId,
        input.tenantId,
        input.sessionId,
        input.providerMappingId,
        input.operationId,
      ].every((value) => uuidPattern.test(value) && value === value.toLowerCase()) ||
      !idPattern.test(input.tenantKey) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.providerClientId) ||
      /[\r\n]/.test(input.providerClientId) ||
      !correlationPattern.test(input.correlationId)
    ) {
      throw new SubscriptionRuntimeActorDelegationError(
        'SUBSCRIPTION_RUNTIME_DELEGATION_INPUT_INVALID',
      );
    }
    const key = await importPKCS8(this.options.privateKeyPem, 'RS256');
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      contract_version: 2,
      scope: BOOKED_OPERATION_READ_SCOPE,
      caller: 'lk2-api',
      method: 'GET',
      path: MANAGED_JOIN_READ_PREFIX + input.operationId,
      operation_id: input.operationId,
      tenant_id: input.tenantId,
      tenant_key: input.tenantKey,
      sid: input.sessionId,
      provider: 'VIVA',
      provider_client_id: input.providerClientId,
      provider_mapping_id: input.providerMappingId,
      correlation_id: input.correlationId,
      receipt_version: 2,
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
  }

  async issueBookedOperationAdmission(input: {
    readonly userId: string;
    readonly tenantId: string;
    readonly tenantKey: string;
    readonly sessionId: string;
    readonly providerClientId: string;
    readonly providerMappingId: string;
    readonly providerExerciseId: string;
    readonly targetMappingId: string;
    readonly targetVersion: string;
    readonly startsAt: string;
    readonly durationMinutes: number;
    readonly capacity: number;
    readonly admissible: boolean;
    readonly operationId: string;
    readonly correlationId: string;
    readonly idempotencyKey: string;
    readonly request: BookedOperationAdmissionRequest;
    /**
     * Backend-issued short-lived user-scoped provider credential for exactly this operation.
     * When present the delegation binds its sha256 and the wire header must carry the same token;
     * the owner refuses a swapped or missing token.
     */
    readonly actorToken?: { readonly token: string; readonly expiresAt: string };
    /** Provider client subscription id resolved server-side for the selected product. */
    readonly providerClientSubscriptionId?: string;
    readonly reservationId?: string;
  }): Promise<string> {
    if (input.reservationId !== undefined && !uuidPattern.test(input.reservationId)) {
      throw new SubscriptionRuntimeActorDelegationError(
        'SUBSCRIPTION_RUNTIME_DELEGATION_INPUT_INVALID',
      );
    }
    const keyHash = subscriptionRuntimeIdempotencyKeySha256(input.idempotencyKey);
    if (
      ![
        input.userId,
        input.tenantId,
        input.sessionId,
        input.providerMappingId,
        input.targetMappingId,
        input.operationId,
      ].every((v) => uuidPattern.test(v) && v === v.toLowerCase()) ||
      !idPattern.test(input.tenantKey) ||
      !idPattern.test(input.providerClientId) ||
      !idPattern.test(input.providerExerciseId) ||
      !correlationPattern.test(input.correlationId) ||
      !correlationPattern.test(input.idempotencyKey) ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(input.targetVersion) ||
      !Number.isSafeInteger(input.durationMinutes) ||
      input.durationMinutes < 1 ||
      input.durationMinutes > 1440 ||
      !Number.isInteger(input.capacity) ||
      input.capacity < 1 ||
      input.capacity > 1000 ||
      typeof input.admissible !== 'boolean' ||
      !Number.isFinite(Date.parse(input.startsAt)) ||
      new Date(input.startsAt).toISOString() !== input.startsAt ||
      input.operationId !== bookedOperationAdmissionId(input.tenantId, input.userId, keyHash)
    ) {
      throw new SubscriptionRuntimeActorDelegationError(
        'SUBSCRIPTION_RUNTIME_DELEGATION_INPUT_INVALID',
      );
    }
    if ((input.actorToken === undefined) !== (input.providerClientSubscriptionId === undefined)) {
      throw new SubscriptionRuntimeActorDelegationError(
        'SUBSCRIPTION_RUNTIME_DELEGATION_INPUT_INVALID',
      );
    }
    let actorTokenSha256: string | undefined;
    if (input.actorToken !== undefined) {
      const expiresAtMs = Date.parse(input.actorToken.expiresAt);
      if (
        !printableAsciiPattern.test(input.actorToken.token) ||
        input.actorToken.token.length < 16 ||
        input.actorToken.token.length > 4096 ||
        !Number.isFinite(expiresAtMs) ||
        new Date(expiresAtMs).toISOString() !== input.actorToken.expiresAt ||
        expiresAtMs <= Date.now() ||
        !uuidPattern.test(input.providerClientSubscriptionId ?? '') ||
        input.providerClientSubscriptionId !== input.providerClientSubscriptionId?.toLowerCase()
      ) {
        throw new SubscriptionRuntimeActorDelegationError(
          'SUBSCRIPTION_RUNTIME_DELEGATION_INPUT_INVALID',
        );
      }
      actorTokenSha256 = `sha256:${createHash('sha256')
        .update(input.actorToken.token, 'utf8')
        .digest('hex')}`;
    }
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      contract_version: 1,
      scope: BOOKED_OPERATION_ADMISSION_SCOPE,
      caller: 'lk2-api',
      method: 'POST',
      path: BOOKED_OPERATION_ADMISSION_PATH,
      operation_id: input.operationId,
      tenant_id: input.tenantId,
      tenant_key: input.tenantKey,
      sid: input.sessionId,
      provider: 'VIVA',
      provider_client_id: input.providerClientId,
      provider_mapping_id: input.providerMappingId,
      correlation_id: input.correlationId,
      request_sha256: bookedOperationAdmissionRequestSha256(input.request),
      idempotency_key_sha256: keyHash,
      target_id: input.request.target.id,
      expected_revision: input.request.target.expectedRevision,
      target_mapping_id: input.targetMappingId,
      provider_exercise_id: input.providerExerciseId,
      target_version: input.targetVersion,
      target_starts_at: input.startsAt,
      target_duration_minutes: input.durationMinutes,
      target_capacity: input.capacity,
      target_admissible: input.admissible,
      ...(input.reservationId ? { reservation_id: input.reservationId } : {}),
      ...(input.actorToken === undefined
        ? {}
        : {
            actor_token_sha256: actorTokenSha256,
            actor_token_expires_at: input.actorToken.expiresAt,
            provider_client_subscription_id: input.providerClientSubscriptionId,
          }),
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
      .sign(await importPKCS8(this.options.privateKeyPem, 'RS256'));
  }

  async issueBookedOperationRead(input: {
    readonly userId: string;
    readonly tenantId: string;
    readonly tenantKey: string;
    readonly sessionId: string;
    readonly providerClientId: string;
    readonly providerMappingId: string;
    readonly operationId: string;
    readonly correlationId: string;
    readonly includeReceipt?: boolean;
  }): Promise<string> {
    if (
      ![
        input.userId,
        input.tenantId,
        input.sessionId,
        input.providerMappingId,
        input.operationId,
      ].every((value) => uuidPattern.test(value) && value === value.toLowerCase()) ||
      !idPattern.test(input.tenantKey) ||
      !idPattern.test(input.providerClientId) ||
      !correlationPattern.test(input.correlationId)
    ) {
      throw new SubscriptionRuntimeActorDelegationError(
        'SUBSCRIPTION_RUNTIME_DELEGATION_INPUT_INVALID',
      );
    }
    const key = await importPKCS8(this.options.privateKeyPem, 'RS256');
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      contract_version: 1,
      scope: BOOKED_OPERATION_READ_SCOPE,
      caller: 'lk2-api',
      method: 'GET',
      path: BOOKED_OPERATION_READ_PREFIX + input.operationId,
      operation_id: input.operationId,
      tenant_id: input.tenantId,
      tenant_key: input.tenantKey,
      sid: input.sessionId,
      provider: 'VIVA',
      provider_client_id: input.providerClientId,
      provider_mapping_id: input.providerMappingId,
      correlation_id: input.correlationId,
      ...(input.includeReceipt ? { receipt_version: 1 } : {}),
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
