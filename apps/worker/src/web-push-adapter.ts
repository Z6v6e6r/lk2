import { createHash } from 'node:crypto';

import {
  webPushSubscriptionSchema,
  type NotificationPushDeliveryPort,
  type PushDeliveryRequest,
  type PushDeliveryResult,
} from '@phub/notifications';
import webPush, { type PushSubscription, type RequestOptions, type SendResult } from 'web-push';

const { sendNotification, WebPushError } = webPush;

type SendImplementation = (
  subscription: PushSubscription,
  payload: string,
  options: RequestOptions,
) => Promise<SendResult>;

interface CircuitState {
  failures: number;
  openUntil: number;
}

export function mapWebPushFailure(error: unknown): PushDeliveryResult {
  if (error instanceof WebPushError) {
    if (error.statusCode === 404 || error.statusCode === 410) {
      return {
        outcome: 'terminal_failure',
        errorCode: 'WEB_PUSH_SUBSCRIPTION_GONE',
        invalidate: true,
      };
    }
    if (error.statusCode === 400) {
      return {
        outcome: 'terminal_failure',
        errorCode: 'WEB_PUSH_SUBSCRIPTION_INVALID',
        invalidate: true,
      };
    }
    if (error.statusCode === 401 || error.statusCode === 403) {
      return {
        outcome: 'retryable_failure',
        errorCode: 'WEB_PUSH_AUTH_REJECTED',
      };
    }
    if (error.statusCode === 429 || error.statusCode >= 500) {
      return { outcome: 'retryable_failure', errorCode: 'WEB_PUSH_PROVIDER_RETRYABLE' };
    }
    return {
      outcome: 'terminal_failure',
      errorCode: 'WEB_PUSH_PROVIDER_REJECTED',
      invalidate: false,
    };
  }
  return { outcome: 'retryable_failure', errorCode: 'WEB_PUSH_NETWORK_FAILURE' };
}

export class WebPushDeliveryAdapter implements NotificationPushDeliveryPort {
  public readonly platform = 'WEB' as const;
  private readonly circuits = new Map<string, CircuitState>();

  public constructor(
    private readonly options: {
      readonly subject: string;
      readonly publicKey: string;
      readonly privateKey: string;
      readonly ttlSeconds: number;
      readonly timeoutMs: number;
      readonly circuitFailureThreshold: number;
      readonly circuitResetMs: number;
      readonly sendImplementation?: SendImplementation;
      readonly now?: () => number;
    },
  ) {}

  public async send(request: PushDeliveryRequest): Promise<PushDeliveryResult> {
    const now = this.options.now?.() ?? Date.now();
    const circuit = this.circuits.get(request.providerAccountId);
    if (circuit && circuit.openUntil > now) {
      return { outcome: 'retryable_failure', errorCode: 'WEB_PUSH_CIRCUIT_OPEN' };
    }
    const decoded = webPushSubscriptionSchema.safeParse(JSON.parse(request.endpoint) as unknown);
    if (!decoded.success) {
      return {
        outcome: 'terminal_failure',
        errorCode: 'WEB_PUSH_SUBSCRIPTION_INVALID',
        invalidate: true,
      };
    }
    const payload = JSON.stringify({
      notificationId: request.notification.id,
      title: request.notification.title,
      preview: request.notification.preview,
      ...(request.notification.deepLink ? { deepLink: request.notification.deepLink } : {}),
    });
    const subscription: PushSubscription = {
      endpoint: decoded.data.endpoint,
      keys: decoded.data.keys,
      ...(decoded.data.expirationTime === undefined
        ? {}
        : { expirationTime: decoded.data.expirationTime }),
    };
    const send = this.options.sendImplementation ?? sendNotification;
    try {
      await send(subscription, payload, {
        vapidDetails: {
          subject: this.options.subject,
          publicKey: this.options.publicKey,
          privateKey: this.options.privateKey,
        },
        TTL: this.options.ttlSeconds,
        timeout: this.options.timeoutMs,
        contentEncoding: 'aes128gcm',
        urgency: 'normal',
        topic: createHash('sha256')
          .update(request.providerIdempotencyKey)
          .digest('base64url')
          .slice(0, 32),
      });
      this.circuits.delete(request.providerAccountId);
      return { outcome: 'accepted' };
    } catch (error) {
      const result = mapWebPushFailure(error);
      if (result.outcome === 'retryable_failure') {
        const failures = (circuit?.failures ?? 0) + 1;
        this.circuits.set(request.providerAccountId, {
          failures,
          openUntil:
            failures >= this.options.circuitFailureThreshold
              ? now + this.options.circuitResetMs
              : 0,
        });
      }
      return result;
    }
  }
}
