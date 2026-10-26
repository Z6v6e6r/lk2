import type {
  NotificationPushDeliveryPort,
  PushDeliveryRequest,
  PushDeliveryResult,
} from '@phub/notifications';

export interface FcmAccessTokenProvider {
  getAccessToken(): Promise<string>;
  invalidateAccessToken?(rejectedToken: string): void;
}
export type FcmProviderOutcome =
  | 'ACCEPTED'
  | 'FCM_TOKEN_UNREGISTERED'
  | 'FCM_PROVIDER_REJECTED'
  | 'FCM_AUTH_REJECTED'
  | 'FCM_PROVIDER_RETRYABLE'
  | 'FCM_NETWORK_FAILURE'
  | 'FCM_CIRCUIT_OPEN';

interface FcmResponse {
  name?: unknown;
  error?: { details?: readonly { '@type'?: unknown; errorCode?: unknown }[] };
}
function fcmErrorCode(details: unknown): unknown {
  if (!Array.isArray(details)) return undefined;
  for (const raw of details as readonly unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const detail = raw as Record<string, unknown>;
    if (detail['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError')
      return detail.errorCode;
  }
  return undefined;
}
async function boundedJson(response: Response): Promise<FcmResponse> {
  if (Number(response.headers.get('content-length')) > 16_384)
    throw new Error('FCM_RESPONSE_INVALID');
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 16_384) throw new Error('FCM_RESPONSE_INVALID');
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as FcmResponse;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** One fixed Google project; credentials, retries and circuit state stay on the worker. */
export class FcmDeliveryAdapter implements NotificationPushDeliveryPort {
  public readonly platform = 'ANDROID' as const;
  private failures = 0;
  private openUntil = 0;
  public constructor(
    private readonly options: {
      readonly projectId: string;
      readonly timeoutMs: number;
      readonly accessTokenProvider: FcmAccessTokenProvider;
      readonly fetchImplementation?: typeof fetch;
      readonly now?: () => number;
      readonly circuitFailureThreshold?: number;
      readonly circuitResetMs?: number;
      readonly onProviderOutcome?: (outcome: FcmProviderOutcome) => void;
    },
  ) {
    if (
      !/^[a-z][a-z0-9-]{3,62}$/u.test(options.projectId) ||
      !Number.isFinite(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 30_000
    )
      throw new Error('FCM_RUNTIME_CONFIGURATION_INVALID');
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private observe(result: PushDeliveryResult): PushDeliveryResult {
    try {
      this.options.onProviderOutcome?.(
        (result.outcome === 'accepted' ? 'ACCEPTED' : result.errorCode) as FcmProviderOutcome,
      );
    } catch {
      /* Telemetry cannot change provider delivery evidence or retries. */
    }
    if (result.outcome === 'retryable_failure' && result.errorCode !== 'FCM_CIRCUIT_OPEN') {
      this.failures += 1;
      if (this.failures >= (this.options.circuitFailureThreshold ?? 3))
        this.openUntil =
          this.now() + Math.max(this.options.circuitResetMs ?? 30_000, result.retryAfterMs ?? 0);
    } else if (result.outcome !== 'retryable_failure') {
      this.failures = 0;
      this.openUntil = 0;
    }
    return result;
  }
  public async send(request: PushDeliveryRequest): Promise<PushDeliveryResult> {
    if (this.openUntil > this.now())
      return this.observe({
        outcome: 'retryable_failure',
        errorCode: 'FCM_CIRCUIT_OPEN',
        retryAfterMs: this.openUntil - this.now(),
      });
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<PushDeliveryResult>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve({ outcome: 'retryable_failure', errorCode: 'FCM_NETWORK_FAILURE' });
      }, this.options.timeoutMs);
    });
    try {
      return this.observe(await Promise.race([this.deliver(request, controller.signal), expired]));
    } catch {
      return this.observe({ outcome: 'retryable_failure', errorCode: 'FCM_NETWORK_FAILURE' });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  private async deliver(
    request: PushDeliveryRequest,
    signal: AbortSignal,
  ): Promise<PushDeliveryResult> {
    const token = await this.options.accessTokenProvider.getAccessToken();
    if (signal.aborted) throw new Error('FCM_TIMEOUT');
    const response = await (this.options.fetchImplementation ?? fetch)(
      'https://fcm.googleapis.com/v1/projects/' + this.options.projectId + '/messages:send',
      {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: request.endpoint,
            data: request.data ?? {},
            android: { collapse_key: request.deliveryId, priority: 'high', ttl: '86400s' },
          },
        }),
      },
    );
    if (signal.aborted) throw new Error('FCM_TIMEOUT');
    // OAuth rejection must retire the matching cached credential even with a malformed error body.
    if (response.status === 401 || response.status === 403) {
      if (response.status === 401) this.options.accessTokenProvider.invalidateAccessToken?.(token);
      void response.body?.cancel().catch(() => undefined);
      return { outcome: 'retryable_failure', errorCode: 'FCM_AUTH_REJECTED' };
    }
    const body = await boundedJson(response);
    if (signal.aborted) throw new Error('FCM_TIMEOUT');
    if (
      response.ok &&
      typeof body.name === 'string' &&
      body.name.length > 0 &&
      body.name.length <= 500
    )
      return { outcome: 'accepted', externalMessageId: body.name };
    const fcmError = fcmErrorCode(body.error?.details);
    if (fcmError === 'UNREGISTERED')
      return { outcome: 'terminal_failure', errorCode: 'FCM_TOKEN_UNREGISTERED', invalidate: true };
    if (response.status === 429 || response.status >= 500) {
      const raw = response.headers.get('retry-after');
      const delay =
        raw && /^\d+$/u.test(raw) ? Number(raw) * 1000 : raw ? Date.parse(raw) - this.now() : 0;
      return {
        outcome: 'retryable_failure',
        errorCode: 'FCM_PROVIDER_RETRYABLE',
        ...(Number.isFinite(delay) && delay > 0
          ? { retryAfterMs: Math.min(delay, 3_600_000) }
          : {}),
      };
    }
    return { outcome: 'terminal_failure', errorCode: 'FCM_PROVIDER_REJECTED', invalidate: false };
  }
}
