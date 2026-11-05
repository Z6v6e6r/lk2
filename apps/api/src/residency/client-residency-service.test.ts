/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from 'vitest';

import { VivaResidencySourceError, type VivaResidencyObservation } from '@phub/viva-adapter';

import {
  ClientResidencyService,
  type ClientResidencyServiceOptions,
} from './client-residency-service.js';

const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const DELIVERY_ID = '55555555-5555-4555-8555-555555555555';
const PROVIDER_CLIENT_ID = '66666666-6666-4666-8666-666666666666';
const CHECKED_AT = '2026-11-05T09:00:00.000Z';

function observation(active: boolean): VivaResidencyObservation {
  return {
    active,
    validFrom: active ? '2026-09-01' : null,
    validUntil: active ? '2027-09-01' : null,
    checkedAt: CHECKED_AT,
  };
}

type ServiceOverrides = Omit<Partial<ClientResidencyServiceOptions>, 'source'> & {
  readonly source?: ClientResidencyServiceOptions['source'] | null;
};

function service(overrides: ServiceOverrides = {}): ClientResidencyService {
  const { source, ...rest } = overrides;
  return new ClientResidencyService({
    productConfigured: true,
    ...(source === null
      ? {}
      : { source: source ?? { read: vi.fn(async () => observation(true)) } }),
    resolveVivaClientId: vi.fn(async () => PROVIDER_CLIENT_ID),
    profileRepository: {
      get: vi.fn(async () => ({
        userId: USER_ID,
        displayName: 'Иван Резидент',
        avatarUrl: 'https://viva.invalid/vendor-photo.jpg',
        levelLabel: null,
        levelValue: null,
      })),
    },
    photoRepository: {
      getPhotoDeliveryIds: vi.fn(async () => new Map([[USER_ID, DELIVERY_ID]])),
    },
    now: () => Date.parse(CHECKED_AT),
    ...rest,
  });
}

describe('ClientResidencyService', () => {
  it('returns one normalized ACTIVE answer with the reused PadlHub profile', async () => {
    const sourceRead = vi.fn(async () => observation(true));
    const resolveVivaClientId = vi.fn(async () => PROVIDER_CLIENT_ID);
    const status = await service({
      source: { read: sourceRead },
      resolveVivaClientId,
    }).getClientResidency({ tenantId: TENANT_ID, userId: USER_ID, correlationId: 'corr-1' });
    expect(status).toEqual({
      state: 'ACTIVE',
      validFrom: '2026-09-01',
      validUntil: '2027-09-01',
      checkedAt: CHECKED_AT,
      unavailableReason: null,
      holder: {
        displayName: 'Иван Резидент',
        avatarUrl: `/public/api/v1/media/profile-photos/${TENANT_ID}/${DELIVERY_ID}`,
      },
    });
    expect(resolveVivaClientId).toHaveBeenCalledWith({ tenantId: TENANT_ID, userId: USER_ID });
    expect(sourceRead).toHaveBeenCalledWith({
      providerClientId: PROVIDER_CLIENT_ID,
      correlationId: 'corr-1',
    });
  });

  it('distinguishes a proven absence from an unavailable check', async () => {
    const none = await service({
      source: { read: vi.fn(async () => observation(false)) },
    }).getClientResidency({ tenantId: TENANT_ID, userId: USER_ID, correlationId: 'corr-2' });
    expect(none).toMatchObject({
      state: 'NONE',
      checkedAt: CHECKED_AT,
      unavailableReason: null,
    });

    const unavailable = await service({
      source: {
        read: vi.fn(async () => {
          throw new VivaResidencySourceError('RESIDENCY_SOURCE_PARTIAL');
        }),
      },
    }).getClientResidency({ tenantId: TENANT_ID, userId: USER_ID, correlationId: 'corr-3' });
    expect(unavailable).toMatchObject({
      state: 'UNAVAILABLE',
      checkedAt: null,
      unavailableReason: 'SOURCE_PARTIAL',
    });
  });

  it('keeps an unconfigured residency product explicit without calling Viva', async () => {
    const sourceRead = vi.fn();
    const status = await service({
      productConfigured: false,
      source: { read: sourceRead },
    }).getClientResidency({ tenantId: TENANT_ID, userId: USER_ID, correlationId: 'corr-4' });
    expect(status).toMatchObject({
      state: 'UNAVAILABLE',
      checkedAt: null,
      unavailableReason: 'PRODUCT_NOT_CONFIGURED',
    });
    expect(status.holder?.displayName).toBe('Иван Резидент');
    expect(sourceRead).not.toHaveBeenCalled();
  });

  it('reports disabled and non-configured sources as unavailable reasons', async () => {
    const disabled = await service({
      source: null,
      sourceUnavailableReason: 'SOURCE_DISABLED',
    }).getClientResidency({ tenantId: TENANT_ID, userId: USER_ID, correlationId: 'corr-5' });
    expect(disabled).toMatchObject({
      state: 'UNAVAILABLE',
      unavailableReason: 'SOURCE_DISABLED',
    });
    const notConfigured = await service({
      source: null,
      sourceUnavailableReason: 'SOURCE_NOT_CONFIGURED',
    }).getClientResidency({ tenantId: TENANT_ID, userId: USER_ID, correlationId: 'corr-6' });
    expect(notConfigured).toMatchObject({
      state: 'UNAVAILABLE',
      unavailableReason: 'SOURCE_NOT_CONFIGURED',
    });
  });

  it('fails closed when the verified user has no unique Viva client mapping', async () => {
    const sourceRead = vi.fn();
    const status = await service({
      resolveVivaClientId: vi.fn(async () => undefined),
      source: { read: sourceRead },
    }).getClientResidency({ tenantId: TENANT_ID, userId: USER_ID, correlationId: 'corr-7' });
    expect(status).toMatchObject({
      state: 'UNAVAILABLE',
      unavailableReason: 'IDENTITY_MAPPING_MISSING',
    });
    expect(sourceRead).not.toHaveBeenCalled();
  });

  it('reports an identity lookup failure as unavailability instead of absence', async () => {
    const status = await service({
      resolveVivaClientId: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    }).getClientResidency({ tenantId: TENANT_ID, userId: USER_ID, correlationId: 'corr-8' });
    expect(status).toMatchObject({
      state: 'UNAVAILABLE',
      unavailableReason: 'IDENTITY_RESOLUTION_UNAVAILABLE',
    });
  });

  it('maps every provider source error to a stable unavailable reason', async () => {
    const cases = [
      ['RESIDENCY_SOURCE_DISABLED', 'SOURCE_DISABLED'],
      ['RESIDENCY_SOURCE_UNAVAILABLE', 'SOURCE_UNAVAILABLE'],
      ['RESIDENCY_SOURCE_TIMEOUT', 'SOURCE_TIMEOUT'],
      ['RESIDENCY_SOURCE_RESPONSE_INVALID', 'SOURCE_RESPONSE_INVALID'],
      ['RESIDENCY_SOURCE_PARTIAL', 'SOURCE_PARTIAL'],
      ['RESIDENCY_PRODUCT_IDENTITY_MISSING', 'PRODUCT_IDENTITY_MISSING'],
      ['RESIDENCY_OWNERSHIP_CONFLICT', 'OWNERSHIP_CONFLICT'],
      ['RESIDENCY_CIRCUIT_OPEN', 'CIRCUIT_OPEN'],
      ['RESIDENCY_PRODUCT_NOT_CONFIGURED', 'PRODUCT_NOT_CONFIGURED'],
    ] as const;
    for (const [sourceCode, reason] of cases) {
      const status = await service({
        source: {
          read: vi.fn(async () => {
            throw new VivaResidencySourceError(sourceCode);
          }),
        },
      }).getClientResidency({ tenantId: TENANT_ID, userId: USER_ID, correlationId: 'corr-9' });
      expect(status).toMatchObject({ state: 'UNAVAILABLE', unavailableReason: reason });
    }
  });

  it('maps an unexpected provider failure to unavailable rather than NONE', async () => {
    const status = await service({
      source: {
        read: vi.fn(async () => {
          throw new Error('unexpected');
        }),
      },
    }).getClientResidency({ tenantId: TENANT_ID, userId: USER_ID, correlationId: 'corr-10' });
    expect(status).toMatchObject({
      state: 'UNAVAILABLE',
      unavailableReason: 'SOURCE_UNAVAILABLE',
    });
  });

  it('still answers residency when the reused profile is absent', async () => {
    const status = await service({
      profileRepository: { get: vi.fn(async () => undefined) },
    }).getClientResidency({ tenantId: TENANT_ID, userId: USER_ID, correlationId: 'corr-11' });
    expect(status).toMatchObject({ state: 'ACTIVE', holder: null });
  });
});
