import {
  paginateCommunityDirectoryItems,
  type CommunityLegacyBridgeRepository,
  type CommunityDirectoryItem,
  type CommunityDirectoryRepository,
  type CommunityDirectoryRepositoryPage,
  type LegacyCommunityViewerIdentity,
} from './index.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_COMMUNITIES = 1_000;

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('COMMUNITY_LEGACY_RESPONSE_TOO_LARGE');
        throw new LegacyCommunityReadError('COMMUNITY_LEGACY_RESPONSE_INVALID');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export type LegacyCommunityReadErrorCode =
  | 'COMMUNITY_LEGACY_IDENTITY_UNAVAILABLE'
  | 'COMMUNITY_LEGACY_CIRCUIT_OPEN'
  | 'COMMUNITY_LEGACY_TIMEOUT'
  | 'COMMUNITY_LEGACY_UNAVAILABLE'
  | 'COMMUNITY_LEGACY_RESPONSE_INVALID';

export class LegacyCommunityReadError extends Error {
  public constructor(public readonly code: LegacyCommunityReadErrorCode) {
    super(code);
    this.name = 'LegacyCommunityReadError';
  }
}

export interface LegacyCommunityMetric {
  readonly operation: 'membership-summary';
  readonly outcome: 'success' | 'failure';
  readonly attempt: number;
  readonly durationMs: number;
  readonly status?: number;
  readonly code?: LegacyCommunityReadErrorCode;
}

interface CacheEntry {
  /** Freshness of `value`; on a value-less entry, when the shared in-flight read lease ends. */
  readonly expiresAt: number;
  /** End of the window in which `value` may still answer while it is revalidated. */
  readonly staleUntil: number;
  readonly value?: readonly CommunityDirectoryItem[];
  readonly pending?: Promise<readonly CommunityDirectoryItem[]>;
}

interface LegacyCommunityCandidate {
  readonly externalId: string;
  readonly title: string;
  readonly isVerified: boolean;
  readonly memberRank?: number;
  readonly sortAt: string;
  readonly logoSourceUrl?: string;
}

interface LegacyCommunityReadRepositoryOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly circuitFailureThreshold: number;
  readonly circuitResetMs: number;
  readonly cacheTtlMs: number;
  readonly staleTtlMs: number;
  readonly bridge: CommunityLegacyBridgeRepository;
  readonly fetchImplementation?: typeof fetch;
  readonly onMetric?: (metric: LegacyCommunityMetric) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
  const normalized = stringValue(value)?.toLowerCase();
  if (['true', '1', 'yes', 'verified', 'official', 'approved'].includes(normalized ?? '')) {
    return true;
  }
  if (['false', '0', 'no', 'unverified', 'rejected'].includes(normalized ?? '')) {
    return false;
  }
  return undefined;
}

function positiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
          ? Number(value)
          : Number.NaN;
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function normalizePhone(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const digits = String(value).replace(/\D/g, '');
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`;
  return digits.length >= 11 ? digits : undefined;
}

function identityMatches(member: unknown, identity: LegacyCommunityViewerIdentity): boolean {
  if (!isRecord(member)) return false;
  const memberId =
    stringValue(member.id) ??
    stringValue(member.clientId) ??
    stringValue(member.playerId) ??
    stringValue(member.userId) ??
    stringValue(member.uuid);
  const memberPhone = normalizePhone(
    member.phone ?? member.phoneNorm ?? member.phoneNumber ?? member.mobile,
  );
  return Boolean(
    (identity.clientId && memberId === identity.clientId) ||
    (identity.phoneE164 && memberPhone === normalizePhone(identity.phoneE164)),
  );
}

function verifiedCommunity(row: Record<string, unknown>): boolean {
  const direct = booleanValue(row.isVerified ?? row.verified ?? row.isOfficial ?? row.official);
  if (direct !== undefined) return direct;
  const nested = isRecord(row.verification)
    ? row.verification
    : isRecord(row.verificationInfo)
      ? row.verificationInfo
      : undefined;
  const nestedValue = nested
    ? booleanValue(nested.isVerified ?? nested.verified ?? nested.isOfficial ?? nested.official)
    : undefined;
  if (nestedValue !== undefined) return nestedValue;
  const status = stringValue(row.verificationStatus ?? nested?.status)?.toUpperCase();
  return status === 'VERIFIED' || status === 'APPROVED' || status === 'OFFICIAL';
}

function safeDate(...values: unknown[]): string {
  for (const value of values) {
    const candidate = stringValue(value);
    if (candidate && Number.isFinite(Date.parse(candidate)))
      return new Date(candidate).toISOString();
  }
  return new Date(0).toISOString();
}

function logoSourceUrl(row: Record<string, unknown>, baseUrl: string): string | undefined {
  for (const value of [row.logoUrl, row.logoThumbUrl, row.logo]) {
    const candidate = stringValue(value);
    if (!candidate || candidate.length > 2_048) continue;
    try {
      const url = new URL(candidate, baseUrl);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.toString();
    } catch {
      // Malformed legacy media is equivalent to no media. The public summary stays valid.
    }
  }
  return undefined;
}

function extractCandidates(
  payload: unknown,
  identity: LegacyCommunityViewerIdentity,
  baseUrl: string,
): readonly LegacyCommunityCandidate[] {
  const rows = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.communities)
      ? payload.communities
      : undefined;
  if (!rows || rows.length > MAX_SOURCE_COMMUNITIES) {
    throw new LegacyCommunityReadError('COMMUNITY_LEGACY_RESPONSE_INVALID');
  }

  const byExternalId = new Map<string, LegacyCommunityCandidate>();
  for (const value of rows) {
    if (!isRecord(value) || !Array.isArray(value.members)) continue;
    const members: readonly unknown[] = value.members;
    const viewerMember = members.find((member) => identityMatches(member, identity));
    if (!isRecord(viewerMember)) continue;
    const externalId = stringValue(value.id ?? value.communityId ?? value.uuid);
    const title = stringValue(value.name ?? value.title);
    if (!externalId || externalId.length > 500 || !title) continue;
    const sourceLogoUrl = logoSourceUrl(value, baseUrl);
    const memberRating = isRecord(viewerMember.rating) ? viewerMember.rating : undefined;
    const memberRank = positiveInteger(
      viewerMember.communityRank,
      viewerMember.ratingPosition,
      viewerMember.rank,
      viewerMember.place,
      viewerMember.position,
      memberRating?.rank,
      memberRating?.place,
      memberRating?.position,
    );
    byExternalId.set(externalId, {
      externalId,
      title: title.slice(0, 120),
      isVerified: verifiedCommunity(value),
      ...(memberRank ? { memberRank } : {}),
      sortAt: safeDate(value.lastVisibleFeedActivityAt, value.updatedAt, value.createdAt),
      ...(sourceLogoUrl ? { logoSourceUrl: sourceLogoUrl } : {}),
    });
  }
  return [...byExternalId.values()];
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class LegacyCommunityReadRepository implements CommunityDirectoryRepository {
  private readonly fetchImplementation: typeof fetch;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly revalidating = new Set<string>();
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  public constructor(private readonly options: LegacyCommunityReadRepositoryOptions) {
    this.fetchImplementation =
      options.fetchImplementation ?? ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * A directory page never fans out into per-community rating reads. The legacy summary is the only
   * source call this bridge makes; a `memberRank` it already carries is passed through, and absence
   * stays absence. Ranking the viewer is a separate, PadlHub-owned read (`ranking_position`) rather
   * than one legacy round trip per visible community.
   */
  public async listMemberships(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
    readonly limit: number;
    readonly after?: {
      readonly pinned: boolean;
      readonly sortAt: string;
      readonly id: string;
    };
  }): Promise<CommunityDirectoryRepositoryPage> {
    const items = await this.getMemberships(input);
    return paginateCommunityDirectoryItems(items, input.limit, input.after);
  }

  /**
   * The legacy projection answers in seconds, so letting an expired entry block the next reader made
   * every cold reader — a new session, a pause longer than the TTL, another API process — wait for it
   * again. A fresh entry answers directly; an entry inside the stale window answers immediately and is
   * revalidated out of band, so only the first read of a user pays the legacy latency. One revalidation
   * per key runs at a time, a failed revalidation keeps the last good page until the window closes, and
   * a reader that must block (no page, or past the window) still sees the legacy error.
   */
  private getMemberships(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
  }): Promise<readonly CommunityDirectoryItem[]> {
    const cacheKey = `${input.tenantId}:${input.userId}`;
    const cached = this.cache.get(cacheKey);
    const now = Date.now();
    if (cached) {
      if (cached.value && cached.expiresAt > now) return Promise.resolve(cached.value);
      if (cached.value && cached.staleUntil > now) {
        this.revalidateMemberships(cacheKey, cached, input);
        return Promise.resolve(cached.value);
      }
      // A shared in-flight read answers only inside its lease: a source that never settles must not
      // pin the viewer forever, so an expired lease starts a fresh read instead.
      if (!cached.value && cached.pending && cached.expiresAt > now) return cached.pending;
    }

    const pending = this.loadMemberships(input).then(
      (value) => {
        this.storeMemberships(cacheKey, value);
        return value;
      },
      (error: unknown) => {
        this.cache.delete(cacheKey);
        throw error;
      },
    );
    // A value-less entry only holds the shared in-flight read; `staleUntil` stays closed because
    // there is no page to serve while the reader waits.
    this.cache.set(cacheKey, {
      expiresAt:
        Date.now() +
        Math.max(this.options.cacheTtlMs, this.options.timeoutMs * this.options.maxAttempts + 500),
      staleUntil: Date.now(),
      pending,
    });
    return pending;
  }

  private storeMemberships(cacheKey: string, value: readonly CommunityDirectoryItem[]): void {
    if (this.options.cacheTtlMs <= 0 && this.options.staleTtlMs <= 0) {
      this.cache.delete(cacheKey);
      return;
    }
    const now = Date.now();
    this.cache.set(cacheKey, {
      expiresAt: now + this.options.cacheTtlMs,
      staleUntil: now + this.options.cacheTtlMs + this.options.staleTtlMs,
      value,
    });
    this.trimCache();
  }

  /**
   * Refreshes a stale page without holding the caller. The failure path is deliberately silent here:
   * the legacy fetch already reported its metric and opened the circuit, and the stale page keeps
   * answering until its window closes, at which point a reader blocks and sees the error. The result
   * is stored only while the entry that triggered it is still the current one, so a page that another
   * read already replaced — or that the bound evicted and reloaded — is never overwritten with older
   * data.
   */
  private revalidateMemberships(
    cacheKey: string,
    expected: CacheEntry,
    input: { readonly tenantId: string; readonly userId: string; readonly correlationId: string },
  ): void {
    if (this.revalidating.has(cacheKey)) return;
    this.revalidating.add(cacheKey);
    void this.loadMemberships(input)
      .then(
        (value) => {
          if (this.cache.get(cacheKey) !== expected) return;
          this.storeMemberships(cacheKey, value);
        },
        () => undefined,
      )
      .finally(() => {
        this.revalidating.delete(cacheKey);
      });
  }

  private trimCache(): void {
    while (this.cache.size > 500) {
      const oldest = this.cache.keys().next().value;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }

  private async loadMemberships(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
  }): Promise<readonly CommunityDirectoryItem[]> {
    if (this.circuitOpenUntil > Date.now()) {
      throw new LegacyCommunityReadError('COMMUNITY_LEGACY_CIRCUIT_OPEN');
    }
    const identity = await this.options.bridge.getViewerIdentity(input.tenantId, input.userId);
    if (!identity.phoneE164 && !identity.clientId) {
      throw new LegacyCommunityReadError('COMMUNITY_LEGACY_IDENTITY_UNAVAILABLE');
    }

    const payload = await this.fetchSummary(identity, input.correlationId);
    const candidates = extractCandidates(payload, identity, this.options.baseUrl);
    const ids = await this.options.bridge.resolveCommunityIds(
      input.tenantId,
      candidates.map((candidate) => candidate.externalId),
    );
    const internalIds = candidates
      .map((candidate) => ids.get(candidate.externalId))
      .filter((id): id is string => Boolean(id));
    const storedLogoUrls = this.options.bridge.getCommunityLogoUrls
      ? await this.options.bridge.getCommunityLogoUrls(input.tenantId, internalIds)
      : new Map<string, string>();
    const result = candidates.map((candidate) => {
      const id = ids.get(candidate.externalId);
      if (!id) throw new LegacyCommunityReadError('COMMUNITY_LEGACY_RESPONSE_INVALID');
      return {
        id,
        title: candidate.title,
        logoUrl: storedLogoUrls.get(id) ?? null,
        isVerified: candidate.isVerified,
        unreadChatCount: 0,
        ...(candidate.memberRank ? { memberRank: candidate.memberRank } : {}),
        pinned: false,
        sortAt: candidate.sortAt,
        ...(candidate.logoSourceUrl ? { legacyLogoSourceUrl: candidate.logoSourceUrl } : {}),
      } satisfies CommunityDirectoryItem;
    });
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
    return result;
  }

  private async fetchSummary(
    identity: LegacyCommunityViewerIdentity,
    correlationId: string,
  ): Promise<unknown> {
    const url = new URL('/lk/communities', this.options.baseUrl);
    url.searchParams.set('view', 'summary');
    if (identity.phoneE164) url.searchParams.set('phone', normalizePhone(identity.phoneE164) ?? '');
    if (identity.clientId) url.searchParams.set('clientId', identity.clientId);

    let lastError: LegacyCommunityReadError = new LegacyCommunityReadError(
      'COMMUNITY_LEGACY_UNAVAILABLE',
    );
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
      let status: number | undefined;
      try {
        const response = await this.fetchImplementation(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'X-Correlation-ID': correlationId,
          },
          signal: controller.signal,
        });
        status = response.status;
        if (!response.ok) {
          throw new LegacyCommunityReadError('COMMUNITY_LEGACY_UNAVAILABLE');
        }
        const contentLength = Number(response.headers.get('content-length') ?? 0);
        if (contentLength > MAX_RESPONSE_BYTES) {
          throw new LegacyCommunityReadError('COMMUNITY_LEGACY_RESPONSE_INVALID');
        }
        const text = await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
        let payload: unknown;
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          throw new LegacyCommunityReadError('COMMUNITY_LEGACY_RESPONSE_INVALID');
        }
        this.options.onMetric?.({
          operation: 'membership-summary',
          outcome: 'success',
          attempt,
          durationMs: Date.now() - startedAt,
          status,
        });
        return payload;
      } catch (error: unknown) {
        lastError =
          error instanceof LegacyCommunityReadError
            ? error
            : new LegacyCommunityReadError(
                controller.signal.aborted
                  ? 'COMMUNITY_LEGACY_TIMEOUT'
                  : 'COMMUNITY_LEGACY_UNAVAILABLE',
              );
        this.options.onMetric?.({
          operation: 'membership-summary',
          outcome: 'failure',
          attempt,
          durationMs: Date.now() - startedAt,
          ...(status === undefined ? {} : { status }),
          code: lastError.code,
        });
        if (
          attempt >= this.options.maxAttempts ||
          (status !== undefined && !retryableStatus(status)) ||
          lastError.code === 'COMMUNITY_LEGACY_RESPONSE_INVALID'
        ) {
          break;
        }
        await wait(Math.min(250, 50 * attempt));
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
