import { createHash } from 'node:crypto';

import sharp from 'sharp';

export interface EventAvatarMedia {
  read(input: { readonly cacheKey: string; readonly sourceUrl: string }): Promise<{
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
    readonly sourceUrl: string;
  }): Promise<{ readonly body: Buffer; readonly etag: string }> {
    const startedAt = Date.now();
    const now = this.options.now?.() ?? Date.now();
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
          const error = new Error('EVENT_AVATAR_SOURCE_UNAVAILABLE');
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
          [
            'EVENT_AVATAR_SOURCE_NOT_ALLOWED',
            'EVENT_AVATAR_CONTENT_TYPE_INVALID',
            'EVENT_AVATAR_RESPONSE_TOO_LARGE',
          ].includes(error.message)
        ) {
          break;
        }
      }
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= (this.options.circuitFailureThreshold ?? 3)) {
      this.circuitOpenedAt = now;
    }
    this.emit({
      operation: 'event_avatar_media',
      outcome: 'failure',
      durationMs: Date.now() - startedAt,
    });
    throw lastError instanceof Error ? lastError : new Error('EVENT_AVATAR_SOURCE_UNAVAILABLE');
  }
}
