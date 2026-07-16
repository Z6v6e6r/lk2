import { describe, expect, it } from 'vitest';

import {
  SourceRouter,
  isValidIdempotencyKey,
  type SourcePolicy,
  type SourceRoutingContext,
} from './index.js';

const readPolicy: SourcePolicy = {
  operation: 'schedule.read',
  domain: 'schedule',
  preferredSource: 'LOCAL',
  fallback: ['DIRECT_VIVA', 'SERVER_VIVA', 'STALE_LOCAL'],
  criticalCommand: false,
  directVivaAllowed: true,
};

const baseContext: SourceRoutingContext = {
  tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  platform: 'ios',
  localState: 'fresh',
  serverVivaAvailable: true,
  serverVivaRateLimitRemaining: 100,
  directVivaFeatureEnabled: true,
  directVivaDelegationSupported: true,
  clientSupportsDirectViva: true,
};

describe('SourceRouter', () => {
  it('prefers fresh local data', () => {
    expect(new SourceRouter().decide(readPolicy, baseContext).strategy).toBe('LOCAL');
  });

  it('allows delegated reads on supported user clients', () => {
    const decision = new SourceRouter().decide(readPolicy, {
      ...baseContext,
      localState: 'missing',
    });

    expect(decision.strategy).toBe('DIRECT_VIVA');
  });

  it('never delegates a critical command to the client', () => {
    const decision = new SourceRouter().decide(
      {
        ...readPolicy,
        operation: 'booking.create',
        domain: 'booking',
        preferredSource: 'SERVER_VIVA',
        criticalCommand: true,
        directVivaAllowed: false,
      },
      { ...baseContext, localState: 'missing' },
    );

    expect(decision.strategy).toBe('SERVER_VIVA');
  });

  it('allows browser direct reads only when every server capability is present', () => {
    const decision = new SourceRouter().decide(readPolicy, {
      ...baseContext,
      platform: 'web',
      localState: 'missing',
      serverVivaAvailable: false,
      serverVivaRateLimitRemaining: 0,
    });

    expect(decision.strategy).toBe('DIRECT_VIVA');
  });

  it('uses stale local data only through the declared fallback', () => {
    const decision = new SourceRouter().decide(readPolicy, {
      ...baseContext,
      platform: 'web',
      localState: 'stale',
      serverVivaAvailable: false,
      serverVivaRateLimitRemaining: 0,
      directVivaFeatureEnabled: false,
    });

    expect(decision.strategy).toBe('STALE_LOCAL');
  });
});

describe('idempotency key validation', () => {
  it('accepts bounded opaque keys and rejects weak values', () => {
    expect(isValidIdempotencyKey('booking.create:123456789')).toBe(true);
    expect(isValidIdempotencyKey('short')).toBe(false);
    expect(isValidIdempotencyKey('invalid key with spaces')).toBe(false);
  });
});
