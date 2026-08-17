export interface VerifiedLegacyLkActor {
  readonly issuer: string;
  readonly subject: string;
  readonly clientId?: string;
  readonly phoneNorm: string;
  readonly name?: string;
  readonly tenantKey: string;
  readonly authorizedParty: string;
}

export interface LegacyLkIdentityVerifier {
  verify(authorization: string): Promise<VerifiedLegacyLkActor>;
}

export class LegacyLkIdentityVerificationError extends Error {
  public constructor(
    public readonly outcome: 'rejected' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'LegacyLkIdentityVerificationError';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function parseActor(payload: unknown): VerifiedLegacyLkActor | undefined {
  const root = record(payload);
  const actor = record(root?.actor);
  const issuer = nonEmptyString(actor?.issuer);
  const subject = nonEmptyString(actor?.subject);
  const phoneNorm = nonEmptyString(actor?.phoneNorm);
  const tenantKey = nonEmptyString(actor?.tenantKey);
  const authorizedParty = nonEmptyString(actor?.authorizedParty);
  if (
    root?.ok !== true ||
    actor?.verified !== true ||
    actor?.source !== 'cup-keycloak-jwt' ||
    !issuer ||
    !subject ||
    !phoneNorm ||
    !tenantKey ||
    !authorizedParty
  ) {
    return undefined;
  }
  const clientId = nonEmptyString(actor.clientId);
  const name = nonEmptyString(actor.name);
  return {
    issuer,
    subject,
    phoneNorm,
    tenantKey,
    authorizedParty,
    ...(clientId ? { clientId } : {}),
    ...(name ? { name } : {}),
  };
}

export class CupLegacyLkIdentityVerifier implements LegacyLkIdentityVerifier {
  public constructor(
    private readonly options: {
      readonly url: string;
      readonly integrationToken: string;
      readonly timeoutMs: number;
      readonly fetchImplementation?: typeof fetch;
    },
  ) {}

  public async verify(authorization: string): Promise<VerifiedLegacyLkActor> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await (this.options.fetchImplementation ?? fetch)(this.options.url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: authorization,
          'X-CUP-Integration-Token': this.options.integrationToken,
        },
        signal: controller.signal,
      });
      const rawPayload = await response.text().catch(() => '');
      let payload: unknown = null;
      try {
        payload = rawPayload ? (JSON.parse(rawPayload) as unknown) : null;
      } catch {
        payload = null;
      }
      if (response.status === 401 || response.status === 403) {
        throw new LegacyLkIdentityVerificationError('rejected', 'LEGACY_LK_IDENTITY_REJECTED');
      }
      if (!response.ok) {
        throw new LegacyLkIdentityVerificationError(
          'unavailable',
          'LEGACY_LK_IDENTITY_UNAVAILABLE',
        );
      }
      const actor = parseActor(payload);
      if (!actor) {
        throw new LegacyLkIdentityVerificationError(
          'unavailable',
          'LEGACY_LK_IDENTITY_RESPONSE_INVALID',
        );
      }
      return actor;
    } catch (error) {
      if (error instanceof LegacyLkIdentityVerificationError) throw error;
      throw new LegacyLkIdentityVerificationError('unavailable', 'LEGACY_LK_IDENTITY_UNAVAILABLE');
    } finally {
      clearTimeout(timeout);
    }
  }
}
