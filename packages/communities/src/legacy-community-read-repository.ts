import {
  paginateCommunityDirectoryItems,
  type CommunityLegacyBridgeRepository,
  type CommunityDirectoryItem,
  type CommunityDirectoryRepository,
  type CommunityDirectoryRepositoryPage,
  type LegacyCommunityViewerIdentity,
} from './index.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RANK_RESPONSE_BYTES = 512 * 1024;
const MAX_SOURCE_COMMUNITIES = 1_000;
const MAX_RANK_ENRICHMENTS = 8;
const RANK_ENRICHMENT_RESPONSE_BUDGET_MS = 150;

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
  readonly operation: 'membership-summary' | 'community-rating';
  readonly outcome: 'success' | 'failure';
  readonly attempt: number;
  readonly durationMs: number;
  readonly status?: number;
  readonly code?: LegacyCommunityReadErrorCode;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly value?: readonly CommunityDirectoryItem[];
  readonly pending?: Promise<readonly CommunityDirectoryItem[]>;
}

interface RankCacheEntry {
  readonly expiresAt: number;
  readonly value?: number | null;
  readonly pending?: Promise<number | null>;
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

function extractViewerRank(
  payload: unknown,
  identity: LegacyCommunityViewerIdentity,
): number | undefined {
  if (!isRecord(payload)) return undefined;
  const nested = isRecord(payload.data) ? payload.data : undefined;
  const directViewer = isRecord(payload.viewer)
    ? payload.viewer
    : nested && isRecord(nested.viewer)
      ? nested.viewer
      : undefined;
  if (directViewer && identityMatches(directViewer, identity)) {
    const directRank = positiveInteger(
      directViewer.rank,
      directViewer.overallPlace,
      directViewer.place,
      directViewer.position,
    );
    if (directRank) return directRank;
  }

  const rowsValue =
    payload.items ??
    payload.rows ??
    payload.result ??
    (Array.isArray(payload.data) ? payload.data : undefined) ??
    nested?.items ??
    nested?.rows ??
    nested?.result;
  if (!Array.isArray(rowsValue)) return undefined;
  const viewerRow = (rowsValue as readonly unknown[]).find((row) => identityMatches(row, identity));
  if (!isRecord(viewerRow)) return undefined;
  return positiveInteger(
    viewerRow.rank,
    viewerRow.overallPlace,
    viewerRow.place,
    viewerRow.position,
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
  private readonly rankCache = new Map<string, RankCacheEntry>();
  private readonly externalCommunityIds = new Map<string, string>();
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private rankConsecutiveFailures = 0;
  private rankCircuitOpenUntil = 0;

  public constructor(private readonly options: LegacyCommunityReadRepositoryOptions) {
    this.fetchImplementation =
      options.fetchImplementation ?? ((input, init) => globalThis.fetch(input, init));
  }

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
    const page = paginateCommunityDirectoryItems(items, input.limit, input.after);
    return {
      ...page,
      items: await this.enrichMemberRanks(
        page.items,
        input.tenantId,
        input.userId,
        input.correlationId,
      ),
    };
  }

  private async enrichMemberRanks(
    items: readonly CommunityDirectoryItem[],
    tenantId: string,
    userId: string,
    correlationId: string,
  ): Promise<readonly CommunityDirectoryItem[]> {
    const identity = await this.options.bridge.getViewerIdentity(tenantId, userId);
    if (!identity.phoneE164 && !identity.clientId) return items;
    const candidates = items.filter((item) => !item.memberRank).slice(0, MAX_RANK_ENRICHMENTS);
    if (candidates.length === 0) return items;

    const ranks = new Map<string, number>();
    const enrichment = Promise.all(
      candidates.map(async (item) => {
        const externalId = this.externalCommunityIds.get(`${tenantId}:${item.id}`);
        if (!externalId) return;
        const rank = await this.getMemberRank(
          tenantId,
          userId,
          externalId,
          identity,
          correlationId,
        );
        if (rank) ranks.set(item.id, rank);
      }),
    );
    // Rank is optional presentation data. Keep slow legacy rating endpoints
    // from delaying the canonical membership page; in-flight requests still
    // populate the short-lived rank cache for the next read.
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      enrichment,
      new Promise<void>((resolve) => {
        budgetTimer = setTimeout(resolve, RANK_ENRICHMENT_RESPONSE_BUDGET_MS);
        budgetTimer.unref?.();
      }),
    ]).finally(() => {
      if (budgetTimer) clearTimeout(budgetTimer);
    });
    return items.map((item) => {
      const memberRank = ranks.get(item.id);
      return memberRank ? { ...item, memberRank } : item;
    });
  }

  private getMemberRank(
    tenantId: string,
    userId: string,
    externalCommunityId: string,
    identity: LegacyCommunityViewerIdentity,
    correlationId: string,
  ): Promise<number | null> {
    const cacheKey = `${tenantId}:${userId}:${externalCommunityId}`;
    const cached = this.rankCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.value !== undefined) return Promise.resolve(cached.value);
      if (cached.pending) return cached.pending;
    }

    const pending = this.fetchMemberRank(externalCommunityId, identity, correlationId).then(
      (value) => {
        const normalized = value ?? null;
        this.rankCache.set(cacheKey, {
          expiresAt: Date.now() + Math.max(5_000, this.options.cacheTtlMs),
          value: normalized,
        });
        return normalized;
      },
      () => {
        this.rankCache.set(cacheKey, {
          expiresAt: Date.now() + 5_000,
          value: null,
        });
        return null;
      },
    );
    this.rankCache.set(cacheKey, {
      expiresAt: Date.now() + Math.max(5_000, this.options.timeoutMs * 2 + 500),
      pending,
    });
    return pending;
  }

  private async fetchMemberRank(
    externalCommunityId: string,
    identity: LegacyCommunityViewerIdentity,
    correlationId: string,
  ): Promise<number | undefined> {
    if (this.rankCircuitOpenUntil > Date.now()) {
      this.options.onMetric?.({
        operation: 'community-rating',
        outcome: 'failure',
        attempt: 1,
        durationMs: 0,
        code: 'COMMUNITY_LEGACY_CIRCUIT_OPEN',
      });
      return undefined;
    }
    for (const route of ['rating', 'ranking'] as const) {
      const url = new URL(
        `/lk/communities/${encodeURIComponent(externalCommunityId)}/${route}`,
        this.options.baseUrl,
      );
      if (identity.phoneE164)
        url.searchParams.set('phone', normalizePhone(identity.phoneE164) ?? '');
      if (identity.clientId) url.searchParams.set('clientId', identity.clientId);
      url.searchParams.set('tab', 'overall');
      url.searchParams.set('period', '30d');
      url.searchParams.set('calculationVersion', 'community-rating-v1.3.0');
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const response = await this.fetchImplementation(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'X-Correlation-ID': correlationId,
          },
          signal: controller.signal,
        });
        if (!response.ok) {
          this.options.onMetric?.({
            operation: 'community-rating',
            outcome: 'failure',
            attempt: 1,
            durationMs: Date.now() - startedAt,
            status: response.status,
            code: 'COMMUNITY_LEGACY_UNAVAILABLE',
          });
          if (response.status === 404 && route === 'rating') continue;
          this.recordRankFailure();
          return undefined;
        }
        const contentLength = Number(response.headers.get('content-length') ?? 0);
        if (contentLength > MAX_RANK_RESPONSE_BYTES) {
          this.recordRankFailure();
          return undefined;
        }
        const text = await readBoundedResponseText(response, MAX_RANK_RESPONSE_BYTES);
        const payload = JSON.parse(text) as unknown;
        const rank = extractViewerRank(payload, identity);
        this.rankConsecutiveFailures = 0;
        this.rankCircuitOpenUntil = 0;
        this.options.onMetric?.({
          operation: 'community-rating',
          outcome: 'success',
          attempt: 1,
          durationMs: Date.now() - startedAt,
          status: response.status,
        });
        return rank;
      } catch {
        this.recordRankFailure();
        this.options.onMetric?.({
          operation: 'community-rating',
          outcome: 'failure',
          attempt: 1,
          durationMs: Date.now() - startedAt,
          code: controller.signal.aborted
            ? 'COMMUNITY_LEGACY_TIMEOUT'
            : 'COMMUNITY_LEGACY_RESPONSE_INVALID',
        });
        return undefined;
      } finally {
        clearTimeout(timeout);
      }
    }
    return undefined;
  }

  private recordRankFailure(): void {
    this.rankConsecutiveFailures += 1;
    if (this.rankConsecutiveFailures >= this.options.circuitFailureThreshold) {
      this.rankCircuitOpenUntil = Date.now() + this.options.circuitResetMs;
    }
  }

  private getMemberships(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
  }): Promise<readonly CommunityDirectoryItem[]> {
    const cacheKey = `${input.tenantId}:${input.userId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.value) return Promise.resolve(cached.value);
      if (cached.pending) return cached.pending;
    }

    const pending = this.loadMemberships(input).then(
      (value) => {
        if (this.options.cacheTtlMs > 0) {
          this.cache.set(cacheKey, {
            expiresAt: Date.now() + this.options.cacheTtlMs,
            value,
          });
          this.trimCache();
        } else {
          this.cache.delete(cacheKey);
        }
        return value;
      },
      (error: unknown) => {
        this.cache.delete(cacheKey);
        throw error;
      },
    );
    this.cache.set(cacheKey, {
      expiresAt:
        Date.now() +
        Math.max(this.options.cacheTtlMs, this.options.timeoutMs * this.options.maxAttempts + 500),
      pending,
    });
    return pending;
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
      this.externalCommunityIds.set(`${input.tenantId}:${id}`, candidate.externalId);
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
