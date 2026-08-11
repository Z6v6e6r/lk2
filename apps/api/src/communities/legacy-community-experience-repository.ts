import type {
  CommunityLegacyBridgeRepository,
  CommunityReadExperienceRepository,
} from '@phub/communities';

export type LegacyCommunityExperienceErrorCode =
  | 'COMMUNITY_EXPERIENCE_NOT_FOUND'
  | 'COMMUNITY_EXPERIENCE_FORBIDDEN'
  | 'COMMUNITY_EXPERIENCE_UNAVAILABLE'
  | 'COMMUNITY_EXPERIENCE_PROVIDER_INVALID'
  | 'COMMUNITY_EXPERIENCE_VERSION_UNAVAILABLE';
export class LegacyCommunityExperienceError extends Error {
  public constructor(
    public readonly code: LegacyCommunityExperienceErrorCode,
    public readonly diagnostic?: string,
  ) {
    super(code);
    this.name = 'LegacyCommunityExperienceError';
  }
}
type RecordValue = Record<string, unknown>;
interface AuthorizedCommunityAccess {
  readonly externalId: string;
  readonly identity: { readonly phoneE164?: string; readonly clientId?: string };
  readonly summary: RecordValue;
}
const maxBytes = 2 * 1024 * 1024;
const maxRows = 100;
const maxSummaryCommunities = 1_000;
function record(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown, max = 8_000): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max
    ? value.trim()
    : undefined;
}
function number(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 64) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function date(value: unknown): string | undefined {
  const v = text(value, 100);
  return v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : undefined;
}
function identityMatches(
  member: RecordValue,
  identity: { phoneE164?: string; clientId?: string },
): boolean {
  const id =
    text(member.id) ?? text(member.clientId) ?? text(member.userId) ?? text(member.authorId);
  const phone = normalizedPhone(text(member.phone) ?? text(member.authorPhone));
  const normalized = normalizedPhone(identity.phoneE164);
  return Boolean(
    (identity.clientId && id === identity.clientId) || (normalized && phone === normalized),
  );
}
function active(member: RecordValue): boolean {
  return String(member.status ?? member.membershipStatus).toUpperCase() === 'ACTIVE';
}
function normalizedPhone(value: string | undefined): string | undefined {
  const digits = value?.replace(/\D/g, '');
  if (!digits) return undefined;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`;
  return digits.length >= 11 ? digits : undefined;
}
function cursor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const raw: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    const beforeTs = record(raw) ? raw.beforeTs : undefined;
    if (record(raw) && raw.v === 1 && typeof beforeTs === 'string' && date(beforeTs))
      return beforeTs;
  } catch {
    throw new LegacyCommunityExperienceError('COMMUNITY_EXPERIENCE_PROVIDER_INVALID');
  }
  throw new LegacyCommunityExperienceError('COMMUNITY_EXPERIENCE_PROVIDER_INVALID');
}
function next(beforeTs: string | undefined): string | undefined {
  return beforeTs
    ? Buffer.from(JSON.stringify({ v: 1, beforeTs }), 'utf8').toString('base64url')
    : undefined;
}

export class LegacyCommunityExperienceRepository implements CommunityReadExperienceRepository {
  private readonly fetchImplementation: typeof fetch;
  private readonly baseUrl: URL;
  private readonly circuit = new Map<string, { failures: number; openUntil: number }>();
  private readonly readsInFlight = new Map<string, Promise<unknown>>();
  private readonly authorizationInFlight = new Map<string, Promise<AuthorizedCommunityAccess>>();
  public constructor(
    private readonly options: {
      readonly baseUrl: string;
      readonly timeoutMs: number;
      readonly maxAttempts: number;
      readonly circuitFailureThreshold: number;
      readonly circuitResetMs: number;
      readonly bridge: CommunityLegacyBridgeRepository;
      readonly fetchImplementation?: typeof fetch;
      readonly onMetric?: (metric: {
        operation: string;
        outcome: 'success' | 'failure';
        status?: number;
        attempt: number;
        durationMs: number;
      }) => void;
    },
  ) {
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    try {
      this.baseUrl = new URL(options.baseUrl);
    } catch {
      throw new LegacyCommunityExperienceError('COMMUNITY_EXPERIENCE_PROVIDER_INVALID');
    }
    if (
      this.baseUrl.protocol !== 'https:' ||
      this.baseUrl.username ||
      this.baseUrl.password ||
      this.baseUrl.pathname !== '/' ||
      this.baseUrl.search ||
      this.baseUrl.hash
    )
      throw new LegacyCommunityExperienceError('COMMUNITY_EXPERIENCE_PROVIDER_INVALID');
  }
  public getDetail(input: Parameters<CommunityReadExperienceRepository['getDetail']>[0]) {
    return this.authorized(input).then(async (access) => {
      const detail = access.summary;
      const storedLogos = this.options.bridge.getCommunityLogoUrls
        ? await this.options.bridge.getCommunityLogoUrls(input.tenantId, [input.communityId])
        : new Map<string, string>();
      return {
        id: input.communityId,
        title: requiredText(detail.name ?? detail.title, 120, 'detail-title'),
        logoUrl: storedLogos.get(input.communityId) ?? null,
        isVerified: detail.isVerified === true,
        description: text(detail.description, 2_000) ?? null,
        memberCount: requiredCount(
          detail.memberCount ?? detail.membersCount ?? detail.members,
          'detail-member-count',
        ),
        readOnly: true,
      };
    });
  }
  public async getFeed(input: Parameters<CommunityReadExperienceRepository['getFeed']>[0]) {
    const access = await this.authorized(input);
    return this.page(
      await this.getJson(this.path(access, 'feed', input.limit, input.cursor), input.correlationId),
      'posts',
      input.limit,
      input.cursor,
      (row) => ({
        kind: kind(row.kind ?? row.type, 'feed-kind'),
        title: text(row.title, 240) ?? null,
        body: text(row.body ?? row.text) ?? '',
        publishedAt: requiredDate(row.publishedAt ?? row.createdAt, 'feed-published-at'),
        author: {
          displayName: requiredText(
            record(row.author) ? (row.author.displayName ?? row.author.name) : row.authorName,
            120,
            'feed-author-name',
          ),
        },
        ...(integer(row.likesCount) === undefined ? {} : { likesCount: integer(row.likesCount) }),
        ...(integer(row.commentsCount) === undefined
          ? {}
          : { commentsCount: integer(row.commentsCount) }),
      }),
    );
  }
  public async getChat(input: Parameters<CommunityReadExperienceRepository['getChat']>[0]) {
    const access = await this.authorized(input);
    return this.page(
      await this.getJson(
        this.path(access, 'messages', input.limit, input.cursor),
        input.correlationId,
      ),
      'messages',
      input.limit,
      input.cursor,
      (row) => ({
        body: requiredText(row.body ?? row.text),
        sentAt: requiredDate(row.sentAt ?? row.createdAt),
        author: {
          displayName: requiredText(
            record(row.author) ? (row.author.displayName ?? row.author.name) : row.authorName,
            120,
          ),
        },
        isViewer: record(row.author)
          ? identityMatches(row.author, access.identity)
          : identityMatches(row, access.identity),
      }),
    );
  }
  public async getRating(input: Parameters<CommunityReadExperienceRepository['getRating']>[0]) {
    const access = await this.authorized(input);
    const transportTab = input.tab === 'dynamics' ? 'level' : input.tab;
    const suffix = `period=${input.period}&tab=${transportTab}&calculationVersion=community-rating-v1.3.0`;
    let body: unknown;
    try {
      body = await this.getJson(this.path(access, `rating?${suffix}`, 100), input.correlationId);
    } catch (error) {
      if (
        !(error instanceof LegacyCommunityExperienceError) ||
        error.code !== 'COMMUNITY_EXPERIENCE_NOT_FOUND'
      )
        throw error;
      body = await this.getJson(this.path(access, `ranking?${suffix}`, 100), input.correlationId);
    }
    const sourceRows = record(body)
      ? Array.isArray(body.rows)
        ? body.rows
        : body.items
      : undefined;
    if (!record(body) || body.calculationVersion !== 'community-rating-v1.3.0')
      throw new LegacyCommunityExperienceError('COMMUNITY_EXPERIENCE_VERSION_UNAVAILABLE');
    if (!Array.isArray(sourceRows)) invalid('rating-rows');
    return {
      period: input.period,
      tab: input.tab,
      calculationVersion: 'community-rating-v1.3.0',
      rows: sourceRows.slice(0, 100).map((value, index) => {
        if (!record(value)) invalid('rating-row');
        return {
          place: requiredPositive(value.place ?? value.rank ?? index + 1, 'rating-place'),
          displayName: requiredText(
            value.displayName ?? value.playerName ?? value.name,
            120,
            'rating-name',
          ),
          currentLevel: requiredNumber(value.currentLevel ?? value.level ?? 0, 'rating-level'),
          score: requiredNumber(value.overallScore ?? value.score ?? 0, 'rating-score'),
          delta: requiredNumber(
            value.levelDelta ?? value.lastRatingDelta ?? value.delta ?? 0,
            'rating-delta',
          ),
          games: requiredNumber(value.gamesPlayed ?? value.games ?? 0, 'rating-games'),
          tournaments: requiredNumber(
            value.tournamentsPlayed ?? value.tournaments ?? 0,
            'rating-tournaments',
          ),
        };
      }),
    };
  }
  private async authorized(input: {
    tenantId: string;
    viewerUserId: string;
    communityId: string;
    correlationId: string;
  }): Promise<AuthorizedCommunityAccess> {
    const key = `${input.tenantId}:${input.viewerUserId}:${input.communityId}`;
    const existing = this.authorizationInFlight.get(key);
    if (existing) return existing;
    const pending = this.resolveAuthorization(input).finally(() => {
      if (this.authorizationInFlight.get(key) === pending) this.authorizationInFlight.delete(key);
    });
    this.authorizationInFlight.set(key, pending);
    return pending;
  }
  private async resolveAuthorization(input: {
    tenantId: string;
    viewerUserId: string;
    communityId: string;
    correlationId: string;
  }): Promise<AuthorizedCommunityAccess> {
    const externalId = await this.options.bridge.getCommunityExternalId?.(
      input.tenantId,
      input.communityId,
    );
    if (!externalId) throw new LegacyCommunityExperienceError('COMMUNITY_EXPERIENCE_NOT_FOUND');
    const identity = await this.options.bridge.getViewerIdentity(
      input.tenantId,
      input.viewerUserId,
    );
    if (!identity.clientId && !identity.phoneE164)
      throw new LegacyCommunityExperienceError('COMMUNITY_EXPERIENCE_FORBIDDEN');
    const summary = await this.getJson(this.summaryPath(identity), input.correlationId);
    const community = this.summaryActiveCommunity(summary, externalId, identity);
    if (!community) throw new LegacyCommunityExperienceError('COMMUNITY_EXPERIENCE_FORBIDDEN');
    return { externalId, identity, summary: community };
  }
  private summaryPath(identity: { phoneE164?: string; clientId?: string }) {
    const query = new URLSearchParams({ view: 'summary' });
    const phone = normalizedPhone(identity.phoneE164);
    if (phone) query.set('phone', phone);
    if (identity.clientId) query.set('clientId', identity.clientId);
    return `/lk/communities?${query}`;
  }
  private summaryActiveCommunity(
    payload: unknown,
    externalId: string,
    identity: { phoneE164?: string; clientId?: string },
  ): RecordValue | undefined {
    const communities: unknown = record(payload) ? payload.communities : undefined;
    if (!Array.isArray(communities) || communities.length > maxSummaryCommunities) return undefined;
    const community: unknown = (communities as unknown[]).find(
      (value) =>
        record(value) &&
        (text(value.id) ?? text(value.communityId) ?? text(value.uuid)) === externalId,
    );
    if (
      !record(community) ||
      !Array.isArray(community.members) ||
      !community.members.some(
        (member) => record(member) && active(member) && identityMatches(member, identity),
      )
    )
      return undefined;
    return community;
  }
  private path(
    access: { externalId: string; identity: { phoneE164?: string; clientId?: string } },
    suffix: string,
    limit?: number,
    value?: string,
  ) {
    const query = new URLSearchParams();
    const phone = normalizedPhone(access.identity.phoneE164);
    if (phone) query.set('phone', phone);
    if (access.identity.clientId) query.set('clientId', access.identity.clientId);
    if (limit !== undefined) query.set('limit', String(limit));
    const beforeTs = cursor(value);
    if (beforeTs) query.set('beforeTs', String(Date.parse(beforeTs)));
    const separator = suffix.includes('?') ? '&' : '?';
    return `/lk/communities/${encodeURIComponent(access.externalId)}${suffix ? `/${suffix}` : ''}${separator}${query}`;
  }
  private getJson(path: string, correlationId: string): Promise<unknown> {
    const existing = this.readsInFlight.get(path);
    if (existing) return existing;
    const pending = this.fetchJson(path, correlationId).finally(() => {
      if (this.readsInFlight.get(path) === pending) this.readsInFlight.delete(path);
    });
    this.readsInFlight.set(path, pending);
    return pending;
  }
  private async fetchJson(path: string, correlationId: string): Promise<unknown> {
    const operation = path.includes('/messages')
      ? 'chat'
      : path.includes('/rating') || path.includes('/ranking')
        ? 'rating'
        : path.includes('/feed')
          ? 'feed'
          : path.includes('view=summary')
            ? 'membership'
            : 'detail';
    const state = this.circuit.get(operation);
    if (state && state.openUntil > Date.now()) {
      this.options.onMetric?.({
        operation,
        outcome: 'failure',
        attempt: 0,
        durationMs: 0,
      });
      throw new LegacyCommunityExperienceError('COMMUNITY_EXPERIENCE_UNAVAILABLE');
    }
    let lastError: LegacyCommunityExperienceError | undefined;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      let status: number | undefined;
      try {
        const response = await this.fetchImplementation(new URL(path, this.baseUrl), {
          method: 'GET',
          signal: controller.signal,
          redirect: 'error',
          headers: { Accept: 'application/json', 'X-Correlation-ID': correlationId },
        });
        status = response.status;
        if (response.status === 404)
          throw new LegacyCommunityExperienceError('COMMUNITY_EXPERIENCE_NOT_FOUND');
        if (!response.ok)
          throw new LegacyCommunityExperienceError('COMMUNITY_EXPERIENCE_UNAVAILABLE');
        const length = Number(response.headers.get('content-length'));
        if (Number.isFinite(length) && length > maxBytes) invalid('provider-content-length');
        const body = await response.text();
        if (Buffer.byteLength(body) > maxBytes) invalid('provider-body-bytes');
        let parsed: unknown;
        try {
          parsed = JSON.parse(body) as unknown;
        } catch {
          invalid('provider-json');
        }
        this.circuit.set(operation, { failures: 0, openUntil: 0 });
        this.options.onMetric?.({
          operation,
          outcome: 'success',
          status,
          attempt,
          durationMs: Date.now() - startedAt,
        });
        return parsed;
      } catch (error) {
        const transportOrBodyFailure = !(error instanceof LegacyCommunityExperienceError);
        lastError = transportOrBodyFailure
          ? new LegacyCommunityExperienceError('COMMUNITY_EXPERIENCE_UNAVAILABLE')
          : error;
        this.options.onMetric?.({
          operation,
          outcome: 'failure',
          ...(status === undefined ? {} : { status }),
          attempt,
          durationMs: Date.now() - startedAt,
        });
        const retryable =
          lastError.code === 'COMMUNITY_EXPERIENCE_UNAVAILABLE' &&
          (transportOrBodyFailure || status === undefined || status === 429 || status >= 500);
        if (!retryable || attempt === this.options.maxAttempts) break;
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    if (lastError?.code === 'COMMUNITY_EXPERIENCE_NOT_FOUND') throw lastError;
    const failures = (state?.failures ?? 0) + 1;
    this.circuit.set(operation, {
      failures,
      openUntil:
        failures >= this.options.circuitFailureThreshold
          ? Date.now() + this.options.circuitResetMs
          : 0,
    });
    throw lastError ?? new LegacyCommunityExperienceError('COMMUNITY_EXPERIENCE_UNAVAILABLE');
  }
  private page(
    payload: unknown,
    key: 'posts' | 'messages',
    limit: number,
    value: string | undefined,
    map: (row: RecordValue) => RecordValue,
  ) {
    const sourceRows = record(payload) ? payload[key] : undefined;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      !Array.isArray(sourceRows) ||
      sourceRows.length > maxRows
    )
      invalid('page-shape');
    cursor(value);
    const boundedSourceRows = sourceRows as unknown[];
    const retainedSourceRows = boundedSourceRows.slice(0, limit);
    const oversendTimestamps =
      boundedSourceRows.length > limit
        ? boundedSourceRows.map((row) =>
            requiredDate(
              record(row)
                ? key === 'posts'
                  ? (row.publishedAt ?? row.createdAt)
                  : (row.sentAt ?? row.createdAt)
                : undefined,
              'page-oversend-boundary',
            ),
          )
        : undefined;
    if (
      oversendTimestamps?.some(
        (timestamp, index) =>
          index > 0 && Date.parse(oversendTimestamps[index - 1]!) <= Date.parse(timestamp),
      )
    )
      invalid('page-oversend-order');
    const oversendBeforeTs = oversendTimestamps?.[limit - 1];
    const rows = retainedSourceRows.map((value) => {
      if (!record(value)) invalid('page-row');
      requiredText(value.id ?? value.uuid, 500, 'page-row-id');
      return map(value);
    });
    const hasNextBeforeTs =
      record(payload) && Object.prototype.hasOwnProperty.call(payload, 'nextBeforeTs');
    const rawNextBeforeTs = record(payload) ? payload.nextBeforeTs : undefined;
    const nextBeforeTs = number(rawNextBeforeTs);
    if (hasNextBeforeTs && rawNextBeforeTs !== null && nextBeforeTs === undefined)
      invalid('page-next-before-ts');
    const nextBeforeDate =
      nextBeforeTs !== undefined && nextBeforeTs > 0 && nextBeforeTs <= 8_640_000_000_000_000
        ? new Date(nextBeforeTs)
        : undefined;
    if (
      nextBeforeTs !== undefined &&
      nextBeforeTs !== 0 &&
      (!nextBeforeDate || Number.isNaN(nextBeforeDate.getTime()))
    )
      invalid('page-next-before-ts');
    const nextBeforeIso = oversendBeforeTs ?? nextBeforeDate?.toISOString();
    return {
      items: rows,
      ...(nextBeforeIso
        ? {
            nextCursor: next(nextBeforeIso),
          }
        : {}),
    };
  }
}
function invalid(diagnostic?: string): never {
  throw new LegacyCommunityExperienceError('COMMUNITY_EXPERIENCE_PROVIDER_INVALID', diagnostic);
}
function requiredText(value: unknown, max = 8_000, diagnostic?: string): string {
  return text(value, max) ?? invalid(diagnostic);
}
function requiredDate(value: unknown, diagnostic?: string): string {
  return date(value) ?? invalid(diagnostic);
}
function requiredNumber(value: unknown, diagnostic?: string): number {
  return number(value) ?? invalid(diagnostic);
}
function integer(value: unknown): number | undefined {
  const n = number(value);
  return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
}
function requiredCount(value: unknown, diagnostic?: string): number {
  if (Array.isArray(value)) return value.length;
  return integer(value) ?? invalid(diagnostic);
}
function requiredPositive(value: unknown, diagnostic?: string): number {
  const n = integer(value);
  return n && n > 0 ? n : invalid(diagnostic);
}
function kind(value: unknown, diagnostic?: string): 'PHOTO' | 'GAME' | 'TOURNAMENT' | 'SYSTEM' {
  const v = requiredText(value, 32, diagnostic).toUpperCase();
  return v === 'PHOTO' || v === 'GAME' || v === 'TOURNAMENT' || v === 'SYSTEM'
    ? v
    : invalid(diagnostic);
}
