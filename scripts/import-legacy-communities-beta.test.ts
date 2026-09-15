import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import type { ProfilePhotoObjectStore } from '../apps/worker/src/profile-photo-sync.js';
import {
  buildLogoDirectoryItems,
  COMMUNITY_OWNER_MEMBERSHIP_UPSERT_SQL,
  COMMUNITY_UPSERT_SQL,
  LEGACY_COMMUNITIES_IMPORT_SCHEMA,
  mapLegacyCommunities,
  mapLegacyCommunity,
  parseLegacyCommunitiesPayload,
  readLegacyCommunitiesImportConfig,
  runLegacyCommunitiesImport,
  type LegacyCommunitySourceItem,
} from './import-legacy-communities-beta.js';

const OWNER_USER_ID = '11111111-1111-4111-8111-111111111111';
const PUBLIC_BASE_URL = 'https://padlhub.su';
const NOW = '2026-09-15T10:00:00.000Z';

const BASE_ENV: NodeJS.ProcessEnv = {
  APP_ENV: 'staging',
  LEGACY_COMMUNITIES_IMPORT_CONFIRM: 'beta-clone',
  LEGACY_COMMUNITIES_IMPORT_TENANT_KEY: 'local-padel',
  LEGACY_COMMUNITIES_PUBLIC_BASE_URL: PUBLIC_BASE_URL,
  LEGACY_COMMUNITIES_IMPORT_OWNER_USER_ID: OWNER_USER_ID,
  DATABASE_URL: 'postgres://import:not-a-real-secret@127.0.0.1:5432/padlhub',
  S3_ENDPOINT: 'https://s3.example.test',
  S3_PUBLIC_ENDPOINT: 'https://media.example.test',
  S3_BUCKET: 'padlhub-media',
  S3_ACCESS_KEY: 'access-key',
  S3_SECRET_KEY: 'secret-key',
};

function expectGateCode(env: NodeJS.ProcessEnv, code: string): void {
  expect(() => readLegacyCommunitiesImportConfig(env)).toThrowError(code);
}

function sourceItem(overrides: Partial<LegacyCommunitySourceItem> = {}): LegacyCommunitySourceItem {
  return {
    id: 'community_1789117751110_звездопад',
    name: 'Звездопад',
    logoUrl: 'https://padlhub.su/media/communities/zvezdopad.png',
    isVerified: true,
    visibility: 'OPEN',
    description: 'Открытое сообщество',
    joinRule: 'INSTANT',
    createdAt: '2024-05-01T09:00:00.000Z',
    updatedAt: '2025-01-02T10:00:00.000Z',
    ...overrides,
  };
}

function mappedSourceItem(item: LegacyCommunitySourceItem, now = NOW) {
  const outcome = mapLegacyCommunity(item, { now });
  if (outcome.kind !== 'mapped') {
    throw new Error(`expected a mapped community but the item was skipped: ${outcome.reason}`);
  }
  return outcome;
}

/** A raw public-summary row with every documented legacy field plus room for extra keys. */
function rawCommunity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'community_1789117751110_example',
    name: 'Example community',
    slug: 'example-community',
    logo: null,
    logoUrl: 'https://padlhub.su/media/communities/example.png',
    logoThumbUrl: null,
    isVerified: false,
    visibility: 'OPEN',
    description: 'Example description',
    city: 'Москва',
    focusTags: ['padel'],
    minimumLevel: 'D',
    joinRule: 'INSTANT',
    rules: [],
    inviteCode: null,
    inviteLink: null,
    createdAt: '2024-05-01T09:00:00.000Z',
    updatedAt: '2025-01-02T10:00:00.000Z',
    members: [],
    ...overrides,
  };
}

describe('gating and environment validation', () => {
  it('accepts the staging beta configuration and applies the documented defaults', () => {
    const config = readLegacyCommunitiesImportConfig(BASE_ENV);
    expect(config.tenantKey).toBe('local-padel');
    expect(config.publicBaseUrl).toBe('https://padlhub.su/');
    expect(config.limit).toBe(500);
    expect(config.publicTimeoutMs).toBe(120_000);
    expect(config.dryRun).toBe(false);
    expect(config.skipLogos).toBe(false);
    expect(config.media?.s3Region).toBe('ru-1');
    expect(config.media?.s3ForcePathStyle).toBe(true);
    expect(config.media?.readUrlTtlSeconds).toBe(3_600);
    expect(config.media?.maxBytes).toBe(8_388_608);
    expect(config.media?.maxDimension).toBe(1_024);
    expect(config.media?.webpQuality).toBe(82);
    expect(config.media?.allowedHosts).toEqual(['padlhub.su']);
  });

  it('rejects a non-staging APP_ENV', () => {
    expectGateCode(
      { ...BASE_ENV, APP_ENV: 'production' },
      'LEGACY_COMMUNITIES_BETA_IMPORT_REQUIRES_APP_ENV_STAGING',
    );
    expectGateCode(
      { ...BASE_ENV, APP_ENV: undefined },
      'LEGACY_COMMUNITIES_BETA_IMPORT_REQUIRES_APP_ENV_STAGING',
    );
  });

  it('requires the explicit confirmation token', () => {
    expectGateCode(
      { ...BASE_ENV, LEGACY_COMMUNITIES_IMPORT_CONFIRM: 'local-clone' },
      'LEGACY_COMMUNITIES_IMPORT_CONFIRM_REQUIRED',
    );
    expectGateCode(
      { ...BASE_ENV, LEGACY_COMMUNITIES_IMPORT_CONFIRM: undefined },
      'LEGACY_COMMUNITIES_IMPORT_CONFIRM_REQUIRED',
    );
  });

  it('rejects a tenant outside the allowlist', () => {
    expectGateCode(
      { ...BASE_ENV, LEGACY_COMMUNITIES_IMPORT_TENANT_KEY: 'another-tenant' },
      'LEGACY_COMMUNITIES_BETA_IMPORT_TENANT_NOT_ALLOWED',
    );
    expectGateCode(
      { ...BASE_ENV, LEGACY_COMMUNITIES_IMPORT_TENANT_KEY: undefined },
      'LEGACY_COMMUNITIES_BETA_IMPORT_TENANT_NOT_ALLOWED',
    );
  });

  it('rejects a non-HTTPS public source', () => {
    expectGateCode(
      { ...BASE_ENV, LEGACY_COMMUNITIES_PUBLIC_BASE_URL: 'http://padlhub.su' },
      'LEGACY_COMMUNITIES_PUBLIC_SOURCE_NOT_HTTPS',
    );
    expectGateCode(
      { ...BASE_ENV, LEGACY_COMMUNITIES_PUBLIC_BASE_URL: 'not a url' },
      'LEGACY_COMMUNITIES_PUBLIC_SOURCE_NOT_HTTPS',
    );
  });

  it('rejects a limit above the hard maximum and other invalid numeric gates', () => {
    expectGateCode(
      { ...BASE_ENV, LEGACY_COMMUNITIES_IMPORT_LIMIT: '501' },
      'LEGACY_COMMUNITIES_IMPORT_LIMIT_INVALID',
    );
    expectGateCode(
      { ...BASE_ENV, LEGACY_COMMUNITIES_IMPORT_LIMIT: '0' },
      'LEGACY_COMMUNITIES_IMPORT_LIMIT_INVALID',
    );
    expectGateCode(
      { ...BASE_ENV, LEGACY_COMMUNITIES_PUBLIC_TIMEOUT_MS: '1000' },
      'LEGACY_COMMUNITIES_PUBLIC_TIMEOUT_INVALID',
    );
    expectGateCode(
      { ...BASE_ENV, LEGACY_COMMUNITIES_PUBLIC_TIMEOUT_MS: '600001' },
      'LEGACY_COMMUNITIES_PUBLIC_TIMEOUT_INVALID',
    );
  });

  it('requires an owner user id that is a uuid', () => {
    expectGateCode(
      { ...BASE_ENV, LEGACY_COMMUNITIES_IMPORT_OWNER_USER_ID: undefined },
      'LEGACY_COMMUNITIES_IMPORT_OWNER_REQUIRED',
    );
    expectGateCode(
      { ...BASE_ENV, LEGACY_COMMUNITIES_IMPORT_OWNER_USER_ID: 'owner' },
      'LEGACY_COMMUNITIES_IMPORT_OWNER_REQUIRED',
    );
  });

  it('requires DATABASE_URL', () => {
    expectGateCode({ ...BASE_ENV, DATABASE_URL: undefined }, 'DATABASE_URL_REQUIRED');
  });

  it('requires media storage variables for a real logo import', () => {
    for (const key of [
      'S3_ENDPOINT',
      'S3_PUBLIC_ENDPOINT',
      'S3_BUCKET',
      'S3_ACCESS_KEY',
      'S3_SECRET_KEY',
    ] as const) {
      expectGateCode(
        { ...BASE_ENV, [key]: undefined },
        'LEGACY_COMMUNITIES_IMPORT_MEDIA_STORAGE_REQUIRED',
      );
    }
  });

  it('does not require media storage when the run is a dry run or skips logos', () => {
    const dryRun = readLegacyCommunitiesImportConfig({
      ...BASE_ENV,
      LEGACY_COMMUNITIES_IMPORT_DRY_RUN: 'true',
      S3_BUCKET: undefined,
    });
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.media).toBeUndefined();

    const skipLogos = readLegacyCommunitiesImportConfig({
      ...BASE_ENV,
      LEGACY_COMMUNITIES_IMPORT_SKIP_LOGOS: 'true',
      S3_BUCKET: undefined,
    });
    expect(skipLogos.skipLogos).toBe(true);
    expect(skipLogos.media).toBeUndefined();
  });
});

describe('payload validation', () => {
  it('rejects a payload whose communities field is not an array', () => {
    const code = 'LEGACY_COMMUNITIES_PUBLIC_RESPONSE_INVALID';
    expect(() => parseLegacyCommunitiesPayload(null, { baseUrl: PUBLIC_BASE_URL })).toThrowError(
      code,
    );
    expect(() => parseLegacyCommunitiesPayload([], { baseUrl: PUBLIC_BASE_URL })).toThrowError(
      code,
    );
    expect(() =>
      parseLegacyCommunitiesPayload({ communities: {} }, { baseUrl: PUBLIC_BASE_URL }),
    ).toThrowError(code);
    expect(() =>
      parseLegacyCommunitiesPayload({ communities: 'nope' }, { baseUrl: PUBLIC_BASE_URL }),
    ).toThrowError(code);
  });

  it('rejects an item without a usable id or name', () => {
    const code = 'LEGACY_COMMUNITIES_PUBLIC_RESPONSE_INVALID';
    expect(() =>
      parseLegacyCommunitiesPayload(
        { communities: [rawCommunity({ id: undefined })] },
        {
          baseUrl: PUBLIC_BASE_URL,
        },
      ),
    ).toThrowError(code);
    expect(() =>
      parseLegacyCommunitiesPayload(
        { communities: [rawCommunity({ id: '   ' })] },
        {
          baseUrl: PUBLIC_BASE_URL,
        },
      ),
    ).toThrowError(code);
    expect(() =>
      parseLegacyCommunitiesPayload(
        { communities: [rawCommunity({ name: undefined })] },
        {
          baseUrl: PUBLIC_BASE_URL,
        },
      ),
    ).toThrowError(code);
    expect(() =>
      parseLegacyCommunitiesPayload(
        { communities: [rawCommunity({ name: 42 })] },
        {
          baseUrl: PUBLIC_BASE_URL,
        },
      ),
    ).toThrowError(code);
    expect(() =>
      parseLegacyCommunitiesPayload(
        { communities: ['not-an-object'] },
        {
          baseUrl: PUBLIC_BASE_URL,
        },
      ),
    ).toThrowError(code);
  });

  it('tolerates unknown extra fields and reads only the mapped ones', () => {
    const items = parseLegacyCommunitiesPayload(
      {
        communities: [
          rawCommunity({
            id: 'community_1',
            name: 'Один',
            unknownExtraField: { nested: true },
            chatSettings: { muted: false },
          }),
        ],
        connections: 7,
        total: 1,
        extraEnvelopeField: 'ignored',
      },
      { baseUrl: PUBLIC_BASE_URL },
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('community_1');
    expect(items[0]?.name).toBe('Один');
    expect(items[0]?.joinRule).toBe('INSTANT');
    expect(items[0]?.logoUrl).toBe('https://padlhub.su/media/communities/example.png');
  });

  it('accepts an empty catalog and resolves relative legacy logo paths', () => {
    expect(
      parseLegacyCommunitiesPayload(
        { communities: [], connections: 0, total: 0 },
        {
          baseUrl: PUBLIC_BASE_URL,
        },
      ),
    ).toEqual([]);
    const [item] = parseLegacyCommunitiesPayload(
      { communities: [rawCommunity({ logoUrl: '/files/logo.png', logo: null })] },
      { baseUrl: PUBLIC_BASE_URL },
    );
    expect(item?.logoUrl).toBe('https://padlhub.su/files/logo.png');
  });

  it('treats insecure or blank legacy media as no logo', () => {
    const [insecure] = parseLegacyCommunitiesPayload(
      {
        communities: [
          rawCommunity({ logoUrl: 'http://insecure.example/logo.png', logoThumbUrl: '   ' }),
        ],
      },
      { baseUrl: PUBLIC_BASE_URL },
    );
    expect(insecure?.logoUrl).toBeNull();
    // A relative reference resolves against the legacy origin, exactly as the legacy reader does.
    const [relative] = parseLegacyCommunitiesPayload(
      { communities: [rawCommunity({ logoUrl: 'media/logo.png', logo: null })] },
      { baseUrl: PUBLIC_BASE_URL },
    );
    expect(relative?.logoUrl).toBe('https://padlhub.su/media/logo.png');
  });
});

describe('legacy catalog mapping', () => {
  it('maps OPEN visibility to PUBLIC and non-public visibility to LISTED_PRIVATE', () => {
    expect(mappedSourceItem(sourceItem({ visibility: 'OPEN' })).community.visibility).toBe(
      'PUBLIC',
    );
    expect(mappedSourceItem(sourceItem({ visibility: 'CLOSED' })).community.visibility).toBe(
      'LISTED_PRIVATE',
    );
    const unknown = mapLegacyCommunities([sourceItem({ visibility: 'SOMETHING_NEW' })], {
      now: NOW,
    });
    expect(unknown.communities[0]?.visibility).toBe('PUBLIC');
    expect(unknown.metrics.visibility).toEqual({ PUBLIC: 1, LISTED_PRIVATE: 0 });
  });

  it('passes through every valid join rule and counts the policy distribution', () => {
    for (const joinRule of ['INSTANT', 'MODERATED', 'INVITE_ONLY'] as const) {
      const outcome = mappedSourceItem(sourceItem({ joinRule }));
      expect(outcome.community.joinPolicy).toBe(joinRule);
      expect(outcome.joinPolicyFallback).toBe(false);
    }
    const result = mapLegacyCommunities(
      [
        sourceItem({ id: 'community_1', joinRule: 'INSTANT' }),
        sourceItem({ id: 'community_2', joinRule: 'MODERATED' }),
        sourceItem({ id: 'community_3', joinRule: 'INVITE_ONLY' }),
      ],
      { now: NOW },
    );
    expect(result.metrics.joinPolicy).toEqual({ INSTANT: 1, MODERATED: 1, INVITE_ONLY: 1 });
    expect(result.metrics.joinPolicyFallbacks).toBe(0);
  });

  it('fails closed to INVITE_ONLY for a missing or unknown join rule', () => {
    const unknown = mappedSourceItem(sourceItem({ joinRule: 'WHATEVER' }));
    expect(unknown.community.joinPolicy).toBe('INVITE_ONLY');
    expect(unknown.joinPolicyFallback).toBe(true);
    const missing = mappedSourceItem(sourceItem({ joinRule: null }));
    expect(missing.community.joinPolicy).toBe('INVITE_ONLY');
    expect(missing.joinPolicyFallback).toBe(true);
    expect(
      mapLegacyCommunities([sourceItem({ joinRule: 'WHATEVER' })], { now: NOW }).metrics
        .joinPolicyFallbacks,
    ).toBe(1);
  });

  it('trims descriptions, maps whitespace to null and truncates at 4000 characters', () => {
    expect(mappedSourceItem(sourceItem({ description: '  trimmed  ' })).community.description).toBe(
      'trimmed',
    );
    expect(mappedSourceItem(sourceItem({ description: '   ' })).community.description).toBeNull();
    expect(mappedSourceItem(sourceItem({ description: null })).community.description).toBeNull();
    const long = 'я'.repeat(4_001);
    const truncated = mappedSourceItem(sourceItem({ description: long }));
    expect(truncated.community.description).toHaveLength(4_000);
    expect(truncated.descriptionTruncated).toBe(true);
    expect(
      mapLegacyCommunities([sourceItem({ description: long })], { now: NOW }).metrics
        .descriptionTruncations,
    ).toBe(1);
  });

  it('skips blank and over-long names and counts them', () => {
    const blank = mapLegacyCommunity(sourceItem({ name: '   ' }), { now: NOW });
    expect(blank).toEqual({ kind: 'skipped', reason: 'NAME_BLANK' });
    const overLong = mapLegacyCommunity(sourceItem({ name: 'я'.repeat(121) }), { now: NOW });
    expect(overLong).toEqual({ kind: 'skipped', reason: 'NAME_TOO_LONG' });
    const exact = mapLegacyCommunity(sourceItem({ name: 'я'.repeat(120) }), { now: NOW });
    expect(exact.kind).toBe('mapped');

    const result = mapLegacyCommunities(
      [
        sourceItem({ id: 'community_1', name: '   ' }),
        sourceItem({ id: 'community_2', name: 'я'.repeat(121) }),
        sourceItem({ id: 'community_3', name: 'Валидное' }),
      ],
      { now: NOW },
    );
    expect(result.communities.map((community) => community.externalId)).toEqual(['community_3']);
    expect(result.skipped).toBe(2);
    expect(result.metrics.skipped).toBe(2);
  });

  it('coerces isVerified strictly to the boolean true', () => {
    expect(mappedSourceItem(sourceItem({ isVerified: true })).community.isVerified).toBe(true);
    expect(mappedSourceItem(sourceItem({ isVerified: 'true' })).community.isVerified).toBe(false);
    expect(mappedSourceItem(sourceItem({ isVerified: 1 })).community.isVerified).toBe(false);
    expect(mappedSourceItem(sourceItem({ isVerified: null })).community.isVerified).toBe(false);
  });

  it('falls back to now() when a legacy timestamp is unparseable', () => {
    const fallback = mappedSourceItem(sourceItem({ createdAt: 'not-a-date', updatedAt: '' }), NOW);
    expect(fallback.community.createdAt).toBe(NOW);
    expect(fallback.community.updatedAt).toBe(NOW);
    expect(fallback.community.sortAt).toBe(NOW);

    const parsed = mappedSourceItem(sourceItem());
    expect(parsed.community.createdAt).toBe('2024-05-01T09:00:00.000Z');
    expect(parsed.community.updatedAt).toBe('2025-01-02T10:00:00.000Z');
  });

  it('builds logo directory items only for communities with a legacy logo url', () => {
    const items = buildLogoDirectoryItems([
      {
        ...mappedSourceItem(sourceItem({ id: 'community_1' })).community,
        internalId: '22222222-2222-4222-8222-222222222222',
      },
      {
        ...mappedSourceItem(sourceItem({ id: 'community_2', logoUrl: null })).community,
        internalId: '33333333-3333-4333-8333-333333333333',
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('22222222-2222-4222-8222-222222222222');
    expect(items[0]?.logoUrl).toBeNull();
    expect(items[0]?.legacyLogoSourceUrl).toBe(
      'https://padlhub.su/media/communities/zvezdopad.png',
    );
  });
});

describe('idempotent catalog write intent', () => {
  it('upserts a community on the tenant/id key', () => {
    expect(COMMUNITY_UPSERT_SQL).toContain('on conflict (tenant_id, id) do update');
    expect(COMMUNITY_UPSERT_SQL).toContain("'OPEN_COMMUNITY', 'ACTIVE'");
  });

  it('never refreshes status or archived_at on an existing community', () => {
    const updateClause = COMMUNITY_UPSERT_SQL.slice(COMMUNITY_UPSERT_SQL.indexOf('do update'));
    expect(updateClause).not.toMatch(/\bstatus\b/);
    expect(updateClause).not.toMatch(/\barchived_at\b/);
    expect(updateClause).toContain('title = excluded.title');
    expect(updateClause).toContain('description = excluded.description');
    expect(updateClause).toContain('visibility = excluded.visibility');
    expect(updateClause).toContain('join_policy = excluded.join_policy');
    expect(updateClause).toContain('is_verified = excluded.is_verified');
    expect(updateClause).toContain('updated_at = excluded.updated_at');
  });

  it('upserts one active owner membership without resetting joined_at', () => {
    expect(COMMUNITY_OWNER_MEMBERSHIP_UPSERT_SQL).toContain(
      'on conflict (tenant_id, community_id, user_id) do update',
    );
    expect(COMMUNITY_OWNER_MEMBERSHIP_UPSERT_SQL).toContain("role = 'OWNER'");
    expect(COMMUNITY_OWNER_MEMBERSHIP_UPSERT_SQL).toContain("status = 'ACTIVE'");
    expect(COMMUNITY_OWNER_MEMBERSHIP_UPSERT_SQL).toContain(
      'coalesce(communities.memberships.joined_at, now())',
    );
  });
});

describe('dry run', () => {
  it('fetches and maps without touching the database or object storage', async () => {
    const payload = {
      communities: [
        rawCommunity({ id: 'community_1', name: 'Первый' }),
        rawCommunity({ id: 'community_2', name: 'Второй' }),
        rawCommunity({ id: 'community_3', name: '   ' }),
      ],
      connections: 12,
      total: 3,
    };
    const config = readLegacyCommunitiesImportConfig({
      ...BASE_ENV,
      LEGACY_COMMUNITIES_IMPORT_DRY_RUN: 'true',
      S3_BUCKET: undefined,
    });

    const requestedUrls: string[] = [];
    const fetchImplementation: typeof fetch = (input) => {
      requestedUrls.push(
        input instanceof URL ? input.href : input instanceof Request ? input.url : input,
      );
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    const pool = {
      query: () => {
        throw new Error('DRY_RUN_TOUCHED_THE_DATABASE');
      },
      connect: () => {
        throw new Error('DRY_RUN_TOUCHED_THE_DATABASE');
      },
    } as unknown as Pool;
    const store: ProfilePhotoObjectStore = {
      put: () => {
        throw new Error('DRY_RUN_UPLOADED_AN_OBJECT');
      },
      createReadUrl: () => Promise.reject(new Error('DRY_RUN_READ_AN_OBJECT')),
      exists: () => Promise.reject(new Error('DRY_RUN_READ_AN_OBJECT')),
      delete: () => Promise.reject(new Error('DRY_RUN_DELETED_AN_OBJECT')),
    };

    const result = await runLegacyCommunitiesImport(config, {
      pool,
      store,
      fetchImplementation,
      now: () => new Date(NOW),
    });

    expect(requestedUrls).toEqual(['https://padlhub.su/lk/communities?view=summary']);
    expect(result.summary).toEqual({
      schema: LEGACY_COMMUNITIES_IMPORT_SCHEMA,
      tenantKey: 'local-padel',
      dryRun: true,
      fetched: 3,
      imported: 0,
      skipped: 1,
      logosAttempted: 0,
      logosStored: 0,
      logosFailed: 0,
      mappings: 0,
    });
    expect(result.plannedTitles).toEqual(['Первый', 'Второй']);
    expect(result.canonicalDescriptionClamps).toBe(0);
  });

  it('surfaces an invalid payload instead of importing anything', async () => {
    const config = readLegacyCommunitiesImportConfig({
      ...BASE_ENV,
      LEGACY_COMMUNITIES_IMPORT_DRY_RUN: 'true',
    });
    const pool = {
      query: () => {
        throw new Error('DRY_RUN_TOUCHED_THE_DATABASE');
      },
    } as unknown as Pool;
    await expect(
      runLegacyCommunitiesImport(config, {
        pool,
        fetchImplementation: () =>
          Promise.resolve(new Response(JSON.stringify({ communities: 'nope' }), { status: 200 })),
      }),
    ).rejects.toThrowError('LEGACY_COMMUNITIES_PUBLIC_RESPONSE_INVALID');
  });

  it('reports an unreachable source without touching the database', async () => {
    const config = readLegacyCommunitiesImportConfig({
      ...BASE_ENV,
      LEGACY_COMMUNITIES_IMPORT_DRY_RUN: 'true',
    });
    const pool = {
      query: () => {
        throw new Error('DRY_RUN_TOUCHED_THE_DATABASE');
      },
    } as unknown as Pool;
    await expect(
      runLegacyCommunitiesImport(config, {
        pool,
        fetchImplementation: () => Promise.resolve(new Response('nope', { status: 503 })),
      }),
    ).rejects.toThrowError('LEGACY_COMMUNITIES_PUBLIC_SOURCE_UNAVAILABLE');
  });
});
