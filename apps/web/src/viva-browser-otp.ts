export interface VivaBrowserOtpTransport {
  readonly kind: 'browser_phone_otp_v1';
  readonly requestCodeUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly channel: string;
  readonly providerTenantKey: string;
  readonly phoneNumber: string;
}

export const VIVA_BROWSER_OTP_TIMEOUT_MS = 3_000;

export class VivaBrowserOtpError extends Error {
  public constructor(
    public readonly code: 'AUTH_CODE_INVALID' | 'AUTH_RATE_LIMITED' | 'AUTH_PROVIDER_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'VivaBrowserOtpError';
  }
}

function mapResponse(response: Response): never {
  if (response.status === 400 || response.status === 401) {
    throw new VivaBrowserOtpError('AUTH_CODE_INVALID');
  }
  if (response.status === 429) throw new VivaBrowserOtpError('AUTH_RATE_LIMITED');
  throw new VivaBrowserOtpError('AUTH_PROVIDER_UNAVAILABLE');
}

async function browserFetch(url: URL | string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VIVA_BROWSER_OTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Viva's public phone OTP endpoints are deliberately invoked by the real web
 * browser. Do not add cookies, PadlHub headers or automatic retries here:
 * sending a code and exchanging it are provider-side effects.
 */
export async function requestVivaBrowserPhoneCode(
  transport: VivaBrowserOtpTransport,
): Promise<void> {
  const url = new URL(transport.requestCodeUrl);
  url.searchParams.set('phoneNumber', transport.phoneNumber);
  url.searchParams.set('channel', transport.channel);
  url.searchParams.set('tenantKey', transport.providerTenantKey);
  let response: Response;
  try {
    response = await browserFetch(url, { method: 'GET', credentials: 'omit' });
  } catch {
    throw new VivaBrowserOtpError('AUTH_PROVIDER_UNAVAILABLE');
  }
  if (!response.ok) mapResponse(response);
}

export async function exchangeVivaBrowserPhoneCode(
  transport: VivaBrowserOtpTransport,
  code: string,
): Promise<string> {
  if (!/^\d{4}$/.test(code)) throw new VivaBrowserOtpError('AUTH_CODE_INVALID');
  let response: Response;
  try {
    response = await browserFetch(transport.tokenUrl, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        phone_number: transport.phoneNumber,
        code,
        client_id: transport.clientId,
        tenant_key: transport.providerTenantKey,
      }).toString(),
    });
  } catch {
    throw new VivaBrowserOtpError('AUTH_PROVIDER_UNAVAILABLE');
  }
  if (!response.ok) mapResponse(response);
  const result: unknown = await response.json().catch(() => undefined);
  if (
    !result ||
    typeof result !== 'object' ||
    typeof (result as { access_token?: unknown }).access_token !== 'string'
  ) {
    throw new VivaBrowserOtpError('AUTH_PROVIDER_UNAVAILABLE');
  }
  // `refresh_token`, if returned by Viva, is intentionally ignored and never crosses this boundary.
  return (result as { access_token: string }).access_token;
}
