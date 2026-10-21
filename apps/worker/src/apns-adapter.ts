import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import type {
  NotificationPushDeliveryPort,
  PushDeliveryRequest,
  PushDeliveryResult,
} from '@phub/notifications';
import { z } from 'zod';
import { readNotificationCredentialFile } from './notification-provider-credentials.js';

const credentials = z
  .object({
    teamId: z.string().regex(/^[A-Z0-9]{10}$/),
    keyId: z.string().regex(/^[A-Z0-9]{10}$/),
    privateKey: z.string().min(32).max(12_000),
  })
  .strict();
export class ApnsTokenProvider {
  private cached: { token: string; until: number } | undefined;
  private constructor(
    private readonly teamId: string,
    private readonly keyId: string,
    private readonly key: KeyObject,
    private readonly now: () => number,
  ) {}
  static async create(path: string, now: () => number = Date.now): Promise<ApnsTokenProvider> {
    const parsed = credentials.parse(await readNotificationCredentialFile(path));
    const key = createPrivateKey(parsed.privateKey);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
      throw new Error('APNS_KEY_INVALID');
    return new ApnsTokenProvider(parsed.teamId, parsed.keyId, key, now);
  }
  getToken(): string {
    if (this.cached && this.cached.until > this.now()) return this.cached.token;
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: this.keyId })).toString(
      'base64url',
    );
    const body = Buffer.from(
      JSON.stringify({ iss: this.teamId, iat: Math.floor(this.now() / 1000) }),
    ).toString('base64url');
    const unsigned = `${header}.${body}`;
    const signature = sign('sha256', Buffer.from(unsigned), {
      key: this.key,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    const token = `${unsigned}.${signature}`;
    this.cached = { token, until: this.now() + 40 * 60_000 };
    return token;
  }
  invalidate(): void {
    this.cached = undefined;
  }
}

export class ApnsDeliveryAdapter implements NotificationPushDeliveryPort {
  readonly platform = 'IOS' as const;
  private failures = 0;
  private openUntil = 0;
  constructor(
    private readonly options: {
      topic: string;
      environment: 'SANDBOX' | 'PRODUCTION';
      tokenProvider: Pick<ApnsTokenProvider, 'getToken' | 'invalidate'>;
      timeoutMs: number;
      connectImplementation?: typeof connect;
      now?: () => number;
      onOutcome?: (code: string) => void;
    },
  ) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9.-]{1,299}$/.test(options.topic) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 30_000
    )
      throw new Error('APNS_CONFIGURATION_INVALID');
  }
  private observe(result: PushDeliveryResult): PushDeliveryResult {
    if (
      result.outcome !== 'accepted' &&
      result.errorCode !== 'APNS_CIRCUIT_OPEN' &&
      (result.outcome === 'retryable_failure' || result.errorCode === 'APNS_OUTCOME_UNKNOWN')
    ) {
      if (++this.failures >= 3) this.openUntil = (this.options.now?.() ?? Date.now()) + 30_000;
    } else if (result.outcome !== 'retryable_failure') {
      this.failures = 0;
      this.openUntil = 0;
    }
    try {
      this.options.onOutcome?.(result.outcome === 'accepted' ? 'ACCEPTED' : result.errorCode);
    } catch {
      /* Telemetry is not delivery evidence. */
    }
    return result;
  }
  async send(request: PushDeliveryRequest): Promise<PushDeliveryResult> {
    const now = this.options.now?.() ?? Date.now();
    if (this.openUntil > now)
      return this.observe({
        outcome: 'retryable_failure',
        errorCode: 'APNS_CIRCUIT_OPEN',
        retryAfterMs: this.openUntil - now,
      });
    if (
      request.platform !== 'IOS' ||
      !/^[a-f0-9]{32,1024}$/i.test(request.endpoint) ||
      request.endpoint.length % 2 !== 0
    )
      return this.observe({
        outcome: 'terminal_failure',
        errorCode: 'APNS_TOKEN_INVALID',
        invalidate: true,
      });
    const payload = JSON.stringify({
      aps: { alert: { title: 'ПадлхАБ', body: 'Новое уведомление' }, sound: 'default' },
      notificationId: request.notification.id,
      deepLink: '/notifications',
    });
    const origin =
      this.options.environment === 'SANDBOX'
        ? 'https://api.sandbox.push.apple.com'
        : 'https://api.push.apple.com';
    const result = await new Promise<PushDeliveryResult>((resolve) => {
      let session: ClientHttp2Session | undefined;
      let completed = false;
      let submitted = false;
      const networkFailure = (): PushDeliveryResult =>
        submitted
          ? { outcome: 'terminal_failure', errorCode: 'APNS_OUTCOME_UNKNOWN', invalidate: false }
          : { outcome: 'retryable_failure', errorCode: 'APNS_NETWORK_FAILURE' };
      const finish = (value: PushDeliveryResult): void => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        session?.destroy();
        resolve(value);
      };
      const timer = setTimeout(() => finish(networkFailure()), this.options.timeoutMs);
      try {
        session = (this.options.connectImplementation ?? connect)(origin, {
          settings: { enablePush: false },
        });
        session.on('error', () => finish(networkFailure()));
        const stream = session.request({
          ':method': 'POST',
          ':path': `/3/device/${request.endpoint.toLowerCase()}`,
          authorization: `bearer ${this.options.tokenProvider.getToken()}`,
          'apns-topic': this.options.topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-id': request.deliveryId,
          'apns-collapse-id': request.deliveryId,
          'apns-expiration': String(Math.floor(now / 1000) + (request.ttlSeconds ?? 3600)),
          'content-type': 'application/json',
        });
        let status = 0;
        let responseId: string | undefined;
        let size = 0;
        const chunks: Buffer[] = [];
        stream.on('response', (headers) => {
          status = Number(headers[':status']);
          const value = headers['apns-id'];
          if (typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value)) responseId = value;
        });
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16_384) {
            stream.close(constants.NGHTTP2_CANCEL);
            finish(networkFailure());
          } else chunks.push(chunk);
        });
        stream.on('error', () => finish(networkFailure()));
        stream.on('end', () => {
          if (status === 200)
            return finish({
              outcome: 'accepted',
              externalMessageId: responseId ?? request.deliveryId,
            });
          let reason: unknown;
          try {
            reason = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { reason?: unknown })
              .reason;
          } catch {
            /* Ignore untrusted provider body. */
          }
          if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered')
            return finish({
              outcome: 'terminal_failure',
              errorCode: 'APNS_TOKEN_INVALID',
              invalidate: true,
            });
          if (status === 403) {
            this.options.tokenProvider.invalidate();
            return finish({ outcome: 'retryable_failure', errorCode: 'APNS_AUTH_REJECTED' });
          }
          if (status === 429 || status >= 500)
            return finish({
              outcome: 'retryable_failure',
              errorCode: 'APNS_PROVIDER_RETRYABLE',
              retryAfterMs: 30_000,
            });
          finish({
            outcome: 'terminal_failure',
            errorCode: 'APNS_PROVIDER_REJECTED',
            invalidate: false,
          });
        });
        submitted = true;
        stream.end(payload);
      } catch {
        finish(networkFailure());
      }
    });
    return this.observe(result);
  }
}
