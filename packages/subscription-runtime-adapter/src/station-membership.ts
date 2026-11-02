import { createHash, createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto';

/** Private owner protocol: never a public DTO or a source of booking authority. */
export const stationUuid = (x: unknown): x is string =>
  typeof x === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const id = (x: unknown): x is string =>
  typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(x);
const digest = (x: unknown): x is string =>
  typeof x === 'string' && /^sha256:[a-f0-9]{64}$/.test(x);
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const keys = (x: unknown, names: string[]): x is Record<string, unknown> =>
  object(x) && Object.keys(x).sort().join(',') === [...names].sort().join(',');
export class StationMembershipError extends Error {
  constructor() {
    super('STATION_MEMBERSHIP_UNAVAILABLE');
  }
}
export function stationCanonical(x: unknown): string {
  if (Array.isArray(x)) return '[' + x.map(stationCanonical).join(',') + ']';
  if (object(x))
    return (
      '{' +
      Object.keys(x)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stationCanonical(x[k]))
        .join(',') +
      '}'
    );
  if (
    x === null ||
    typeof x === 'boolean' ||
    typeof x === 'string' ||
    (typeof x === 'number' && Number.isFinite(x))
  )
    return JSON.stringify(x);
  throw new StationMembershipError();
}
export const stationHash = (domain: string, value: unknown): string =>
  'sha256:' +
  createHash('sha256')
    .update(domain + '\0' + stationCanonical(value))
    .digest('hex');
export function stationAdmissionId(tenantId: string, operationId: string): string {
  if (!stationUuid(tenantId) || !stationUuid(operationId)) throw new StationMembershipError();
  const chars = stationHash('station-membership-admission-id:v1', { tenantId, operationId })
    .slice(7, 39)
    .split('');
  chars[12] = '8';
  chars[16] = ((parseInt(chars[16]!, 16) & 3) | 8).toString(16);
  const h = chars.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export interface StationActor {
  tenantId: string;
  canonicalUserId: string;
  playerId: string;
  providerMappingId: string;
}
export function parseStationActor(x: unknown): StationActor {
  if (
    !keys(x, ['tenantId', 'canonicalUserId', 'playerId', 'providerMappingId']) ||
    !stationUuid(x.tenantId) ||
    !stationUuid(x.canonicalUserId) ||
    !stationUuid(x.providerMappingId) ||
    !id(x.playerId)
  )
    throw new StationMembershipError();
  return structuredClone(x) as unknown as StationActor;
}
export interface StationAdmissionRequest {
  contractVersion: 1;
  operationId: string;
  requestSha256: string;
  activity: { kind: 'GAME' | 'TRAINING' | 'GAME_CREATE'; id: string };
  stationId: string;
}
export interface StationConfirmationRequest {
  contractVersion: 1;
  operationId: string;
  admissionId: string;
  admissionBindingSha256: string;
  confirmation: {
    kind: 'GAME_PARTICIPATION' | 'TRAINING_REGISTRATION' | 'GAME_CREATE_ORGANIZER';
    generationId: string;
    activityId: string;
  };
}
export function parseStationRequest(
  x: unknown,
  mode: 'admission' | 'confirmation',
): StationAdmissionRequest | StationConfirmationRequest {
  if (!object(x) || x.contractVersion !== 1 || !stationUuid(x.operationId))
    throw new StationMembershipError();
  if (mode === 'admission') {
    if (
      !keys(x, ['contractVersion', 'operationId', 'requestSha256', 'activity', 'stationId']) ||
      !digest(x.requestSha256) ||
      !id(x.stationId) ||
      !keys(x.activity, ['kind', 'id']) ||
      (x.activity.kind !== 'GAME' &&
        x.activity.kind !== 'TRAINING' &&
        x.activity.kind !== 'GAME_CREATE') ||
      !stationUuid(x.activity.id)
    )
      throw new StationMembershipError();
  } else if (
    !keys(x, [
      'contractVersion',
      'operationId',
      'admissionId',
      'admissionBindingSha256',
      'confirmation',
    ]) ||
    !stationUuid(x.admissionId) ||
    !digest(x.admissionBindingSha256) ||
    !keys(x.confirmation, ['kind', 'generationId', 'activityId']) ||
    (x.confirmation.kind !== 'GAME_PARTICIPATION' &&
      x.confirmation.kind !== 'TRAINING_REGISTRATION' &&
      x.confirmation.kind !== 'GAME_CREATE_ORGANIZER') ||
    !stationUuid(x.confirmation.generationId) ||
    !stationUuid(x.confirmation.activityId)
  )
    throw new StationMembershipError();
  if (Buffer.byteLength(stationCanonical(x)) > 8192) throw new StationMembershipError();
  return structuredClone(x) as unknown as StationAdmissionRequest | StationConfirmationRequest;
}
const admissionReasons = [
  'ELIGIBLE',
  'STATION_COMMUNITY_MISSING',
  'STATION_COMMUNITY_AMBIGUOUS',
  'STATION_POLICY_INVALID',
  'ACTOR_MAPPING_CONFLICT',
  'MEMBERSHIP_BLOCKED',
  'BAN_IDENTITY_UNRESOLVED',
];
export interface StationAdmission {
  outcome: 'ADMITTED' | 'NO_ENROLLMENT';
  admissionId: string;
  communityId: string | null;
  membershipEpoch: number | null;
  reason: string;
  bindingSha256: string;
}
export interface StationAdmissionResponse {
  contractVersion: 1;
  operationId: string;
  admission: StationAdmission;
  replayed: boolean;
}
export function parseStationAdmissionResponse(
  x: unknown,
  actor: StationActor,
  request: StationAdmissionRequest,
): StationAdmissionResponse {
  if (
    !keys(x, ['contractVersion', 'operationId', 'admission', 'replayed']) ||
    x.contractVersion !== 1 ||
    x.operationId !== request.operationId ||
    typeof x.replayed !== 'boolean'
  )
    throw new StationMembershipError();
  const a = x.admission;
  if (
    !keys(a, [
      'outcome',
      'admissionId',
      'communityId',
      'membershipEpoch',
      'reason',
      'bindingSha256',
    ]) ||
    a.admissionId !== stationAdmissionId(actor.tenantId, request.operationId) ||
    !digest(a.bindingSha256) ||
    typeof a.reason !== 'string' ||
    !admissionReasons.includes(a.reason) ||
    a.outcome !== (a.reason === 'ELIGIBLE' ? 'ADMITTED' : 'NO_ENROLLMENT') ||
    !(a.communityId === null || id(a.communityId)) ||
    !(
      a.membershipEpoch === null ||
      (Number.isSafeInteger(a.membershipEpoch) &&
        Number(a.membershipEpoch) >= 0 &&
        Number(a.membershipEpoch) < Number.MAX_SAFE_INTEGER)
    ) ||
    (a.outcome === 'ADMITTED' && (a.communityId === null || a.membershipEpoch === null))
  )
    throw new StationMembershipError();
  return structuredClone(x) as unknown as StationAdmissionResponse;
}
export interface StationLocationEvidence {
  bindingId: string;
  revision: string;
  stationId: string;
  courtId: string;
  providerStationId: string;
  providerRoomId: string;
  lineageDigest: string;
  evidenceDigest: string;
  targetMappingId: string;
  targetVersion: string;
  providerExerciseId: string;
}
export function parseStationLocationEvidence(x: unknown): StationLocationEvidence {
  if (
    !keys(x, [
      'bindingId',
      'revision',
      'stationId',
      'courtId',
      'providerStationId',
      'providerRoomId',
      'lineageDigest',
      'evidenceDigest',
      'targetMappingId',
      'targetVersion',
      'providerExerciseId',
    ]) ||
    ![x.bindingId, x.stationId, x.courtId, x.targetMappingId].every(stationUuid) ||
    ![x.providerStationId, x.providerRoomId, x.providerExerciseId].every(id) ||
    typeof x.revision !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(x.revision) ||
    typeof x.targetVersion !== 'string' ||
    x.targetVersion.length < 1 ||
    x.targetVersion.length > 512 ||
    ![x.lineageDigest, x.evidenceDigest].every(
      (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v),
    )
  )
    throw new StationMembershipError();
  return structuredClone(x) as unknown as StationLocationEvidence;
}
export type StationMarker =
  | {
      version: 1;
      outcome: 'NO_ENROLLMENT';
      reason:
        | 'DISABLED'
        | 'STATION_BINDING_UNAVAILABLE'
        | 'OWNER_UNAVAILABLE'
        | 'STATION_BINDING_CHANGED';
    }
  | {
      version: 1;
      outcome: 'OWNER_ADMISSION';
      actor: StationActor;
      request: StationAdmissionRequest;
      response: StationAdmissionResponse;
      location: StationLocationEvidence;
    };
export function parseStationMarker(x: unknown): StationMarker {
  if (!object(x) || x.version !== 1) throw new StationMembershipError();
  if (x.outcome === 'NO_ENROLLMENT') {
    if (
      !keys(x, ['version', 'outcome', 'reason']) ||
      ![
        'DISABLED',
        'STATION_BINDING_UNAVAILABLE',
        'OWNER_UNAVAILABLE',
        'STATION_BINDING_CHANGED',
      ].includes(String(x.reason))
    )
      throw new StationMembershipError();
  } else {
    if (
      !keys(x, ['version', 'outcome', 'actor', 'request', 'response', 'location']) ||
      x.outcome !== 'OWNER_ADMISSION'
    )
      throw new StationMembershipError();
    const actor = parseStationActor(x.actor),
      request = parseStationRequest(x.request, 'admission') as StationAdmissionRequest;
    parseStationAdmissionResponse(x.response, actor, request);
    if (
      request.activity.kind !== 'GAME' ||
      parseStationLocationEvidence(x.location).providerStationId !== request.stationId
    )
      throw new StationMembershipError();
  }
  return structuredClone(x) as unknown as StationMarker;
}
export const stationPath = (operationId: string, mode: 'admission' | 'confirmation'): string => {
  if (!stationUuid(operationId)) throw new StationMembershipError();
  return `/lk/integrations/v1/station-memberships/operations/${operationId}/${mode}`;
};
export class StationMembershipSigner {
  private readonly key: KeyObject;
  constructor(
    private readonly options: {
      privateKeyPem: string;
      keyId: string;
      issuer: string;
      audience: string;
      now?: () => number;
    },
  ) {
    this.key = createPrivateKey(options.privateKeyPem);
    if (
      this.key.asymmetricKeyType !== 'rsa' ||
      (this.key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
      !/^[A-Za-z0-9._:-]{3,64}$/.test(options.keyId) ||
      !/^[!-~]{1,512}$/.test(options.issuer) ||
      !/^[!-~]{1,256}$/.test(options.audience)
    )
      throw new StationMembershipError();
  }
  issue(
    input: { actor: StationActor; correlationId: string } & (
      | { mode: 'admission'; request: StationAdmissionRequest; sessionId: string }
      | {
          mode: 'confirmation';
          request: StationConfirmationRequest;
          caller: 'lk2-api' | 'lk2-worker';
        }
    ),
  ): string {
    const actor = parseStationActor(input.actor),
      request = parseStationRequest(input.request, input.mode);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.correlationId) ||
      (input.mode === 'admission' && !stationUuid(input.sessionId)) ||
      (input.mode === 'confirmation' && !['lk2-api', 'lk2-worker'].includes(input.caller))
    )
      throw new StationMembershipError();
    const now = Math.floor((this.options.now ?? Date.now)() / 1000);
    const claims = {
      iss: this.options.issuer,
      aud: this.options.audience,
      sub: actor.canonicalUserId,
      jti: randomUUID(),
      iat: now,
      nbf: now,
      exp: now + 30,
      tenant_id: actor.tenantId,
      provider_client_id: actor.playerId,
      provider_mapping_id: actor.providerMappingId,
      operation_id: request.operationId,
      caller: input.mode === 'admission' ? 'lk2-api' : input.caller,
      scope: 'communities.station-membership.' + (input.mode === 'admission' ? 'admit' : 'confirm'),
      method: 'POST',
      path: stationPath(request.operationId, input.mode),
      body_sha256: stationHash('station-membership-body:v1', request),
      correlation_id: input.correlationId,
      contract_version: 1,
      ...(input.mode === 'admission'
        ? { sid: input.sessionId, fresh_operation: true, adoption_version: 1 }
        : { persisted_fact: true }),
    };
    const content =
      Buffer.from(
        JSON.stringify({
          alg: 'RS256',
          kid: this.options.keyId,
          typ: 'phub-station-membership-delegation+jwt',
        }),
      ).toString('base64url') +
      '.' +
      Buffer.from(JSON.stringify(claims)).toString('base64url');
    return content + '.' + sign('RSA-SHA256', Buffer.from(content), this.key).toString('base64url');
  }
}
export class StationMembershipClient {
  private failures = 0;
  private openUntil = 0;
  constructor(
    private readonly options: {
      baseUrl: string;
      environment: 'development' | 'production';
      timeoutMs: number;
      fetchImplementation?: typeof fetch;
      onMetric?: (outcome: 'success' | 'unavailable' | 'circuit_open') => void;
    },
  ) {
    const u = new URL(options.baseUrl);
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== '/' ||
      (u.protocol !== 'https:' &&
        !(
          options.environment === 'development' &&
          u.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
        )) ||
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 100 ||
      options.timeoutMs > 5000
    )
      throw new StationMembershipError();
  }
  async admit(
    request: StationAdmissionRequest,
    actor: StationActor,
    envelope: { delegation: string; correlationId: string },
  ): Promise<StationAdmissionResponse> {
    return this.send('admission', request, envelope, (x) =>
      parseStationAdmissionResponse(x, actor, request),
    );
  }
  async confirm(
    request: StationConfirmationRequest,
    envelope: { delegation: string; correlationId: string },
  ): Promise<{ outcome: 'ENROLLED' | 'ALREADY_APPLIED' | 'NOT_ENROLLED'; reason: string }> {
    return this.send('confirmation', request, envelope, (x) => {
      if (
        !keys(x, ['contractVersion', 'operationId', 'outcome', 'reason']) ||
        x.contractVersion !== 1 ||
        x.operationId !== request.operationId ||
        !['ENROLLED', 'ALREADY_APPLIED', 'NOT_ENROLLED'].includes(String(x.outcome)) ||
        typeof x.reason !== 'string' ||
        !/^[A-Z_]{1,100}$/.test(x.reason) ||
        (x.outcome !== 'NOT_ENROLLED' && x.reason !== 'CONFIRMED_MEMBERSHIP') ||
        (x.outcome === 'NOT_ENROLLED' && x.reason === 'CONFIRMED_MEMBERSHIP')
      )
        throw new StationMembershipError();
      return {
        outcome: x.outcome as 'ENROLLED' | 'ALREADY_APPLIED' | 'NOT_ENROLLED',
        reason: x.reason,
      };
    });
  }
  private async send<T>(
    mode: 'admission' | 'confirmation',
    request: StationAdmissionRequest | StationConfirmationRequest,
    envelope: { delegation: string; correlationId: string },
    parse: (x: unknown) => T,
  ): Promise<T> {
    parseStationRequest(request, mode);
    if (
      !/^[!-~]{1,8192}$/.test(envelope.delegation) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(envelope.correlationId)
    )
      throw new StationMembershipError();
    if (Date.now() < this.openUntil) {
      this.options.onMetric?.('circuit_open');
      throw new StationMembershipError();
    }
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new StationMembershipError());
      }, this.options.timeoutMs);
    });
    const url = new URL(stationPath(request.operationId, mode), this.options.baseUrl).href;
    const work = async (): Promise<T> => {
      const response = await (this.options.fetchImplementation ?? fetch)(url, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Station-Membership-Delegation': envelope.delegation,
          'X-Correlation-ID': envelope.correlationId,
        },
        body: JSON.stringify(request),
      });
      if (response.status !== 200 || (response.url && response.url !== url)) {
        await response.body?.cancel();
        throw new StationMembershipError();
      }
      const reader = response.body?.getReader();
      if (!reader) throw new StationMembershipError();
      let bytes = 0,
        text = '';
      const decoder = new TextDecoder('utf-8', { fatal: true });
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 8192) {
            await reader.cancel();
            throw new StationMembershipError();
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      return parse(JSON.parse(text) as unknown);
    };
    try {
      const result = await Promise.race([work(), deadline]);
      this.failures = 0;
      this.openUntil = 0;
      this.options.onMetric?.('success');
      return result;
    } catch {
      if (++this.failures >= 3) this.openUntil = Date.now() + 30000;
      this.options.onMetric?.('unavailable');
      throw new StationMembershipError();
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface StationTransportConfig {
  LK_STATION_MEMBERSHIP_LIFETIME_ENABLED?: boolean;
  LK2_STATION_MEMBERSHIP_DELEGATION_AUDIENCE?: string | undefined;
  SUBSCRIPTION_RUNTIME_DELEGATION_PRIVATE_KEYS?: string | undefined;
  SUBSCRIPTION_RUNTIME_DELEGATION_ACTIVE_KEY_ID?: string | undefined;
  SUBSCRIPTION_RUNTIME_DELEGATION_ISSUER?: string | undefined;
  GAME_COMMERCIAL_JOIN_OWNER_BASE_URL?: string | undefined;
  GAME_COMMERCIAL_JOIN_OWNER_TIMEOUT_MS: number;
  APP_ENV: string;
}
export function createStationMembershipTransport(
  config: StationTransportConfig,
  onMetric?: (outcome: 'success' | 'unavailable' | 'circuit_open') => void,
): { signer: StationMembershipSigner; client: StationMembershipClient } | undefined {
  if (!config.LK_STATION_MEMBERSHIP_LIFETIME_ENABLED) return undefined;
  const raw: unknown = JSON.parse(config.SUBSCRIPTION_RUNTIME_DELEGATION_PRIVATE_KEYS ?? 'null');
  const keyId = config.SUBSCRIPTION_RUNTIME_DELEGATION_ACTIVE_KEY_ID;
  const key = object(raw) && keyId ? raw[keyId] : undefined;
  if (
    typeof key !== 'string' ||
    !keyId ||
    !config.SUBSCRIPTION_RUNTIME_DELEGATION_ISSUER ||
    !config.LK2_STATION_MEMBERSHIP_DELEGATION_AUDIENCE ||
    !config.GAME_COMMERCIAL_JOIN_OWNER_BASE_URL
  )
    throw new StationMembershipError();
  return {
    signer: new StationMembershipSigner({
      privateKeyPem: key,
      keyId,
      issuer: config.SUBSCRIPTION_RUNTIME_DELEGATION_ISSUER,
      audience: config.LK2_STATION_MEMBERSHIP_DELEGATION_AUDIENCE,
    }),
    client: new StationMembershipClient({
      baseUrl: config.GAME_COMMERCIAL_JOIN_OWNER_BASE_URL,
      timeoutMs: config.GAME_COMMERCIAL_JOIN_OWNER_TIMEOUT_MS,
      environment: ['local', 'ci'].includes(config.APP_ENV) ? 'development' : 'production',
      ...(onMetric ? { onMetric } : {}),
    }),
  };
}
