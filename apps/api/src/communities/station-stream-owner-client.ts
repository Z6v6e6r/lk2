import { z } from 'zod';
import {
  stationStreamUuid,
  stationStreamStateShape,
  stationStreamStateValid,
  stationStreamPageSchema,
  stationStreamSummariesSchema,
  stationReadRequestSchema,
  stationReadReceiptSchema,
  type CommunityLegacyBridgeRepository,
  type LegacyCommunityActor,
  type LegacyCommunityToken,
  type StationStreamPage,
  type StationStreamSummaries,
  type StationReadRequest,
  type StationReadReceipt,
} from '@phub/communities';
import {
  stationStreamCursor,
  stationStreamPage,
  stationStreamQuery,
} from './station-stream-page.js';

export type StationStreamActor = LegacyCommunityActor;
type CommunityActor = StationStreamActor & { readonly communityId: string };
type Operation = 'history' | 'summaries' | 'read' | 'read-status';
export interface StationStreamMetric {
  readonly operation: Operation;
  readonly outcome: 'success' | 'failure';
  readonly durationMs: number;
  readonly status?: number;
}
export class StationStreamOwnerError extends Error {
  constructor(readonly status: 403 | 503 = 503) {
    super('STATION_STREAM_UNAVAILABLE');
  }
}
export interface StationStreamOwner {
  history(actor: CommunityActor, limit: number, cursor?: string): Promise<StationStreamPage>;
  summaries(
    actor: StationStreamActor,
    communityIds: readonly string[],
  ): Promise<StationStreamSummaries>;
  read(actor: CommunityActor, request: StationReadRequest): Promise<StationReadReceipt>;
  readStatus(actor: CommunityActor, requestId: string): Promise<StationReadReceipt>;
}
const privateId = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (v) =>
      v !== '.' &&
      v !== '..' &&
      [...v].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
  );
const privateSummary = z
  .object({
    contractVersion: z.literal(1),
    contract: z.literal('station-stream-summaries'),
    items: z
      .array(
        z.discriminatedUnion('availability', [
          z
            .object({
              communityId: privateId,
              availability: z.literal('AVAILABLE'),
              ...stationStreamStateShape,
            })
            .strict()
            .refine(stationStreamStateValid),
          z.object({ communityId: privateId, availability: z.literal('UNADOPTED') }).strict(),
          z.object({ communityId: privateId, availability: z.literal('NOT_STATION') }).strict(),
        ]),
      )
      .min(1)
      .max(50),
  })
  .strict();
const phone = (value: string | undefined) => {
  const digits = value?.replace(/\D/g, '');
  if (!digits) return undefined;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`;
  return digits.length >= 11 ? digits : undefined;
};
/** Concrete v3 consumer; existing verified actor delegation only, no service-token fallback. */
export class StationStreamOwnerClient implements StationStreamOwner {
  private readonly base: URL;
  private readonly transport: typeof fetch;
  private failures = 0;
  private openUntil = 0;
  constructor(
    private readonly options: {
      readonly baseUrl: string;
      readonly timeoutMs: number;
      readonly token: LegacyCommunityToken;
      readonly bridge: CommunityLegacyBridgeRepository;
      readonly fetchImplementation?: typeof fetch;
      readonly onMetric?: (metric: StationStreamMetric) => void;
    },
  ) {
    this.base = new URL(options.baseUrl);
    if (
      this.base.protocol !== 'https:' ||
      this.base.username ||
      this.base.password ||
      this.base.pathname !== '/' ||
      this.base.search ||
      this.base.hash ||
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 1
    )
      throw new StationStreamOwnerError();
    this.transport = options.fetchImplementation ?? globalThis.fetch;
  }
  private validateActor(actor: StationStreamActor) {
    if (
      !stationStreamUuid.safeParse(actor.tenantId).success ||
      !stationStreamUuid.safeParse(actor.userId).success ||
      !actor.tenantKey ||
      !actor.sessionId ||
      !actor.correlationId
    )
      throw new StationStreamOwnerError(403);
  }
  private async mappings(actor: StationStreamActor, ids: readonly string[]) {
    this.validateActor(actor);
    if (
      ids.length < 1 ||
      ids.length > 50 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !stationStreamUuid.safeParse(id).success)
    )
      throw new StationStreamOwnerError(403);
    const result = await this.options.bridge.getCommunityExternalIds?.(actor.tenantId, ids);
    if (
      !result ||
      result.size !== ids.length ||
      ids.some((id) => !privateId.safeParse(result.get(id)).success) ||
      new Set(result.values()).size !== result.size
    )
      throw new StationStreamOwnerError(403);
    return result;
  }
  async history(
    actor: CommunityActor,
    limit: number,
    encoded?: string,
  ): Promise<StationStreamPage> {
    const cursor = stationStreamCursor(encoded, actor),
      query = stationStreamQuery(limit, cursor);
    const mapping = await this.mappings(actor, [actor.communityId]);
    const identity = await this.options.bridge.getViewerIdentity(actor.tenantId, actor.userId);
    if (!identity.clientId && !identity.phoneE164) throw new StationStreamOwnerError(403);
    return this.call(
      actor,
      'history',
      `/lk/communities/${encodeURIComponent(mapping.get(actor.communityId)!)}/messages?${query}`,
      undefined,
      (payload) => {
        const parsed = stationStreamPage(payload, limit, actor, cursor),
          page = parsed.page;
        return stationStreamPageSchema.parse({
          historyVersion: 3,
          mode: page.mode,
          streamId: page.streamId,
          membershipEpoch: page.membershipEpoch,
          baselineSequence: page.baselineSequence,
          readThroughSequence: page.readThroughSequence,
          publishedThroughSequence: page.publishedThroughSequence,
          unreadCount: page.unreadCount,
          ...(page.mode === 'STREAM'
            ? { afterSequence: page.afterSequence, throughSequence: page.throughSequence }
            : {}),
          items: page.messages.map((row) => ({
            id: row.publicId,
            body: row.text,
            sentAt: row.createdAt,
            sequence: row.sequence,
            author: { displayName: row.authorName },
            isViewer:
              row.authorId && identity.clientId
                ? row.authorId === identity.clientId
                : Boolean(
                    phone(row.authorPhone) && phone(row.authorPhone) === phone(identity.phoneE164),
                  ),
          })),
          nextCursor: parsed.nextCursor,
          catchUpCursor: parsed.catchUpCursor,
          olderCursor: parsed.olderCursor,
          archiveCursor: parsed.archiveCursor,
          canRequestStationMessage: true,
        });
      },
    );
  }
  async summaries(
    actor: StationStreamActor,
    ids: readonly string[],
  ): Promise<StationStreamSummaries> {
    const mapping = await this.mappings(actor, ids),
      reverse = new Map([...mapping].map(([id, external]) => [external, id]));
    return this.call(
      actor,
      'summaries',
      '/lk/communities/station-stream-summaries',
      { communityIds: ids.map((id) => mapping.get(id)!) },
      (payload) => {
        const parsed = privateSummary.parse(payload);
        if (
          parsed.items.length !== ids.length ||
          new Set(parsed.items.map((v) => v.communityId)).size !== ids.length ||
          parsed.items.some((v) => !reverse.has(v.communityId))
        )
          throw new StationStreamOwnerError();
        return stationStreamSummariesSchema.parse({
          ...parsed,
          items: parsed.items.map((item) => ({
            ...item,
            communityId: reverse.get(item.communityId)!,
          })),
        });
      },
    );
  }
  async read(actor: CommunityActor, input: StationReadRequest): Promise<StationReadReceipt> {
    const original = stationReadRequestSchema.parse(input);
    return this.receipt(actor, original.requestId, original);
  }
  async readStatus(actor: CommunityActor, requestId: string): Promise<StationReadReceipt> {
    return this.receipt(actor, stationStreamUuid.parse(requestId));
  }
  private async receipt(actor: CommunityActor, requestId: string, input?: StationReadRequest) {
    const mapping = await this.mappings(actor, [actor.communityId]);
    return this.call(
      actor,
      input ? 'read' : 'read-status',
      `/lk/communities/${encodeURIComponent(mapping.get(actor.communityId)!)}/message-read-requests${input ? '' : `/${requestId}`}`,
      input,
      (payload) => {
        const receipt = stationReadReceiptSchema.parse(payload);
        if (
          receipt.requestId !== requestId ||
          (input &&
            receipt.outcome === 'CONFIRMED' &&
            (receipt.streamId !== input.streamId ||
              receipt.membershipEpoch !== input.membershipEpoch ||
              receipt.throughSequence !== input.throughSequence))
        )
          throw new StationStreamOwnerError();
        return receipt;
      },
    );
  }
  private metric(value: StationStreamMetric) {
    try {
      this.options.onMetric?.(value);
    } catch {
      /* Observability cannot change custody. */
    }
  }
  private async call<T>(
    actor: StationStreamActor,
    operation: Operation,
    path: string,
    body: unknown,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const started = Date.now();
    let status: number | undefined;
    let dependencyAttempted = false;
    try {
      this.validateActor(actor);
      if (Date.now() < this.openUntil) throw new StationStreamOwnerError();
      const token = await this.options.token(actor);
      if (!token || /[\r\n]/.test(token)) throw new StationStreamOwnerError();
      const destination = new URL(path, this.base);
      dependencyAttempted = true;
      const response = await this.transport(destination, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Correlation-ID': actor.correlationId,
          ...(operation === 'summaries'
            ? { 'X-PadlHub-Community-Stream-Contract': 'station-stream.v1' }
            : {}),
          ...(operation === 'read' || operation === 'read-status'
            ? { 'X-PadlHub-Community-Read-Contract': 'station-read.v1' }
            : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      status = response.status;
      if (response.redirected || (response.url && response.url !== destination.href))
        throw new StationStreamOwnerError();
      const readOutcome =
        (operation === 'read' || operation === 'read-status') &&
        [200, 400, 401, 403, 409, 503].includes(status);
      if (!readOutcome && [401, 403, 404].includes(status)) {
        await response.body?.cancel();
        throw new StationStreamOwnerError(403);
      }
      if (status !== 200 && !readOutcome) {
        await response.body?.cancel();
        throw new StationStreamOwnerError();
      }
      const reader = response.body?.getReader();
      if (!reader) throw new StationStreamOwnerError();
      let bytes = 0,
        text = '';
      const decoder = new TextDecoder('utf-8', { fatal: true });
      try {
        while (true) {
          const value = await reader.read();
          if (value.done) break;
          bytes += value.value.byteLength;
          if (bytes > (operation === 'history' ? 3 * 1024 * 1024 : 2_000_000)) {
            await reader.cancel();
            throw new StationStreamOwnerError();
          }
          text += decoder.decode(value.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      const payload: unknown = JSON.parse(text);
      if (
        status !== 200 &&
        (!payload ||
          typeof payload !== 'object' ||
          !('outcome' in payload) ||
          payload.outcome !== 'UNKNOWN')
      )
        throw new StationStreamOwnerError();
      const result = parse(payload);
      if (status >= 500) {
        if (++this.failures >= 3) this.openUntil = Date.now() + 10_000;
      } else if (status !== 401 && status !== 403) {
        this.failures = 0;
        this.openUntil = 0;
      }
      this.metric({
        operation,
        outcome: status >= 400 ? 'failure' : 'success',
        durationMs: Date.now() - started,
        status,
      });
      return result;
    } catch (error) {
      if (
        dependencyAttempted &&
        status !== 401 &&
        status !== 403 &&
        !(error instanceof StationStreamOwnerError && error.status === 403) &&
        ++this.failures >= 3
      )
        this.openUntil = Date.now() + 10_000;
      this.metric({
        operation,
        outcome: 'failure',
        durationMs: Date.now() - started,
        ...(status === undefined ? {} : { status }),
      });
      throw error instanceof StationStreamOwnerError ? error : new StationStreamOwnerError();
    }
  }
}
