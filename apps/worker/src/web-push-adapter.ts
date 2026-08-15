import { createHash } from 'node:crypto';
import { lookup } from 'node:dns';
import { Agent } from 'node:https';
import type { LookupFunction } from 'node:net';

import {
  isWebPushEndpointOriginAllowed,
  webPushSubscriptionSchema,
  type NotificationPushDeliveryPort,
  type PushDeliveryRequest,
  type PushDeliveryResult,
} from '@phub/notifications';
import webPush, { type PushSubscription, type RequestOptions, type SendResult } from 'web-push';
import ipaddr from 'ipaddr.js';

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

export const WEB_PUSH_PROVIDER_OUTCOMES = [
  'ACCEPTED',
  'WEB_PUSH_AUTH_REJECTED',
  'WEB_PUSH_CIRCUIT_OPEN',
  'WEB_PUSH_EGRESS_BLOCKED',
  'WEB_PUSH_ENDPOINT_ORIGIN_NOT_ALLOWED',
  'WEB_PUSH_NETWORK_FAILURE',
  'WEB_PUSH_PROVIDER_REJECTED',
  'WEB_PUSH_PROVIDER_RETRYABLE',
  'WEB_PUSH_SUBSCRIPTION_GONE',
  'WEB_PUSH_SUBSCRIPTION_INVALID',
] as const;

export type WebPushProviderOutcome = (typeof WEB_PUSH_PROVIDER_OUTCOMES)[number];

function providerOutcome(result: PushDeliveryResult): WebPushProviderOutcome {
  if (result.outcome === 'accepted') return 'ACCEPTED';
  return WEB_PUSH_PROVIDER_OUTCOMES.includes(result.errorCode as WebPushProviderOutcome)
    ? (result.errorCode as WebPushProviderOutcome)
    : 'WEB_PUSH_NETWORK_FAILURE';
}

export function isPublicWebPushAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.parse(address);
  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
    return parsed.toIPv4Address().range() === 'unicast';
  }
  return parsed.range() === 'unicast';
}

export function areAllWebPushAddressesPublic(addresses: readonly string[]): boolean {
  return addresses.length > 0 && addresses.every(isPublicWebPushAddress);
}

function egressBlockedError(): NodeJS.ErrnoException {
  const error = new Error('Web Push endpoint resolved outside the public network');
  return Object.assign(error, { code: 'WEB_PUSH_EGRESS_BLOCKED' });
}

function createPublicWebPushLookup(): LookupFunction {
  return (hostname, options, callback) => {
    lookup(
      hostname,
      {
        all: true,
        verbatim: true,
        ...(options.family === 4 || options.family === 6 ? { family: options.family } : {}),
        ...(options.hints === undefined ? {} : { hints: options.hints }),
      },
      (error, addresses) => {
        if (error) {
          callback(error, []);
          return;
        }
        if (!areAllWebPushAddressesPublic(addresses.map(({ address }) => address))) {
          callback(egressBlockedError(), []);
          return;
        }
        if (options.all) {
          callback(null, addresses);
          return;
        }
        const selected = addresses[0];
        if (!selected) {
          callback(egressBlockedError(), []);
          return;
        }
        callback(null, selected.address, selected.family);
      },
    );
  };
}

export function mapWebPushFailure(error: unknown): PushDeliveryResult {
  if ((error as NodeJS.ErrnoException | undefined)?.code === 'WEB_PUSH_EGRESS_BLOCKED') {
    return {
      outcome: 'terminal_failure',
      errorCode: 'WEB_PUSH_EGRESS_BLOCKED',
      invalidate: false,
      suspendPolicy: true,
    };
  }
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
  private readonly halfOpenProbes = new Set<string>();
  private readonly egressAgent = new Agent({
    keepAlive: true,
    maxSockets: 20,
    lookup: createPublicWebPushLookup(),
  });

  public constructor(
    private readonly options: {
      readonly subject: string;
      readonly publicKey: string;
      readonly privateKey: string;
      readonly ttlSeconds: number;
      readonly timeoutMs: number;
      readonly circuitFailureThreshold: number;
      readonly circuitResetMs: number;
      readonly allowedEndpointOrigins: readonly string[];
      readonly sendImplementation?: SendImplementation;
      readonly now?: () => number;
      readonly onProviderOutcome?: (outcome: WebPushProviderOutcome) => void;
    },
  ) {}

  private observe(result: PushDeliveryResult): PushDeliveryResult {
    try {
      this.options.onProviderOutcome?.(providerOutcome(result));
    } catch {
      // Delivery correctness must not depend on telemetry export availability.
    }
    return result;
  }

  public async send(request: PushDeliveryRequest): Promise<PushDeliveryResult> {
    const now = this.options.now?.() ?? Date.now();
    const circuit = this.circuits.get(request.providerAccountId);
    if (circuit && circuit.openUntil > now) {
      return this.observe({ outcome: 'retryable_failure', errorCode: 'WEB_PUSH_CIRCUIT_OPEN' });
    }
    let rawEndpoint: unknown;
    try {
      rawEndpoint = JSON.parse(request.endpoint) as unknown;
    } catch {
      rawEndpoint = undefined;
    }
    const decoded = webPushSubscriptionSchema.safeParse(rawEndpoint);
    if (
      !decoded.success ||
      !isWebPushEndpointOriginAllowed(decoded.data.endpoint, this.options.allowedEndpointOrigins)
    ) {
      return this.observe({
        outcome: 'terminal_failure',
        errorCode: decoded.success
          ? 'WEB_PUSH_ENDPOINT_ORIGIN_NOT_ALLOWED'
          : 'WEB_PUSH_SUBSCRIPTION_INVALID',
        invalidate: !decoded.success,
        ...(decoded.success ? { suspendPolicy: true } : {}),
      });
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
    const currentCircuit = this.circuits.get(request.providerAccountId);
    const providerCallAt = this.options.now?.() ?? Date.now();
    let ownsHalfOpenProbe = false;
    if (currentCircuit?.openUntil && currentCircuit.openUntil <= providerCallAt) {
      if (this.halfOpenProbes.has(request.providerAccountId)) {
        return this.observe({
          outcome: 'retryable_failure',
          errorCode: 'WEB_PUSH_CIRCUIT_OPEN',
        });
      }
      this.halfOpenProbes.add(request.providerAccountId);
      ownsHalfOpenProbe = true;
    } else if (currentCircuit && currentCircuit.openUntil > providerCallAt) {
      return this.observe({ outcome: 'retryable_failure', errorCode: 'WEB_PUSH_CIRCUIT_OPEN' });
    }
    try {
      await send(subscription, payload, {
        vapidDetails: {
          subject: this.options.subject,
          publicKey: this.options.publicKey,
          privateKey: this.options.privateKey,
        },
        TTL: this.options.ttlSeconds,
        timeout: this.options.timeoutMs,
        agent: this.egressAgent,
        contentEncoding: 'aes128gcm',
        urgency: 'normal',
        topic: createHash('sha256')
          .update(request.providerIdempotencyKey)
          .digest('base64url')
          .slice(0, 32),
      });
      this.circuits.delete(request.providerAccountId);
      return this.observe({ outcome: 'accepted' });
    } catch (error) {
      const result = mapWebPushFailure(error);
      if (result.outcome === 'retryable_failure') {
        const failures = (this.circuits.get(request.providerAccountId)?.failures ?? 0) + 1;
        const failedAt = this.options.now?.() ?? Date.now();
        this.circuits.set(request.providerAccountId, {
          failures,
          openUntil:
            failures >= this.options.circuitFailureThreshold
              ? failedAt + this.options.circuitResetMs
              : 0,
        });
      } else {
        // A terminal response is endpoint/policy-specific, not a provider-account outage.
        this.circuits.delete(request.providerAccountId);
      }
      return this.observe(result);
    } finally {
      if (ownsHalfOpenProbe) this.halfOpenProbes.delete(request.providerAccountId);
    }
  }
}
