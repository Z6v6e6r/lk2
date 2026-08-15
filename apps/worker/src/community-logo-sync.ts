import { createHash } from 'node:crypto';

import type { CommunityDirectoryItem } from '@phub/communities';
import { communityLogoDeliveryUrl } from '@phub/domain';
import type { Pool } from 'pg';
import sharp from 'sharp';

import type { ProfilePhotoObjectStore } from './profile-photo-sync.js';
import { loadCommunityLogoSyncRecords } from './community-home-repository.js';

const IMAGE_CONTENT_TYPE = /^image\/(?:avif|gif|heic|heif|jpeg|png|webp)(?:;|$)/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_REVALIDATE_AFTER_SECONDS = 3_600;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_FETCHES = 20;
const DEFAULT_SOURCE_MAX_ATTEMPTS = 2;
const DEFAULT_SOURCE_RETRY_BASE_DELAY_MS = 100;
const DEFAULT_SOURCE_MAX_RETRY_AFTER_MS = 5_000;
const DEFAULT_SOURCE_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_SOURCE_CIRCUIT_RESET_MS = 30_000;

export interface CommunityLogoSyncRecord {
  readonly communityId: string;
  readonly sourceUrl: string;
  readonly sourceEtag?: string;
  readonly sourceLastModified?: string;
  readonly contentSha256: string;
  readonly objectKey: string;
  readonly deliveryUrl?: string;
  readonly deliveryExpiresAt?: string;
  readonly syncedAt: string;
}

export interface CommunityLogoPersistence {
  readonly communityId: string;
  readonly sourceUrl?: string;
  readonly sourceEtag?: string;
  readonly sourceLastModified?: string;
  readonly contentSha256?: string;
  readonly objectKey?: string;
  readonly deliveryUrl?: string | null;
  readonly deliveryExpiresAt?: string;
  readonly supersededObjectKey?: string;
  readonly deleteAfter?: string;
  readonly syncedAt: string;
}

export interface CommunityLogoSyncResult {
  readonly communityId: string;
  readonly logoUrl: string | null;
  readonly persistence: CommunityLogoPersistence;
  readonly outcome: 'stored' | 'unchanged' | 'removed' | 'fallback';
  readonly fetchAttempted?: boolean;
  readonly errorCode?: string;
  readonly preparedObject?: {
    readonly key: string;
    readonly body: Buffer;
    readonly sha256: string;
    readonly deleteAfter: string;
  };
}

type SourceLogoResponse =
  | {
      readonly status: 'not-modified';
      readonly etag?: string;
      readonly lastModified?: string;
    }
  | {
      readonly status: 'modified';
      readonly body: Buffer;
      readonly etag?: string;
      readonly lastModified?: string;
    };

export interface CommunityLogoSourceMetric {
  readonly operation: 'community_logo_source_fetch';
  readonly outcome: 'success' | 'retry' | 'failure' | 'circuit_open';
  readonly attempt: number;
  readonly durationMs: number;
  readonly status?: number;
  readonly code?: string;
}

interface CommunityLogoSourceCircuitState {
  failures: number;
  openUntil: number;
  probeInFlight: boolean;
  failureVersion: number;
}

class CommunityLogoSourceError extends Error {
  public constructor(
    code: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'CommunityLogoSourceError';
  }
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : undefined;
}

export class CommunityLogoSourceResilience {
  private readonly circuits = new Map<string, CommunityLogoSourceCircuitState>();
  private readonly fetchImplementation: typeof fetch;

  public constructor(
    private readonly options: {
      readonly maxAttempts?: number;
      readonly retryBaseDelayMs?: number;
      readonly maxRetryAfterMs?: number;
      readonly circuitFailureThreshold?: number;
      readonly circuitResetMs?: number;
      readonly fetchImplementation?: typeof fetch;
      readonly onMetric?: (metric: CommunityLogoSourceMetric) => void;
      readonly now?: () => number;
      readonly sleep?: (delayMs: number) => Promise<void>;
    } = {},
  ) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  private circuitState(hostname: string): CommunityLogoSourceCircuitState {
    const current = this.circuits.get(hostname);
    if (current) return current;
    const created: CommunityLogoSourceCircuitState = {
      failures: 0,
      openUntil: 0,
      probeInFlight: false,
      failureVersion: 0,
    };
    this.circuits.set(hostname, created);
    return created;
  }

  private resetCircuitIfUnchanged(
    state: CommunityLogoSourceCircuitState,
    startFailureVersion: number,
  ): void {
    if (state.failureVersion !== startFailureVersion) return;
    state.failures = 0;
    state.openUntil = 0;
  }

  public async fetch(input: {
    readonly sourceUrl: string;
    readonly allowedHosts: readonly string[];
    readonly maxBytes: number;
    readonly timeoutMs: number;
    readonly acceptNotModified?: boolean;
    readonly sourceEtag?: string;
    readonly sourceLastModified?: string;
  }): Promise<SourceLogoResponse> {
    const hostname = allowedLogoUrl(input.sourceUrl, input.allowedHosts).hostname.toLowerCase();
    const now = this.options.now?.() ?? Date.now();
    const state = this.circuitState(hostname);
    if (state.openUntil > now || state.probeInFlight) {
      this.options.onMetric?.({
        operation: 'community_logo_source_fetch',
        outcome: 'circuit_open',
        attempt: 0,
        durationMs: 0,
        code: 'COMMUNITY_LOGO_SOURCE_CIRCUIT_OPEN',
      });
      throw new CommunityLogoSourceError('COMMUNITY_LOGO_SOURCE_CIRCUIT_OPEN', true);
    }
    const halfOpenProbe = state.openUntil > 0 && state.openUntil <= now;
    if (halfOpenProbe) state.probeInFlight = true;
    const startFailureVersion = state.failureVersion;

    const maxAttempts = Math.max(
      1,
      Math.min(3, this.options.maxAttempts ?? DEFAULT_SOURCE_MAX_ATTEMPTS),
    );
    let lastError: unknown;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const startedAt = this.options.now?.() ?? Date.now();
        try {
          const result = await fetchSourceLogoAttempt({
            ...input,
            fetchImplementation: this.fetchImplementation,
          });
          if (result.status === 'not-modified' && input.acceptNotModified === false) {
            throw new CommunityLogoSourceError(
              'COMMUNITY_LOGO_NOT_MODIFIED_WITHOUT_LOCAL_OBJECT',
              true,
              304,
            );
          }
          this.resetCircuitIfUnchanged(state, startFailureVersion);
          this.options.onMetric?.({
            operation: 'community_logo_source_fetch',
            outcome: 'success',
            attempt,
            durationMs: (this.options.now?.() ?? Date.now()) - startedAt,
            status: result.status === 'not-modified' ? 304 : 200,
          });
          return result;
        } catch (error) {
          lastError = error;
          const retryable = error instanceof CommunityLogoSourceError && error.retryable;
          const willRetry = retryable && attempt < maxAttempts;
          this.options.onMetric?.({
            operation: 'community_logo_source_fetch',
            outcome: willRetry ? 'retry' : 'failure',
            attempt,
            durationMs: (this.options.now?.() ?? Date.now()) - startedAt,
            ...(error instanceof CommunityLogoSourceError && error.status !== undefined
              ? { status: error.status }
              : {}),
            code: errorCode(error),
          });
          if (!willRetry) break;
          const delayMs = Math.min(
            error.retryAfterMs ??
              (this.options.retryBaseDelayMs ?? DEFAULT_SOURCE_RETRY_BASE_DELAY_MS) *
                2 ** (attempt - 1),
            this.options.maxRetryAfterMs ?? DEFAULT_SOURCE_MAX_RETRY_AFTER_MS,
          );
          await (
            this.options.sleep ??
            ((delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay)))
          )(delayMs);
        }
      }

      if (lastError instanceof CommunityLogoSourceError && lastError.retryable) {
        state.failures += 1;
        state.failureVersion += 1;
        const threshold =
          this.options.circuitFailureThreshold ?? DEFAULT_SOURCE_CIRCUIT_FAILURE_THRESHOLD;
        state.openUntil =
          halfOpenProbe || state.failures >= threshold
            ? (this.options.now?.() ?? Date.now()) +
              (this.options.circuitResetMs ?? DEFAULT_SOURCE_CIRCUIT_RESET_MS)
            : 0;
      } else if (halfOpenProbe) {
        this.resetCircuitIfUnchanged(state, startFailureVersion);
      }
      throw lastError;
    } finally {
      if (halfOpenProbe) state.probeInFlight = false;
    }
  }
}

function allowedLogoUrl(value: string, allowedHosts: readonly string[]): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const allowed = allowedHosts.some((entry) => {
    const candidate = entry.trim().toLowerCase();
    return candidate.startsWith('.')
      ? hostname.endsWith(candidate) && hostname.length > candidate.length
      : hostname === candidate;
  });
  if (url.protocol !== 'https:' || !allowed || url.username || url.password) {
    throw new Error('COMMUNITY_LOGO_SOURCE_NOT_ALLOWED');
  }
  return url;
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  await response.body.cancel().catch(() => undefined);
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const announcedLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(announcedLength) && announcedLength > maxBytes) {
    await cancelResponseBody(response);
    throw new Error('COMMUNITY_LOGO_TOO_LARGE');
  }
  if (!response.body) throw new Error('COMMUNITY_LOGO_BODY_MISSING');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) throw new Error('COMMUNITY_LOGO_TOO_LARGE');
      chunks.push(Buffer.from(chunk.value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error('COMMUNITY_LOGO_BODY_MISSING');
  return Buffer.concat(chunks, total);
}

async function fetchSourceLogoAttempt(input: {
  readonly sourceUrl: string;
  readonly allowedHosts: readonly string[];
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly fetchImplementation: typeof fetch;
  readonly sourceEtag?: string;
  readonly sourceLastModified?: string;
}): Promise<SourceLogoResponse> {
  let url = allowedLogoUrl(input.sourceUrl, input.allowedHosts);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  const headers = new Headers({ Accept: 'image/avif,image/webp,image/png,image/jpeg' });
  if (input.sourceEtag) headers.set('If-None-Match', input.sourceEtag);
  if (input.sourceLastModified) headers.set('If-Modified-Since', input.sourceLastModified);
  try {
    for (let redirects = 0; redirects <= 2; redirects += 1) {
      const response = await input.fetchImplementation(url, {
        method: 'GET',
        redirect: 'manual',
        headers,
        signal: controller.signal,
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        await cancelResponseBody(response);
        const location = response.headers.get('location');
        if (!location || redirects === 2) throw new Error('COMMUNITY_LOGO_REDIRECT_INVALID');
        url = allowedLogoUrl(new URL(location, url).toString(), input.allowedHosts);
        continue;
      }
      if (response.status === 304) {
        await cancelResponseBody(response);
        const etag = response.headers.get('etag');
        const lastModified = response.headers.get('last-modified');
        return {
          status: 'not-modified',
          ...(etag ? { etag } : {}),
          ...(lastModified ? { lastModified } : {}),
        };
      }
      if (!response.ok) {
        const retryDelayMs = retryAfterMs(response);
        await cancelResponseBody(response);
        throw new CommunityLogoSourceError(
          `COMMUNITY_LOGO_SOURCE_HTTP_${response.status}`,
          response.status === 429 || response.status >= 500,
          response.status,
          retryDelayMs,
        );
      }
      if (!IMAGE_CONTENT_TYPE.test(response.headers.get('content-type') ?? '')) {
        await cancelResponseBody(response);
        throw new Error('COMMUNITY_LOGO_CONTENT_TYPE_INVALID');
      }
      const etag = response.headers.get('etag');
      const lastModified = response.headers.get('last-modified');
      return {
        status: 'modified',
        body: await readBoundedBody(response, input.maxBytes),
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
      };
    }
    throw new Error('COMMUNITY_LOGO_REDIRECT_INVALID');
  } catch (error) {
    if (error instanceof CommunityLogoSourceError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new CommunityLogoSourceError(
        'COMMUNITY_LOGO_SOURCE_TIMEOUT',
        true,
        undefined,
        undefined,
        error,
      );
    }
    if (error instanceof TypeError) {
      throw new CommunityLogoSourceError(
        'COMMUNITY_LOGO_SOURCE_UNAVAILABLE',
        true,
        undefined,
        undefined,
        error,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^COMMUNITY_LOGO_[A-Z0-9_]+$/.test(error.message)) {
    return error.message;
  }
  return 'COMMUNITY_LOGO_SYNC_FAILED';
}

function deletionFields(
  objectKey: string | undefined,
  fetchedAt: string,
  retentionSeconds: number,
): Pick<CommunityLogoPersistence, 'supersededObjectKey' | 'deleteAfter'> {
  if (!objectKey) return {};
  return {
    supersededObjectKey: objectKey,
    deleteAfter: new Date(Date.parse(fetchedAt) + retentionSeconds * 1_000).toISOString(),
  };
}

function persistenceFromCurrent(
  current: CommunityLogoSyncRecord,
  delivery?: { readonly url: string; readonly expiresAt: string },
  syncedAt = current.syncedAt,
  validators?: { readonly etag?: string; readonly lastModified?: string },
): CommunityLogoPersistence {
  const sourceEtag = validators?.etag ?? current.sourceEtag;
  const sourceLastModified = validators?.lastModified ?? current.sourceLastModified;
  return {
    communityId: current.communityId,
    sourceUrl: current.sourceUrl,
    ...(sourceEtag ? { sourceEtag } : {}),
    ...(sourceLastModified ? { sourceLastModified } : {}),
    contentSha256: current.contentSha256,
    objectKey: current.objectKey,
    ...(delivery?.url || current.deliveryUrl
      ? { deliveryUrl: delivery?.url ?? current.deliveryUrl }
      : {}),
    ...(delivery?.expiresAt || current.deliveryExpiresAt
      ? { deliveryExpiresAt: delivery?.expiresAt ?? current.deliveryExpiresAt }
      : {}),
    syncedAt,
  };
}

function requiresSourceFetch(input: {
  readonly item: CommunityDirectoryItem;
  readonly current?: CommunityLogoSyncRecord;
  readonly fetchedAt: string;
  readonly revalidateAfterSeconds: number;
}): boolean {
  if (!input.item.legacyLogoSourceUrl) return false;
  if (input.current?.sourceUrl !== input.item.legacyLogoSourceUrl || !input.current.objectKey) {
    return true;
  }
  const ageMs = Date.parse(input.fetchedAt) - Date.parse(input.current.syncedAt);
  return !Number.isFinite(ageMs) || ageMs < 0 || ageMs >= input.revalidateAfterSeconds * 1_000;
}

async function mapWithConcurrency<T, R>(input: {
  readonly items: readonly T[];
  readonly concurrency: number;
  readonly operation: (item: T, index: number) => Promise<R>;
}): Promise<readonly R[]> {
  if (input.items.length === 0) return [];
  const results = new Array<R>(input.items.length);
  let cursor = 0;
  const workerCount = Math.min(input.concurrency, input.items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < input.items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await input.operation(input.items[index] as T, index);
      }
    }),
  );
  return results;
}

async function refreshDeliveryUrl(input: {
  readonly store: ProfilePhotoObjectStore;
  readonly current: CommunityLogoSyncRecord;
  readonly fetchedAt: string;
  readonly readUrlTtlSeconds: number;
}): Promise<{ readonly url: string; readonly expiresAt: string } | undefined> {
  const refreshSkewSeconds = Math.min(300, Math.floor(input.readUrlTtlSeconds / 2));
  if (
    input.current.deliveryUrl &&
    input.current.deliveryExpiresAt &&
    Date.parse(input.current.deliveryExpiresAt) >
      Date.parse(input.fetchedAt) + refreshSkewSeconds * 1_000
  ) {
    return undefined;
  }
  return {
    url: await input.store.createReadUrl(input.current.objectKey),
    expiresAt: new Date(
      Date.parse(input.fetchedAt) + input.readUrlTtlSeconds * 1_000,
    ).toISOString(),
  };
}

async function synchronizeOne(input: {
  readonly store: ProfilePhotoObjectStore;
  readonly tenantId: string;
  readonly item: CommunityDirectoryItem;
  readonly current?: CommunityLogoSyncRecord;
  readonly fetchedAt: string;
  readonly allowedHosts: readonly string[];
  readonly maxBytes: number;
  readonly maxDimension: number;
  readonly webpQuality: number;
  readonly previousObjectRetentionSeconds: number;
  readonly readUrlTtlSeconds: number;
  readonly stableDeliveryEnabled: boolean;
  readonly revalidateAfterSeconds: number;
  readonly allowFetch: boolean;
  readonly timeoutMs: number;
  readonly sourceResilience: CommunityLogoSourceResilience;
  readonly deferStorePut?: boolean;
}): Promise<CommunityLogoSyncResult> {
  if (!input.item.legacyLogoSourceUrl) {
    return {
      communityId: input.item.id,
      logoUrl: null,
      outcome: 'removed',
      persistence: {
        communityId: input.item.id,
        syncedAt: input.fetchedAt,
        ...deletionFields(
          input.current?.objectKey,
          input.fetchedAt,
          input.previousObjectRetentionSeconds,
        ),
      },
    };
  }

  let sourceFetchAttempted = false;
  let currentObjectPresent: boolean | undefined;
  try {
    const sourceFetchRequired = requiresSourceFetch(input);
    if (!sourceFetchRequired && input.current) {
      const delivery = input.stableDeliveryEnabled
        ? undefined
        : await refreshDeliveryUrl({
            store: input.store,
            current: input.current,
            fetchedAt: input.fetchedAt,
            readUrlTtlSeconds: input.readUrlTtlSeconds,
          });
      const persistence = persistenceFromCurrent(input.current, delivery);
      return {
        communityId: input.item.id,
        logoUrl: input.stableDeliveryEnabled
          ? communityLogoDeliveryUrl(input.tenantId, input.item.id)
          : (persistence.deliveryUrl ?? null),
        persistence,
        outcome: 'unchanged',
      };
    }

    if (!input.allowFetch) {
      if (!input.current) {
        return {
          communityId: input.item.id,
          logoUrl: null,
          persistence: { communityId: input.item.id, syncedAt: input.fetchedAt },
          outcome: 'fallback',
        };
      }
      const persistence = persistenceFromCurrent(input.current);
      return {
        communityId: input.item.id,
        logoUrl: input.stableDeliveryEnabled
          ? communityLogoDeliveryUrl(input.tenantId, input.item.id)
          : (persistence.deliveryUrl ?? null),
        persistence,
        outcome: 'unchanged',
      };
    }

    const sameSourceCurrent =
      input.current?.sourceUrl === input.item.legacyLogoSourceUrl ? input.current : undefined;
    currentObjectPresent = sameSourceCurrent
      ? await input.store.exists(sameSourceCurrent.objectKey)
      : undefined;
    const validators = currentObjectPresent ? sameSourceCurrent : undefined;
    sourceFetchAttempted = true;
    const source = await input.sourceResilience.fetch({
      sourceUrl: input.item.legacyLogoSourceUrl,
      allowedHosts: input.allowedHosts,
      maxBytes: input.maxBytes,
      timeoutMs: input.timeoutMs,
      acceptNotModified: currentObjectPresent === true,
      ...(validators?.sourceEtag ? { sourceEtag: validators.sourceEtag } : {}),
      ...(validators?.sourceLastModified
        ? { sourceLastModified: validators.sourceLastModified }
        : {}),
    });
    if (source.status === 'not-modified') {
      if (!input.current || currentObjectPresent !== true) {
        throw new Error('COMMUNITY_LOGO_NOT_MODIFIED_WITHOUT_LOCAL_OBJECT');
      }
      const delivery = input.stableDeliveryEnabled
        ? undefined
        : await refreshDeliveryUrl({
            store: input.store,
            current: input.current,
            fetchedAt: input.fetchedAt,
            readUrlTtlSeconds: input.readUrlTtlSeconds,
          });
      const persistence = persistenceFromCurrent(input.current, delivery, input.fetchedAt, {
        ...(source.etag ? { etag: source.etag } : {}),
        ...(source.lastModified ? { lastModified: source.lastModified } : {}),
      });
      return {
        communityId: input.item.id,
        logoUrl: input.stableDeliveryEnabled
          ? communityLogoDeliveryUrl(input.tenantId, input.item.id)
          : (persistence.deliveryUrl ?? null),
        persistence,
        outcome: 'unchanged',
        fetchAttempted: true,
      };
    }
    const webp = await sharp(source.body, { failOn: 'error', limitInputPixels: 20_000_000 })
      .rotate()
      .resize({
        width: input.maxDimension,
        height: input.maxDimension,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: input.webpQuality, effort: 4 })
      .toBuffer();
    const contentSha256 = createHash('sha256').update(webp).digest('hex');
    const objectKey = `community-logos/${input.tenantId}/${input.item.id}/${contentSha256}.webp`;
    const objectChanged =
      currentObjectPresent === false ||
      input.current?.contentSha256 !== contentSha256 ||
      input.current.objectKey !== objectKey;
    const deleteAfter = new Date(
      Date.parse(input.fetchedAt) + input.previousObjectRetentionSeconds * 1_000,
    ).toISOString();
    const preparedObject = objectChanged
      ? { key: objectKey, body: webp, sha256: contentSha256, deleteAfter }
      : undefined;
    if (preparedObject && !input.deferStorePut) await input.store.put(preparedObject);
    const delivery = input.stableDeliveryEnabled
      ? undefined
      : {
          url: await input.store.createReadUrl(objectKey),
          expiresAt: new Date(
            Date.parse(input.fetchedAt) + input.readUrlTtlSeconds * 1_000,
          ).toISOString(),
        };
    return {
      communityId: input.item.id,
      logoUrl: input.stableDeliveryEnabled
        ? communityLogoDeliveryUrl(input.tenantId, input.item.id)
        : (delivery?.url ?? null),
      outcome: objectChanged ? 'stored' : 'unchanged',
      fetchAttempted: true,
      persistence: {
        communityId: input.item.id,
        sourceUrl: input.item.legacyLogoSourceUrl,
        ...(source.etag ? { sourceEtag: source.etag } : {}),
        ...(source.lastModified ? { sourceLastModified: source.lastModified } : {}),
        contentSha256,
        objectKey,
        ...(delivery ? { deliveryUrl: delivery.url, deliveryExpiresAt: delivery.expiresAt } : {}),
        syncedAt: input.fetchedAt,
        ...(input.current?.objectKey && input.current.objectKey !== objectKey
          ? deletionFields(
              input.current.objectKey,
              input.fetchedAt,
              input.previousObjectRetentionSeconds,
            )
          : {}),
      },
      ...(input.deferStorePut && preparedObject ? { preparedObject } : {}),
    };
  } catch (error) {
    if (!input.current) {
      return {
        communityId: input.item.id,
        logoUrl: null,
        persistence: {
          communityId: input.item.id,
          syncedAt: input.fetchedAt,
        },
        outcome: 'fallback',
        ...(sourceFetchAttempted ? { fetchAttempted: true } : {}),
        errorCode: errorCode(error),
      };
    }
    let delivery: { readonly url: string; readonly expiresAt: string } | undefined;
    if (!input.stableDeliveryEnabled && currentObjectPresent !== false) {
      try {
        delivery = {
          url: await input.store.createReadUrl(input.current.objectKey),
          expiresAt: new Date(
            Date.parse(input.fetchedAt) + input.readUrlTtlSeconds * 1_000,
          ).toISOString(),
        };
      } catch {
        delivery = undefined;
      }
    }
    const code = errorCode(error);
    const persistence = persistenceFromCurrent(
      input.current,
      delivery,
      currentObjectPresent === false ? input.current.syncedAt : input.fetchedAt,
    );
    return {
      communityId: input.item.id,
      logoUrl:
        currentObjectPresent === false
          ? null
          : input.stableDeliveryEnabled
            ? communityLogoDeliveryUrl(input.tenantId, input.item.id)
            : (persistence.deliveryUrl ?? communityLogoDeliveryUrl(input.tenantId, input.item.id)),
      persistence,
      outcome: 'fallback',
      ...(sourceFetchAttempted ? { fetchAttempted: true } : {}),
      errorCode: code,
    };
  }
}

export async function synchronizeLegacyCommunityLogos(input: {
  readonly pool: Pool;
  readonly store: ProfilePhotoObjectStore;
  readonly tenantId: string;
  readonly items: readonly CommunityDirectoryItem[];
  readonly fetchedAt: string;
  readonly allowedHosts: readonly string[];
  readonly maxBytes: number;
  readonly maxDimension: number;
  readonly webpQuality: number;
  readonly previousObjectRetentionSeconds: number;
  readonly readUrlTtlSeconds?: number;
  readonly stableDeliveryEnabled?: boolean;
  readonly timeoutMs: number;
  readonly fetchImplementation?: typeof fetch;
  readonly sourceResilience?: CommunityLogoSourceResilience;
  readonly deferStorePut?: boolean;
  readonly revalidateAfterSeconds?: number;
  readonly maxConcurrency?: number;
  readonly maxFetches?: number;
}): Promise<readonly CommunityLogoSyncResult[]> {
  const readUrlTtlSeconds = input.readUrlTtlSeconds ?? 3_600;
  const stableDeliveryEnabled = input.stableDeliveryEnabled ?? true;
  const revalidateAfterSeconds = input.revalidateAfterSeconds ?? DEFAULT_REVALIDATE_AFTER_SECONDS;
  const maxConcurrency = Math.max(1, input.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
  const maxFetches = Math.max(0, input.maxFetches ?? DEFAULT_MAX_FETCHES);
  const sourceResilience =
    input.sourceResilience ??
    new CommunityLogoSourceResilience({ fetchImplementation: input.fetchImplementation ?? fetch });
  const current = await loadCommunityLogoSyncRecords({
    pool: input.pool,
    tenantId: input.tenantId,
    communityIds: input.items.map((item) => item.id),
  });
  let remainingFetches = maxFetches;
  const work = input.items.map((item) => {
    const existing = current.get(item.id);
    const fetchRequired = requiresSourceFetch({
      item,
      ...(existing ? { current: existing } : {}),
      fetchedAt: input.fetchedAt,
      revalidateAfterSeconds,
    });
    const allowFetch = !fetchRequired || remainingFetches > 0;
    if (fetchRequired && allowFetch) remainingFetches -= 1;
    return { item, existing, allowFetch };
  });
  return mapWithConcurrency({
    items: work,
    concurrency: maxConcurrency,
    operation: ({ item, existing, allowFetch }) =>
      synchronizeOne({
        ...input,
        readUrlTtlSeconds,
        stableDeliveryEnabled,
        revalidateAfterSeconds,
        allowFetch,
        item,
        ...(existing ? { current: existing } : {}),
        sourceResilience,
      }),
  });
}
