import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CommunityDirectoryItem } from '@phub/communities';
import {
  createCommunityLegacyBridgeRepository,
  createDatabasePool,
  withTenantTransaction,
} from '@phub/database';
import type { Pool, QueryResultRow } from 'pg';

import {
  synchronizeLegacyCommunityLogos,
  type CommunityLogoPersistence,
} from '../apps/worker/src/community-logo-sync.js';
import {
  S3ProfilePhotoObjectStore,
  type ProfilePhotoObjectStore,
} from '../apps/worker/src/profile-photo-sync.js';

/**
 * Staging-gated, one-off seed of the local LK2 community catalog.
 *
 * WHY THIS EXISTS
 * The LK2 beta is meant to run with `COMMUNITIES_READ_MODE=local`, but the local
 * `communities.communities` schema starts empty, so the beta would show an empty directory instead
 * of the real 83 legacy communities. This script copies the public legacy CUP catalog once so the
 * beta runs on real titles, logos and join rules without asking CUP on every request. It is an
 * import, not synchronization and not a dual write: after it runs, the CUP source is never
 * consulted for these rows again.
 *
 * SOURCE
 * `GET <LEGACY_COMMUNITIES_PUBLIC_BASE_URL>/lk/communities?view=summary` - the same anonymous
 * public endpoint the legacy read bridge uses. The payload is `{ communities, connections, total }`
 * and every community carries `id`, `name`, `logoUrl`/`logoThumbUrl`/`logo`, `isVerified`,
 * `visibility`, `description`, `joinRule`, `createdAt` and `updatedAt`. The endpoint needs no
 * production credentials and returns no phone numbers, member data or payment state. Nothing
 * secret, no connection string and no member data is ever written to stdout.
 *
 * IDENTITY AND IDEMPOTENCY
 * Local ids are NOT derived from the legacy ids. `resolveCommunityIds` maps every legacy
 * `community_*` id through `integration.external_entity_map` (`LK_LEGACY`/`community`), so a
 * re-run resolves the same PadlHub UUID and the upserts below are idempotent. The update clause
 * deliberately refreshes only the fields this catalog owns (title, description, visibility,
 * join_policy, is_verified, updated_at). It never writes `status` or `archived_at`, so a community
 * that an operator archived in the beta stays archived instead of being resurrected by a re-run.
 * The single ACTIVE OWNER membership is upserted the same way and keeps its original `joined_at`.
 *
 * MAPPING (legacy -> PadlHub) AND ITS REASONING
 * - `title`          <- trimmed `name`. The canonical check allows 1..120 characters after btrim,
 *                       so blank or over-long names are skipped (and counted) instead of failing
 *                       the whole import.
 * - `description`    <- trimmed `description`; empty becomes null and the value is bounded. The
 *                       documented v2 text bound is 4000 characters; the write path additionally
 *                       honours the canonical `publishing_preset is not null => <= 2000` check
 *                       constraint from migration 0055, because every imported row is an
 *                       `OPEN_COMMUNITY`.
 * - `visibility`     <- `OPEN` becomes `PUBLIC` (the row is listed and searchable). The legacy
 *                       non-public values become `LISTED_PRIVATE`. Anything else falls back to
 *                       `PUBLIC`, matching the legacy default where an absent/unknown visibility
 *                       still exposed the community through the public summary.
 * - `join_policy`    <- `joinRule` when it is one of INSTANT/MODERATED/INVITE_ONLY, otherwise
 *                       INVITE_ONLY. The fallback fails closed: an unknown join rule must never be
 *                       silently turned into instant self-service membership.
 * - `publishing_preset` <- `OPEN_COMMUNITY`; `status` <- `ACTIVE`; `is_verified` <- strict `true`.
 * - `created_by`     <- `LEGACY_COMMUNITIES_IMPORT_OWNER_USER_ID`, the local user that owns the
 *                       imported catalog. The same user receives the ACTIVE OWNER membership, as
 *                       the schema requires exactly one active owner per community. Re-running with
 *                       a different owner id is not supported: it would violate that invariant.
 * - `created_at`/`updated_at` <- the legacy timestamps when they parse, otherwise `now()`.
 * - logos            <- `synchronizeLegacyCommunityLogos` fetches the allowlisted `padlhub.su`
 *                       source, stores a normalized private WebP (`stableDeliveryEnabled: true`) and
 *                       this script records the `integration.community_logo_sync` row that the
 *                       local directory read path joins. `communities.communities.logo_object_key`
 *                       is intentionally left to the logo bridge table: both local read
 *                       repositories resolve logos from `integration.community_logo_sync`, and the
 *                       idempotent community update clause must not grow extra columns.
 *
 * SAFETY
 * Staging only (`APP_ENV=staging`), explicit confirmation token, tenant allowlist, HTTPS-only
 * source, bounded limit/timeout/response size, and `LEGACY_COMMUNITIES_IMPORT_DRY_RUN=true` to
 * fetch, map and report without writing to PostgreSQL or object storage.
 */

const BETA_TENANT_KEY = 'local-padel';
const DEFAULT_PUBLIC_BASE_URL = 'https://padlhub.su';
const DEFAULT_IMPORT_LIMIT = 500;
const MAX_IMPORT_LIMIT = 500;
const DEFAULT_PUBLIC_TIMEOUT_MS = 120_000;
const MIN_PUBLIC_TIMEOUT_MS = 5_000;
const MAX_PUBLIC_TIMEOUT_MS = 600_000;
const MAX_RESPONSE_BYTES = 10 * 1_024 * 1_024;
const MAX_EXTERNAL_ID_LENGTH = 500;
const MAX_TITLE_LENGTH = 120;
const DESCRIPTION_MAX_LENGTH = 4_000;
const CANONICAL_DESCRIPTION_MAX_LENGTH = 2_000;
const DEFAULT_S3_REGION = 'ru-1';
const DEFAULT_READ_URL_TTL_SECONDS = 3_600;
const DEFAULT_MAX_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_MAX_DIMENSION = 1_024;
const DEFAULT_WEBP_QUALITY = 82;
const LEGACY_LOGO_ALLOWED_HOSTS = ['padlhub.su'] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const LEGACY_COMMUNITIES_IMPORT_SCHEMA = 'PHUB_LEGACY_COMMUNITIES_IMPORT_V1';

/**
 * Idempotent catalog upsert. The `do update` clause intentionally never touches `status` or
 * `archived_at`, so a re-run refreshes catalog fields without resurrecting a manually archived
 * community.
 */
export const COMMUNITY_UPSERT_SQL = `
insert into communities.communities (
  tenant_id, id, title, description, visibility, join_policy,
  publishing_preset, status, is_verified, created_by, created_at, updated_at, revision
) values (
  $1, $2::uuid, $3, $4, $5, $6, 'OPEN_COMMUNITY', 'ACTIVE', $7, $8::uuid,
  coalesce($9::timestamptz, now()), coalesce($10::timestamptz, now()), 1
)
on conflict (tenant_id, id) do update
   set title = excluded.title,
       description = excluded.description,
       visibility = excluded.visibility,
       join_policy = excluded.join_policy,
       is_verified = excluded.is_verified,
       updated_at = excluded.updated_at
`;

/** Idempotent owner membership upsert; an existing `joined_at` is preserved. */
export const COMMUNITY_OWNER_MEMBERSHIP_UPSERT_SQL = `
insert into communities.memberships (
  tenant_id, community_id, user_id, role, status, joined_at, revision
) values ($1, $2::uuid, $3::uuid, 'OWNER', 'ACTIVE', $4::timestamptz, 1)
on conflict (tenant_id, community_id, user_id) do update
   set role = 'OWNER',
       status = 'ACTIVE',
       joined_at = coalesce(communities.memberships.joined_at, now())
`;

/** Logo bridge upsert for the local directory read path. */
export const COMMUNITY_LOGO_UPSERT_SQL = `
insert into integration.community_logo_sync (
  tenant_id, community_id, source_url, source_etag, source_last_modified,
  content_sha256, object_key, delivery_url, delivery_expires_at, synced_at
) values ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz)
on conflict (tenant_id, community_id) do update
   set source_url = excluded.source_url,
       source_etag = excluded.source_etag,
       source_last_modified = excluded.source_last_modified,
       content_sha256 = excluded.content_sha256,
       object_key = excluded.object_key,
       delivery_url = excluded.delivery_url,
       delivery_expires_at = excluded.delivery_expires_at,
       synced_at = excluded.synced_at,
       updated_at = now()
`;

export class LegacyCommunitiesImportError extends Error {
  public constructor(
    public readonly code: string,
    options?: { readonly cause?: unknown },
  ) {
    super(code, options);
    this.name = 'LegacyCommunitiesImportError';
  }
}

export type CommunityVisibility = 'PUBLIC' | 'LISTED_PRIVATE';
export type CommunityJoinPolicy = 'INSTANT' | 'MODERATED' | 'INVITE_ONLY';

const VISIBILITY_BY_LEGACY_VALUE: Readonly<Record<string, CommunityVisibility>> = {
  OPEN: 'PUBLIC',
  CLOSED: 'LISTED_PRIVATE',
  HIDDEN: 'LISTED_PRIVATE',
  PRIVATE: 'LISTED_PRIVATE',
};

const JOIN_POLICIES: readonly CommunityJoinPolicy[] = ['INSTANT', 'MODERATED', 'INVITE_ONLY'];

/** One community parsed from the public legacy summary, with the raw verified flag retained. */
export interface LegacyCommunitySourceItem {
  readonly id: string;
  readonly name: string;
  readonly logoUrl: string | null;
  /** Raw legacy flag; coerced once, in the mapping, so a malformed value cannot fail the payload. */
  readonly isVerified: unknown;
  readonly visibility: string | null;
  readonly description: string | null;
  readonly joinRule: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface MappedLegacyCommunity {
  readonly externalId: string;
  readonly title: string;
  readonly description: string | null;
  readonly visibility: CommunityVisibility;
  readonly joinPolicy: CommunityJoinPolicy;
  readonly isVerified: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sortAt: string;
  readonly legacyLogoSourceUrl?: string;
}

export type LegacyCommunityMapOutcome =
  | {
      readonly kind: 'mapped';
      readonly community: MappedLegacyCommunity;
      readonly joinPolicyFallback: boolean;
      readonly descriptionTruncated: boolean;
    }
  | { readonly kind: 'skipped'; readonly reason: 'NAME_BLANK' | 'NAME_TOO_LONG' };

export interface LegacyCommunityMappingMetrics {
  readonly visibility: Readonly<Record<CommunityVisibility, number>>;
  readonly joinPolicy: Readonly<Record<CommunityJoinPolicy, number>>;
  readonly joinPolicyFallbacks: number;
  readonly descriptionTruncations: number;
  readonly skipped: number;
}

export interface LegacyCommunityMappingResult {
  readonly communities: readonly MappedLegacyCommunity[];
  readonly skipped: number;
  readonly metrics: LegacyCommunityMappingMetrics;
}

export interface LegacyCommunitiesImportMediaConfig {
  readonly s3Endpoint: string;
  readonly s3PublicEndpoint: string;
  readonly s3Bucket: string;
  readonly s3AccessKey: string;
  readonly s3SecretKey: string;
  readonly s3Region: string;
  readonly s3ForcePathStyle: boolean;
  readonly readUrlTtlSeconds: number;
  readonly maxBytes: number;
  readonly maxDimension: number;
  readonly webpQuality: number;
  readonly storageTimeoutMs: number;
  readonly allowedHosts: readonly string[];
}

export interface LegacyCommunitiesImportConfig {
  readonly tenantKey: string;
  readonly databaseUrl: string;
  readonly publicBaseUrl: string;
  readonly limit: number;
  readonly publicTimeoutMs: number;
  readonly ownerUserId: string;
  readonly dryRun: boolean;
  readonly skipLogos: boolean;
  readonly correlationId: string;
  readonly media: LegacyCommunitiesImportMediaConfig | undefined;
}

export interface LegacyCommunitiesImportSummary {
  readonly schema: typeof LEGACY_COMMUNITIES_IMPORT_SCHEMA;
  readonly tenantKey: string;
  readonly dryRun: boolean;
  readonly fetched: number;
  readonly imported: number;
  readonly skipped: number;
  readonly logosAttempted: number;
  readonly logosStored: number;
  readonly logosFailed: number;
  readonly mappings: number;
}

export interface LegacyCommunitiesImportRunResult {
  readonly summary: LegacyCommunitiesImportSummary;
  /** Titles a dry run would have written; empty for a real run. */
  readonly plannedTitles: readonly string[];
  readonly metrics: LegacyCommunityMappingMetrics;
  readonly canonicalDescriptionClamps: number;
}

export interface LegacyCommunitiesImportDependencies {
  readonly pool: Pool;
  readonly store?: ProfilePhotoObjectStore;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
  readonly resolveCommunityIds?: (
    tenantId: string,
    externalIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string>>;
}

interface TenantRow extends QueryResultRow {
  readonly id: string;
}

interface UserRow extends QueryResultRow {
  readonly id: string;
}

type ResourcedCommunity = MappedLegacyCommunity & { readonly internalId: string };

function failure(code: string, cause?: unknown): LegacyCommunitiesImportError {
  return new LegacyCommunitiesImportError(code, cause === undefined ? undefined : { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw failure(code);
  }
  return parsed;
}

function httpsOnly(value: string, code: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw failure(code);
  }
  if (parsed.protocol !== 'https:') throw failure(code);
  return parsed.toString();
}

/** Reads and validates every gate from the environment; there is no CLI flag parsing. */
export function readLegacyCommunitiesImportConfig(
  env: NodeJS.ProcessEnv,
): LegacyCommunitiesImportConfig {
  if (env.APP_ENV !== 'staging') {
    throw failure('LEGACY_COMMUNITIES_BETA_IMPORT_REQUIRES_APP_ENV_STAGING');
  }
  if (env.LEGACY_COMMUNITIES_IMPORT_CONFIRM !== 'beta-clone') {
    throw failure('LEGACY_COMMUNITIES_IMPORT_CONFIRM_REQUIRED');
  }
  const tenantKey = stringValue(env.LEGACY_COMMUNITIES_IMPORT_TENANT_KEY);
  if (tenantKey !== BETA_TENANT_KEY) {
    throw failure('LEGACY_COMMUNITIES_BETA_IMPORT_TENANT_NOT_ALLOWED');
  }
  const publicBaseUrl = httpsOnly(
    stringValue(env.LEGACY_COMMUNITIES_PUBLIC_BASE_URL) ?? DEFAULT_PUBLIC_BASE_URL,
    'LEGACY_COMMUNITIES_PUBLIC_SOURCE_NOT_HTTPS',
  );
  const limit = boundedInteger(
    env.LEGACY_COMMUNITIES_IMPORT_LIMIT,
    DEFAULT_IMPORT_LIMIT,
    1,
    MAX_IMPORT_LIMIT,
    'LEGACY_COMMUNITIES_IMPORT_LIMIT_INVALID',
  );
  const publicTimeoutMs = boundedInteger(
    env.LEGACY_COMMUNITIES_PUBLIC_TIMEOUT_MS,
    DEFAULT_PUBLIC_TIMEOUT_MS,
    MIN_PUBLIC_TIMEOUT_MS,
    MAX_PUBLIC_TIMEOUT_MS,
    'LEGACY_COMMUNITIES_PUBLIC_TIMEOUT_INVALID',
  );
  const ownerUserId = stringValue(env.LEGACY_COMMUNITIES_IMPORT_OWNER_USER_ID);
  if (!ownerUserId || !UUID_PATTERN.test(ownerUserId)) {
    throw failure('LEGACY_COMMUNITIES_IMPORT_OWNER_REQUIRED');
  }
  const databaseUrl = stringValue(env.DATABASE_URL);
  if (!databaseUrl) throw failure('DATABASE_URL_REQUIRED');

  const dryRun = env.LEGACY_COMMUNITIES_IMPORT_DRY_RUN === 'true';
  const skipLogos = env.LEGACY_COMMUNITIES_IMPORT_SKIP_LOGOS === 'true';

  return {
    tenantKey,
    databaseUrl,
    publicBaseUrl,
    limit,
    publicTimeoutMs,
    ownerUserId,
    dryRun,
    skipLogos,
    correlationId: `legacy-communities-import-${randomUUID()}`,
    media: dryRun || skipLogos ? undefined : readMediaConfig(env, publicTimeoutMs),
  };
}

function readMediaConfig(
  env: NodeJS.ProcessEnv,
  storageTimeoutMs: number,
): LegacyCommunitiesImportMediaConfig {
  const s3Endpoint = stringValue(env.S3_ENDPOINT);
  const s3PublicEndpoint = stringValue(env.S3_PUBLIC_ENDPOINT);
  const s3Bucket = stringValue(env.S3_BUCKET);
  const s3AccessKey = stringValue(env.S3_ACCESS_KEY);
  const s3SecretKey = stringValue(env.S3_SECRET_KEY);
  if (!s3Endpoint || !s3PublicEndpoint || !s3Bucket || !s3AccessKey || !s3SecretKey) {
    throw failure('LEGACY_COMMUNITIES_IMPORT_MEDIA_STORAGE_REQUIRED');
  }
  return {
    s3Endpoint,
    s3PublicEndpoint,
    s3Bucket,
    s3AccessKey,
    s3SecretKey,
    s3Region: stringValue(env.S3_REGION) ?? DEFAULT_S3_REGION,
    // Same default as `packages/config`: path style unless explicitly disabled.
    s3ForcePathStyle: env.S3_FORCE_PATH_STYLE === undefined || env.S3_FORCE_PATH_STYLE === 'true',
    readUrlTtlSeconds: boundedInteger(
      env.PROFILE_PHOTO_URL_TTL_SECONDS,
      DEFAULT_READ_URL_TTL_SECONDS,
      600,
      86_400,
      'LEGACY_COMMUNITIES_IMPORT_MEDIA_TTL_INVALID',
    ),
    maxBytes: boundedInteger(
      env.PROFILE_PHOTO_MAX_BYTES,
      DEFAULT_MAX_BYTES,
      64 * 1_024,
      20 * 1_024 * 1_024,
      'LEGACY_COMMUNITIES_IMPORT_MEDIA_MAX_BYTES_INVALID',
    ),
    maxDimension: boundedInteger(
      env.PROFILE_PHOTO_MAX_DIMENSION,
      DEFAULT_MAX_DIMENSION,
      128,
      2_048,
      'LEGACY_COMMUNITIES_IMPORT_MEDIA_MAX_DIMENSION_INVALID',
    ),
    webpQuality: boundedInteger(
      env.PROFILE_PHOTO_WEBP_QUALITY,
      DEFAULT_WEBP_QUALITY,
      40,
      95,
      'LEGACY_COMMUNITIES_IMPORT_MEDIA_WEBP_QUALITY_INVALID',
    ),
    storageTimeoutMs,
    allowedHosts: [...LEGACY_LOGO_ALLOWED_HOSTS],
  };
}

/**
 * Resolves a legacy logo reference to an absolute HTTPS URL. Unknown extra fields and malformed
 * media are tolerated: a bad logo is equivalent to no logo and never fails the payload.
 */
function legacyLogoUrl(row: Record<string, unknown>, baseUrl: string): string | null {
  for (const candidate of [row.logoUrl, row.logoThumbUrl, row.logo]) {
    const value = stringValue(candidate);
    if (!value || value.length > 2_048) continue;
    try {
      const url = new URL(value, baseUrl);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.toString();
    } catch {
      // Malformed legacy media is treated as absent.
    }
  }
  return null;
}

/**
 * Validates the public summary defensively. Unknown extra fields are ignored by construction: the
 * parser reads only the fields it maps and never rejects surplus keys. `communities` must be an
 * array and every item must carry a usable `id` and a string `name`.
 */
export function parseLegacyCommunitiesPayload(
  payload: unknown,
  options: { readonly baseUrl: string },
): readonly LegacyCommunitySourceItem[] {
  if (!isRecord(payload)) throw failure('LEGACY_COMMUNITIES_PUBLIC_RESPONSE_INVALID');
  const candidate = payload.communities;
  if (!Array.isArray(candidate)) throw failure('LEGACY_COMMUNITIES_PUBLIC_RESPONSE_INVALID');
  const rows: readonly unknown[] = candidate as readonly unknown[];
  const items: LegacyCommunitySourceItem[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw failure('LEGACY_COMMUNITIES_PUBLIC_RESPONSE_INVALID');
    const id = stringValue(row.id);
    if (!id || id.length > MAX_EXTERNAL_ID_LENGTH) {
      throw failure('LEGACY_COMMUNITIES_PUBLIC_RESPONSE_INVALID');
    }
    if (typeof row.name !== 'string') throw failure('LEGACY_COMMUNITIES_PUBLIC_RESPONSE_INVALID');
    items.push({
      id,
      name: row.name,
      logoUrl: legacyLogoUrl(row, options.baseUrl),
      isVerified: row.isVerified ?? null,
      visibility: stringValue(row.visibility) ?? null,
      description: typeof row.description === 'string' ? row.description : null,
      joinRule: stringValue(row.joinRule) ?? null,
      createdAt: stringValue(row.createdAt) ?? null,
      updatedAt: stringValue(row.updatedAt) ?? null,
    });
  }
  return items;
}

function mapVisibility(value: string | null): CommunityVisibility {
  if (!value) return 'PUBLIC';
  return VISIBILITY_BY_LEGACY_VALUE[value] ?? 'PUBLIC';
}

/** Unknown join rules fail closed to INVITE_ONLY. */
function mapJoinPolicy(value: string | null): {
  readonly policy: CommunityJoinPolicy;
  readonly fallback: boolean;
} {
  const matched = JOIN_POLICIES.find((policy) => policy === value);
  return matched ? { policy: matched, fallback: false } : { policy: 'INVITE_ONLY', fallback: true };
}

function mapDescription(value: string | null): {
  readonly description: string | null;
  readonly truncated: boolean;
} {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return { description: null, truncated: false };
  if (trimmed.length > DESCRIPTION_MAX_LENGTH) {
    return { description: trimmed.slice(0, DESCRIPTION_MAX_LENGTH), truncated: true };
  }
  return { description: trimmed, truncated: false };
}

function mapTimestamp(value: string | null, fallback: string): string {
  if (value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return fallback;
}

export function mapLegacyCommunity(
  item: LegacyCommunitySourceItem,
  context: { readonly now: string },
): LegacyCommunityMapOutcome {
  const title = item.name.trim();
  if (!title) return { kind: 'skipped', reason: 'NAME_BLANK' };
  if (title.length > MAX_TITLE_LENGTH) return { kind: 'skipped', reason: 'NAME_TOO_LONG' };

  const description = mapDescription(item.description);
  const joinPolicy = mapJoinPolicy(item.joinRule);
  const updatedAt = mapTimestamp(item.updatedAt, context.now);
  return {
    kind: 'mapped',
    joinPolicyFallback: joinPolicy.fallback,
    descriptionTruncated: description.truncated,
    community: {
      externalId: item.id,
      title,
      description: description.description,
      visibility: mapVisibility(item.visibility),
      joinPolicy: joinPolicy.policy,
      isVerified: item.isVerified === true,
      createdAt: mapTimestamp(item.createdAt, context.now),
      updatedAt,
      sortAt: updatedAt,
      ...(item.logoUrl ? { legacyLogoSourceUrl: item.logoUrl } : {}),
    },
  };
}

/** Maps the whole catalog and aggregates the counts the operator needs to read in the log. */
export function mapLegacyCommunities(
  items: readonly LegacyCommunitySourceItem[],
  context: { readonly now: string },
): LegacyCommunityMappingResult {
  const byExternalId = new Map<string, LegacyCommunitySourceItem>();
  let skipped = 0;
  for (const item of items) {
    // The legacy reader keeps the last row for a repeated source id; do the same and count it.
    if (byExternalId.has(item.id)) skipped += 1;
    byExternalId.set(item.id, item);
  }

  const communities: MappedLegacyCommunity[] = [];
  const visibility: Record<CommunityVisibility, number> = { PUBLIC: 0, LISTED_PRIVATE: 0 };
  const joinPolicy: Record<CommunityJoinPolicy, number> = {
    INSTANT: 0,
    MODERATED: 0,
    INVITE_ONLY: 0,
  };
  let joinPolicyFallbacks = 0;
  let descriptionTruncations = 0;
  for (const item of byExternalId.values()) {
    const outcome = mapLegacyCommunity(item, context);
    if (outcome.kind === 'skipped') {
      skipped += 1;
      continue;
    }
    communities.push(outcome.community);
    visibility[outcome.community.visibility] += 1;
    joinPolicy[outcome.community.joinPolicy] += 1;
    if (outcome.joinPolicyFallback) joinPolicyFallbacks += 1;
    if (outcome.descriptionTruncated) descriptionTruncations += 1;
  }
  return {
    communities,
    skipped,
    metrics: { visibility, joinPolicy, joinPolicyFallbacks, descriptionTruncations, skipped },
  };
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('LEGACY_COMMUNITIES_PUBLIC_RESPONSE_TOO_LARGE');
        throw failure('LEGACY_COMMUNITIES_PUBLIC_RESPONSE_TOO_LARGE');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** Reads the public summary with a bounded timeout and a bounded response size. */
export async function fetchLegacyCommunitySummary(input: {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly correlationId: string;
  readonly fetchImplementation?: typeof fetch;
}): Promise<unknown> {
  const url = new URL(`${input.baseUrl.replace(/\/+$/, '')}/lk/communities`);
  url.searchParams.set('view', 'summary');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  const fetchImplementation = input.fetchImplementation ?? fetch;
  try {
    const response = await fetchImplementation(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Correlation-ID': input.correlationId },
      signal: controller.signal,
    });
    if (!response.ok) throw failure('LEGACY_COMMUNITIES_PUBLIC_SOURCE_UNAVAILABLE');
    const announced = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(announced) && announced > MAX_RESPONSE_BYTES) {
      throw failure('LEGACY_COMMUNITIES_PUBLIC_RESPONSE_TOO_LARGE');
    }
    const text = await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw failure('LEGACY_COMMUNITIES_PUBLIC_RESPONSE_INVALID', error);
    }
  } catch (error) {
    if (error instanceof LegacyCommunitiesImportError) throw error;
    throw failure(
      controller.signal.aborted
        ? 'LEGACY_COMMUNITIES_PUBLIC_SOURCE_TIMEOUT'
        : 'LEGACY_COMMUNITIES_PUBLIC_SOURCE_UNAVAILABLE',
      error,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveTenantId(pool: Pool, tenantKey: string): Promise<string> {
  const result = await pool.query<TenantRow>(
    'select id from identity.tenants where tenant_key = $1 and active = true',
    [tenantKey],
  );
  const tenantId = result.rows[0]?.id;
  if (!tenantId) throw failure('LEGACY_COMMUNITIES_IMPORT_TENANT_NOT_FOUND');
  return tenantId;
}

async function assertActiveOwner(pool: Pool, tenantId: string, ownerUserId: string): Promise<void> {
  const found = await withTenantTransaction(pool, tenantId, async (client) => {
    const row = (
      await client.query<UserRow>(
        `select id from identity.users
          where tenant_id = $1 and id = $2::uuid and status = 'ACTIVE'`,
        [tenantId, ownerUserId],
      )
    ).rows[0];
    return row?.id;
  });
  if (!found) throw failure('LEGACY_COMMUNITIES_IMPORT_OWNER_NOT_FOUND');
}

/** The canonical check forbids a >2000 character description whenever a publishing preset is set. */
function boundCanonicalDescription(description: string | null): string | null {
  if (description === null) return null;
  return description.length > CANONICAL_DESCRIPTION_MAX_LENGTH
    ? description.slice(0, CANONICAL_DESCRIPTION_MAX_LENGTH)
    : description;
}

async function upsertCommunities(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly communities: readonly ResourcedCommunity[];
}): Promise<{ readonly imported: number; readonly canonicalDescriptionClamps: number }> {
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    let imported = 0;
    let canonicalDescriptionClamps = 0;
    for (const community of input.communities) {
      const description = boundCanonicalDescription(community.description);
      if (description !== community.description) canonicalDescriptionClamps += 1;
      await client.query(COMMUNITY_UPSERT_SQL, [
        input.tenantId,
        community.internalId,
        community.title,
        description,
        community.visibility,
        community.joinPolicy,
        community.isVerified,
        input.ownerUserId,
        community.createdAt,
        community.updatedAt,
      ]);
      await client.query(COMMUNITY_OWNER_MEMBERSHIP_UPSERT_SQL, [
        input.tenantId,
        community.internalId,
        input.ownerUserId,
        community.createdAt,
      ]);
      imported += 1;
    }
    return { imported, canonicalDescriptionClamps };
  });
}

/** Builds the `CommunityDirectoryItem` shape the logo synchronizer expects. */
export function buildLogoDirectoryItems(
  communities: readonly ResourcedCommunity[],
): readonly CommunityDirectoryItem[] {
  return communities.flatMap((community) =>
    community.legacyLogoSourceUrl
      ? [
          {
            id: community.internalId,
            title: community.title,
            logoUrl: null,
            isVerified: community.isVerified,
            unreadChatCount: 0,
            pinned: false,
            sortAt: community.sortAt,
            legacyLogoSourceUrl: community.legacyLogoSourceUrl,
          } satisfies CommunityDirectoryItem,
        ]
      : [],
  );
}

async function persistCommunityLogoAssets(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly assets: readonly CommunityLogoPersistence[];
}): Promise<void> {
  const assets = input.assets.filter(
    (
      asset,
    ): asset is CommunityLogoPersistence & {
      readonly sourceUrl: string;
      readonly contentSha256: string;
      readonly objectKey: string;
    } => Boolean(asset.sourceUrl && asset.contentSha256 && asset.objectKey),
  );
  if (assets.length === 0) return;
  await withTenantTransaction(input.pool, input.tenantId, async (client) => {
    for (const asset of assets) {
      // The same coordination primitive the worker uses: a later sync that observed an older
      // catalog snapshot will not regress this row.
      await client.query(
        `insert into integration.community_logo_observation_watermarks (
           tenant_id, community_id, observed_at
         ) values ($1, $2::uuid, $3::timestamptz)
         on conflict (tenant_id, community_id) do update set
           observed_at = greatest(
             integration.community_logo_observation_watermarks.observed_at,
             excluded.observed_at
           ),
           updated_at = now()`,
        [input.tenantId, asset.communityId, asset.syncedAt],
      );
      await client.query(COMMUNITY_LOGO_UPSERT_SQL, [
        input.tenantId,
        asset.communityId,
        asset.sourceUrl,
        asset.sourceEtag ?? null,
        asset.sourceLastModified ?? null,
        asset.contentSha256,
        asset.objectKey,
        null,
        null,
        asset.syncedAt,
      ]);
      await client.query(
        `delete from integration.community_logo_object_gc
          where tenant_id = $1 and object_key = $2`,
        [input.tenantId, asset.objectKey],
      );
      if (asset.supersededObjectKey && asset.deleteAfter) {
        await client.query(
          `insert into integration.community_logo_object_gc (
             tenant_id, object_key, delete_after
           ) values ($1, $2, $3::timestamptz)
           on conflict (tenant_id, object_key) do update set
             delete_after = greatest(
               integration.community_logo_object_gc.delete_after,
               excluded.delete_after
             ),
             updated_at = now()`,
          [input.tenantId, asset.supersededObjectKey, asset.deleteAfter],
        );
      }
    }
  });
}

async function importCommunityLogos(input: {
  readonly pool: Pool;
  readonly store: ProfilePhotoObjectStore;
  readonly tenantId: string;
  readonly media: LegacyCommunitiesImportMediaConfig;
  readonly logoItems: readonly CommunityDirectoryItem[];
  readonly fetchedAt: string;
}): Promise<{ readonly stored: number; readonly failed: number }> {
  const results = await synchronizeLegacyCommunityLogos({
    pool: input.pool,
    store: input.store,
    tenantId: input.tenantId,
    items: input.logoItems,
    fetchedAt: input.fetchedAt,
    allowedHosts: input.media.allowedHosts,
    maxBytes: input.media.maxBytes,
    maxDimension: input.media.maxDimension,
    webpQuality: input.media.webpQuality,
    // Any signed URL minted before this run has expired by the time objects become collectable.
    previousObjectRetentionSeconds: input.media.readUrlTtlSeconds + 60,
    readUrlTtlSeconds: input.media.readUrlTtlSeconds,
    stableDeliveryEnabled: true,
    timeoutMs: input.media.storageTimeoutMs,
    // The default budget is a per-home-sync figure; an import must attempt every planned logo.
    maxFetches: input.logoItems.length,
  });
  let stored = 0;
  let failed = 0;
  for (const result of results) {
    if (result.errorCode) failed += 1;
    else if (result.persistence.objectKey) stored += 1;
  }
  await persistCommunityLogoAssets({
    pool: input.pool,
    tenantId: input.tenantId,
    assets: results.map((result) => result.persistence),
  });
  return { stored, failed };
}

/**
 * DB/S3 orchestration with injected dependencies. A dry run resolves the source and maps it but
 * never touches the pool, never constructs storage and never uploads an object.
 */
export async function runLegacyCommunitiesImport(
  config: LegacyCommunitiesImportConfig,
  dependencies: LegacyCommunitiesImportDependencies,
): Promise<LegacyCommunitiesImportRunResult> {
  const now = dependencies.now?.() ?? new Date();
  const nowIso = now.toISOString();
  const payload = await fetchLegacyCommunitySummary({
    baseUrl: config.publicBaseUrl,
    timeoutMs: config.publicTimeoutMs,
    correlationId: config.correlationId,
    ...(dependencies.fetchImplementation
      ? { fetchImplementation: dependencies.fetchImplementation }
      : {}),
  });
  const items = parseLegacyCommunitiesPayload(payload, { baseUrl: config.publicBaseUrl });
  const mapping = mapLegacyCommunities(items, { now: nowIso });
  const inScope = mapping.communities.slice(0, config.limit);
  const beyondLimit = mapping.communities.length - inScope.length;

  if (config.dryRun) {
    return {
      summary: {
        schema: LEGACY_COMMUNITIES_IMPORT_SCHEMA,
        tenantKey: config.tenantKey,
        dryRun: true,
        fetched: items.length,
        imported: 0,
        skipped: mapping.skipped + beyondLimit,
        logosAttempted: 0,
        logosStored: 0,
        logosFailed: 0,
        mappings: 0,
      },
      plannedTitles: inScope.map((community) => community.title),
      metrics: mapping.metrics,
      canonicalDescriptionClamps: 0,
    };
  }

  const tenantId = await resolveTenantId(dependencies.pool, config.tenantKey);
  await assertActiveOwner(dependencies.pool, tenantId, config.ownerUserId);
  const bridge = createCommunityLegacyBridgeRepository(dependencies.pool, {
    stableLogoDeliveryEnabled: true,
  });
  const resolveCommunityIds =
    dependencies.resolveCommunityIds ??
    ((targetTenantId: string, externalIds: readonly string[]) =>
      bridge.resolveCommunityIds(targetTenantId, externalIds));
  const internalIds = await resolveCommunityIds(
    tenantId,
    inScope.map((community) => community.externalId),
  );
  const resourced: ResourcedCommunity[] = inScope.flatMap((community) => {
    const internalId = internalIds.get(community.externalId);
    return internalId ? [{ ...community, internalId }] : [];
  });
  const withoutMapping = inScope.length - resourced.length;

  const { imported, canonicalDescriptionClamps } = await upsertCommunities({
    pool: dependencies.pool,
    tenantId,
    ownerUserId: config.ownerUserId,
    communities: resourced,
  });

  const logoItems = config.media ? buildLogoDirectoryItems(resourced) : [];
  let logosStored = 0;
  let logosFailed = 0;
  if (config.media && dependencies.store && logoItems.length > 0) {
    const logoResult = await importCommunityLogos({
      pool: dependencies.pool,
      store: dependencies.store,
      tenantId,
      media: config.media,
      logoItems,
      fetchedAt: nowIso,
    });
    logosStored = logoResult.stored;
    logosFailed = logoResult.failed;
  }

  return {
    summary: {
      schema: LEGACY_COMMUNITIES_IMPORT_SCHEMA,
      tenantKey: config.tenantKey,
      dryRun: false,
      fetched: items.length,
      imported,
      skipped: mapping.skipped + beyondLimit + withoutMapping,
      logosAttempted: logoItems.length,
      logosStored,
      logosFailed,
      mappings: internalIds.size,
    },
    plannedTitles: [],
    metrics: mapping.metrics,
    canonicalDescriptionClamps,
  };
}

function writeDiagnostics(result: LegacyCommunitiesImportRunResult): void {
  const { metrics } = result;
  process.stderr.write(
    `[import] visibility PUBLIC=${metrics.visibility.PUBLIC} ` +
      `LISTED_PRIVATE=${metrics.visibility.LISTED_PRIVATE}\n`,
  );
  process.stderr.write(
    `[import] join_policy INSTANT=${metrics.joinPolicy.INSTANT} ` +
      `MODERATED=${metrics.joinPolicy.MODERATED} INVITE_ONLY=${metrics.joinPolicy.INVITE_ONLY} ` +
      `fallbacks=${metrics.joinPolicyFallbacks}\n`,
  );
  process.stderr.write(
    `[import] description_truncations=${metrics.descriptionTruncations} ` +
      `name_skips=${metrics.skipped}\n`,
  );
  if (result.canonicalDescriptionClamps > 0) {
    process.stderr.write(
      `[import] canonical description bound applied to ` +
        `${result.canonicalDescriptionClamps} communities\n`,
    );
  }
}

async function main(): Promise<void> {
  const config = readLegacyCommunitiesImportConfig(process.env);
  const pool = createDatabasePool(config.databaseUrl);
  const store = config.media
    ? new S3ProfilePhotoObjectStore({
        endpoint: config.media.s3Endpoint,
        publicEndpoint: config.media.s3PublicEndpoint,
        region: config.media.s3Region,
        bucket: config.media.s3Bucket,
        accessKey: config.media.s3AccessKey,
        secretKey: config.media.s3SecretKey,
        forcePathStyle: config.media.s3ForcePathStyle,
        autoCreateBucket: false,
        readUrlTtlSeconds: config.media.readUrlTtlSeconds,
        timeoutMs: config.media.storageTimeoutMs,
      })
    : undefined;
  try {
    const result = await runLegacyCommunitiesImport(config, {
      pool,
      ...(store ? { store } : {}),
      now: () => new Date(),
    });
    writeDiagnostics(result);
    for (const title of result.plannedTitles) {
      process.stdout.write(`[dry-run] planned title: ${title}\n`);
    }
    process.stdout.write(`${JSON.stringify(result.summary)}\n`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
