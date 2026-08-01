import { createHash } from 'node:crypto';

import type { TrainerAvatarRepository } from '@phub/database';
import sharp from 'sharp';

import type { TrainerAvatarMediaStore } from './trainer-avatar-media-store.js';

export interface TrainerAvatarIdentity {
  readonly provider: 'VIVA';
  readonly providerTrainerId: string;
  readonly displayName: string;
}

export interface EventAvatarMedia {
  read(input: {
    readonly cacheKey: string;
    readonly sourceUrl?: string;
    readonly tenantId?: string;
    readonly trainer?: TrainerAvatarIdentity;
  }): Promise<{
    readonly body: Buffer;
    readonly etag: string;
  }>;
}

export interface EventAvatarMediaProxyOptions {
  readonly allowedHosts: readonly string[];
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxDimension: number;
  readonly webpQuality: number;
  readonly maxCacheEntries?: number;
  readonly cacheTtlMs?: number;
  readonly circuitFailureThreshold?: number;
  readonly circuitResetMs?: number;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => number;
  readonly onMetric?: (metric: {
    readonly operation: 'event_avatar_media';
    readonly outcome: 'success' | 'failure' | 'cache' | 'circuit_open';
    readonly durationMs: number;
  }) => void;
}

interface CacheEntry {
  readonly sourceFingerprint: string;
  readonly body: Buffer;
  readonly etag: string;
  readonly storedAt: number;
}

function hostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLocaleLowerCase('en-US');
  return allowedHosts.some((rawAllowed) => {
    const allowed = rawAllowed.trim().toLocaleLowerCase('en-US');
    if (!allowed) return false;
    return allowed.startsWith('.')
      ? host.endsWith(allowed) && host.length > allowed.length
      : host === allowed;
  });
}

function validatedSourceUrl(value: string, allowedHosts: readonly string[]): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !hostAllowed(url.hostname, allowedHosts)
  ) {
    throw new Error('EVENT_AVATAR_SOURCE_NOT_ALLOWED');
  }
  return url;
}

function sourceFingerprint(url: URL): string {
  return createHash('sha256').update(url.toString()).digest('base64url');
}

function responseMayBeRetried(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export class EventAvatarMediaProxy implements EventAvatarMedia {
  private readonly cache = new Map<string, CacheEntry>();
  private consecutiveFailures = 0;
  private circuitOpenedAt: number | undefined;

  public constructor(private readonly options: EventAvatarMediaProxyOptions) {}

  private emit(metric: Parameters<NonNullable<EventAvatarMediaProxyOptions['onMetric']>>[0]): void {
    try {
      this.options.onMetric?.(metric);
    } catch {
      // Telemetry must never change media delivery.
    }
  }

  private remember(cacheKey: string, entry: CacheEntry): void {
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, entry);
    const maxEntries = this.options.maxCacheEntries ?? 100;
    while (this.cache.size > maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }

  public async read(input: {
    readonly cacheKey: string;
    readonly sourceUrl?: string;
    readonly tenantId?: string;
    readonly trainer?: TrainerAvatarIdentity;
  }): Promise<{ readonly body: Buffer; readonly etag: string }> {
    const startedAt = Date.now();
    const now = this.options.now?.() ?? Date.now();
    if (!input.sourceUrl) throw new Error('EVENT_AVATAR_SOURCE_NOT_FOUND');
    const url = validatedSourceUrl(input.sourceUrl, this.options.allowedHosts);
    const fingerprint = sourceFingerprint(url);
    const cached = this.cache.get(input.cacheKey);
    if (
      cached &&
      cached.sourceFingerprint === fingerprint &&
      now - cached.storedAt <= (this.options.cacheTtlMs ?? 300_000)
    ) {
      this.emit({ operation: 'event_avatar_media', outcome: 'cache', durationMs: 0 });
      return { body: cached.body, etag: cached.etag };
    }

    const resetMs = this.options.circuitResetMs ?? 30_000;
    if (this.circuitOpenedAt !== undefined && now - this.circuitOpenedAt < resetMs) {
      this.emit({ operation: 'event_avatar_media', outcome: 'circuit_open', durationMs: 0 });
      throw new Error('EVENT_AVATAR_MEDIA_CIRCUIT_OPEN');
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await (this.options.fetchImplementation ?? fetch)(url, {
          headers: { Accept: 'image/avif,image/webp,image/*' },
          redirect: 'error',
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
        if (!response.ok) {
          const error = new Error(`EVENT_AVATAR_SOURCE_HTTP_${response.status}`);
          if (!responseMayBeRetried(response.status)) throw error;
          lastError = error;
          continue;
        }
        const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
        if (!contentType?.startsWith('image/')) {
          throw new Error('EVENT_AVATAR_CONTENT_TYPE_INVALID');
        }
        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > this.options.maxBytes) {
          throw new Error('EVENT_AVATAR_RESPONSE_TOO_LARGE');
        }
        const source = Buffer.from(await response.arrayBuffer());
        if (source.byteLength > this.options.maxBytes) {
          throw new Error('EVENT_AVATAR_RESPONSE_TOO_LARGE');
        }
        const body = await sharp(source, { failOn: 'error', limitInputPixels: 40_000_000 })
          .rotate()
          .resize({
            width: this.options.maxDimension,
            height: this.options.maxDimension,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: this.options.webpQuality })
          .toBuffer();
        const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
        this.remember(input.cacheKey, {
          sourceFingerprint: fingerprint,
          body,
          etag,
          storedAt: now,
        });
        this.consecutiveFailures = 0;
        this.circuitOpenedAt = undefined;
        this.emit({
          operation: 'event_avatar_media',
          outcome: 'success',
          durationMs: Date.now() - startedAt,
        });
        return { body, etag };
      } catch (error) {
        lastError = error;
        if (
          error instanceof Error &&
          ([
            'EVENT_AVATAR_SOURCE_NOT_ALLOWED',
            'EVENT_AVATAR_CONTENT_TYPE_INVALID',
            'EVENT_AVATAR_RESPONSE_TOO_LARGE',
          ].includes(error.message) ||
            /^EVENT_AVATAR_SOURCE_HTTP_4\d\d$/.test(error.message))
        ) {
          break;
        }
      }
    }

    const sourceSpecificFailure =
      lastError instanceof Error && /^EVENT_AVATAR_SOURCE_HTTP_4\d\d$/.test(lastError.message);
    if (!sourceSpecificFailure) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= (this.options.circuitFailureThreshold ?? 3)) {
        this.circuitOpenedAt = now;
      }
    }
    this.emit({
      operation: 'event_avatar_media',
      outcome: 'failure',
      durationMs: Date.now() - startedAt,
    });
    throw lastError instanceof Error ? lastError : new Error('EVENT_AVATAR_SOURCE_UNAVAILABLE');
  }
}

export class PersistentTrainerAvatarMedia implements EventAvatarMedia {
  public constructor(
    private readonly options: {
      readonly remote: EventAvatarMedia;
      readonly repository: TrainerAvatarRepository;
      readonly store: TrainerAvatarMediaStore;
      readonly maxBytes: number;
      readonly onPersistenceError?: (error: unknown) => void;
    },
  ) {}

  private report(error: unknown): void {
    try {
      this.options.onPersistenceError?.(error);
    } catch {
      // Diagnostics must never change media delivery.
    }
  }

  public async read(input: {
    readonly cacheKey: string;
    readonly sourceUrl?: string;
    readonly tenantId?: string;
    readonly trainer?: TrainerAvatarIdentity;
  }): Promise<{ readonly body: Buffer; readonly etag: string }> {
    if (!input.tenantId || !input.trainer) return this.options.remote.read(input);

    const existing = await this.options.repository.getByProviderIdentity(
      input.tenantId,
      input.trainer.provider,
      input.trainer.providerTrainerId,
    );
    let local: { readonly body: Buffer; readonly etag: string } | undefined;
    if (existing?.objectKey) {
      try {
        const body = await this.options.store.read(existing.objectKey, this.options.maxBytes);
        local = {
          body,
          etag: `"${createHash('sha256').update(body).digest('base64url')}"`,
        };
        if (!input.sourceUrl || input.sourceUrl === existing.sourceUrl) return local;
      } catch (error) {
        this.report(error);
      }
    }

    const profile =
      existing ??
      (await this.options.repository.save({
        tenantId: input.tenantId,
        provider: input.trainer.provider,
        providerTrainerId: input.trainer.providerTrainerId,
        displayName: input.trainer.displayName,
        ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
      }));
    const sourceUrl = input.sourceUrl ?? profile.sourceUrl;
    if (!sourceUrl) throw new Error('EVENT_AVATAR_SOURCE_NOT_FOUND');

    let remote: { readonly body: Buffer; readonly etag: string };
    try {
      remote = await this.options.remote.read({ ...input, sourceUrl });
    } catch (error) {
      await this.options.repository
        .save({
          tenantId: input.tenantId,
          provider: input.trainer.provider,
          providerTrainerId: input.trainer.providerTrainerId,
          displayName: input.trainer.displayName,
          sourceUrl,
          lastErrorCode: error instanceof Error ? error.message.slice(0, 100) : 'UNKNOWN',
        })
        .catch((persistenceError) => this.report(persistenceError));
      if (local) return local;
      throw error;
    }

    const contentSha256 = createHash('sha256').update(remote.body).digest('hex');
    const objectKey = `trainer-avatars/${input.tenantId}/${profile.trainerId}/${contentSha256}.webp`;
    try {
      await this.options.store.put({ key: objectKey, body: remote.body, sha256: contentSha256 });
      await this.options.repository.save({
        tenantId: input.tenantId,
        provider: input.trainer.provider,
        providerTrainerId: input.trainer.providerTrainerId,
        displayName: input.trainer.displayName,
        sourceUrl,
        objectKey,
        contentSha256,
        syncedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.report(error);
    }
    return remote;
  }
}
