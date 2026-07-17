const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_PROMOTIONS = 20;

export type LegacyPromotionSourceErrorCode =
  | 'PROMOTION_LEGACY_CIRCUIT_OPEN'
  | 'PROMOTION_LEGACY_TIMEOUT'
  | 'PROMOTION_LEGACY_UNAVAILABLE'
  | 'PROMOTION_LEGACY_RESPONSE_INVALID';

export class LegacyPromotionSourceError extends Error {
  public constructor(public readonly code: LegacyPromotionSourceErrorCode) {
    super(code);
    this.name = 'LegacyPromotionSourceError';
  }
}

export interface LegacyPromotionSourceItem {
  readonly externalId: string;
  readonly title: string;
  readonly href: string;
  readonly imageSourceUrl: string;
}

export interface LegacyPromotionSourceSnapshot {
  readonly rotationEnabled: boolean;
  readonly items: readonly LegacyPromotionSourceItem[];
  readonly updatedAt?: string;
}

export interface LegacyPromotionSourceMetric {
  readonly outcome: 'success' | 'failure';
  readonly attempt: number;
  readonly durationMs: number;
  readonly status?: number;
  readonly code?: LegacyPromotionSourceErrorCode;
}

export interface LegacyPromotionSourceOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly circuitFailureThreshold: number;
  readonly circuitResetMs: number;
  readonly fetchImplementation?: typeof fetch;
  readonly onMetric?: (metric: LegacyPromotionSourceMetric) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function safeHref(value: unknown): string | undefined {
  const href = stringValue(value);
  if (!href || href.length > 4_000 || /^\/\//.test(href)) return undefined;
  if (/^(?:\/|#|mailto:|tel:)/i.test(href)) return href;
  try {
    const url = new URL(href);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function imageSourceUrl(value: unknown, baseUrl: string): string | undefined {
  const candidate = stringValue(value);
  if (!candidate || candidate.length > 2_048) return undefined;
  try {
    const url = new URL(candidate, baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizeSnapshot(payload: unknown, baseUrl: string): LegacyPromotionSourceSnapshot {
  if (!isRecord(payload) || payload.placement !== 'cabinet_home' || !Array.isArray(payload.ads)) {
    throw new LegacyPromotionSourceError('PROMOTION_LEGACY_RESPONSE_INVALID');
  }
  if (payload.ads.length > MAX_PROMOTIONS) {
    throw new LegacyPromotionSourceError('PROMOTION_LEGACY_RESPONSE_INVALID');
  }
  const byId = new Map<string, LegacyPromotionSourceItem>();
  for (const [index, value] of payload.ads.entries()) {
    if (!isRecord(value)) {
      throw new LegacyPromotionSourceError('PROMOTION_LEGACY_RESPONSE_INVALID');
    }
    const externalId = stringValue(value.id);
    const href = safeHref(value.href);
    const sourceUrl = imageSourceUrl(value.imageUrl, baseUrl);
    if (!externalId || externalId.length > 500 || !href || !sourceUrl) {
      throw new LegacyPromotionSourceError('PROMOTION_LEGACY_RESPONSE_INVALID');
    }
    byId.set(externalId, {
      externalId,
      title: (stringValue(value.title) ?? `Акция ${index + 1}`).slice(0, 120),
      href,
      imageSourceUrl: sourceUrl,
    });
  }
  const updatedAt = stringValue(payload.updatedAt);
  return {
    rotationEnabled: payload.rotationEnabled === true,
    items: [...byId.values()],
    ...(updatedAt && Number.isFinite(Date.parse(updatedAt))
      ? { updatedAt: new Date(updatedAt).toISOString() }
      : {}),
  };
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const announced = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(announced) && announced > MAX_RESPONSE_BYTES) {
    throw new LegacyPromotionSourceError('PROMOTION_LEGACY_RESPONSE_INVALID');
  }
  if (!response.body) throw new LegacyPromotionSourceError('PROMOTION_LEGACY_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new LegacyPromotionSourceError('PROMOTION_LEGACY_RESPONSE_INVALID');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const body = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      total,
    ).toString('utf8');
    return JSON.parse(body) as unknown;
  } catch {
    throw new LegacyPromotionSourceError('PROMOTION_LEGACY_RESPONSE_INVALID');
  }
}

export class LegacyPromotionSource {
  private readonly fetchImplementation: typeof fetch;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  public constructor(private readonly options: LegacyPromotionSourceOptions) {
    this.fetchImplementation =
      options.fetchImplementation ?? ((input, init) => globalThis.fetch(input, init));
  }

  public async getSnapshot(correlationId: string): Promise<LegacyPromotionSourceSnapshot> {
    if (this.circuitOpenUntil > Date.now()) {
      throw new LegacyPromotionSourceError('PROMOTION_LEGACY_CIRCUIT_OPEN');
    }
    const url = new URL('/api/advertising/cabinet-home', this.options.baseUrl);
    let lastError = new LegacyPromotionSourceError('PROMOTION_LEGACY_UNAVAILABLE');
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const response = await this.fetchImplementation(url, {
          method: 'GET',
          redirect: 'error',
          headers: {
            Accept: 'application/json',
            'X-Correlation-ID': correlationId,
          },
          signal: controller.signal,
        });
        if (!response.ok) {
          const code: LegacyPromotionSourceErrorCode = 'PROMOTION_LEGACY_UNAVAILABLE';
          this.options.onMetric?.({
            outcome: 'failure',
            attempt,
            durationMs: Date.now() - startedAt,
            status: response.status,
            code,
          });
          lastError = new LegacyPromotionSourceError(code);
          if (!retryableStatus(response.status)) break;
          continue;
        }
        const snapshot = normalizeSnapshot(await readBoundedJson(response), this.options.baseUrl);
        this.consecutiveFailures = 0;
        this.circuitOpenUntil = 0;
        this.options.onMetric?.({
          outcome: 'success',
          attempt,
          durationMs: Date.now() - startedAt,
          status: response.status,
        });
        return snapshot;
      } catch (error) {
        const code: LegacyPromotionSourceErrorCode =
          error instanceof LegacyPromotionSourceError
            ? error.code
            : error instanceof Error && error.name === 'AbortError'
              ? 'PROMOTION_LEGACY_TIMEOUT'
              : 'PROMOTION_LEGACY_UNAVAILABLE';
        lastError = new LegacyPromotionSourceError(code);
        this.options.onMetric?.({
          outcome: 'failure',
          attempt,
          durationMs: Date.now() - startedAt,
          code,
        });
        if (code === 'PROMOTION_LEGACY_RESPONSE_INVALID') break;
      } finally {
        clearTimeout(timeout);
      }
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.options.circuitFailureThreshold) {
      this.circuitOpenUntil = Date.now() + this.options.circuitResetMs;
    }
    throw lastError;
  }
}
