import {
  stationMessageReceiptSchema,
  stationMessageRequestSchema,
  type CommunityLegacyBridgeRepository,
  type LegacyCommunityActor,
  type LegacyCommunityToken,
  type StationMessageReceipt,
  type StationMessageRequest,
} from '@phub/communities';

export type StationMessageActor = LegacyCommunityActor & { readonly communityId: string };
export class StationMessageOwnerError extends Error {
  constructor(public readonly status: 403 | 503 = 503) {
    super('STATION_MESSAGE_UNAVAILABLE');
  }
}
export interface StationMessageOwner {
  send(actor: StationMessageActor, request: StationMessageRequest): Promise<StationMessageReceipt>;
  status(actor: StationMessageActor, requestId: string): Promise<StationMessageReceipt>;
}
// Only the authenticated session's stored Viva delegation can identify the LK actor.
// No service token, caller-supplied phone/member or legacy /messages fallback is permitted.
export class StationMessageOwnerClient implements StationMessageOwner {
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
    },
  ) {
    this.base = new URL(options.baseUrl);
    if (
      this.base.protocol !== 'https:' ||
      this.base.username ||
      this.base.password ||
      this.base.pathname !== '/' ||
      this.base.search ||
      this.base.hash
    )
      throw new StationMessageOwnerError();
    this.transport = options.fetchImplementation ?? globalThis.fetch;
  }
  send(actor: StationMessageActor, request: StationMessageRequest) {
    return this.call(actor, stationMessageRequestSchema.parse(request).requestId, request);
  }
  status(actor: StationMessageActor, requestId: string) {
    return this.call(actor, requestId);
  }
  private async call(
    actor: StationMessageActor,
    requestId: string,
    request?: StationMessageRequest,
  ): Promise<StationMessageReceipt> {
    if (
      !actor.tenantKey ||
      !actor.tenantId ||
      !actor.userId ||
      !actor.sessionId ||
      !stationMessageRequestSchema.shape.requestId.safeParse(requestId).success
    )
      throw new StationMessageOwnerError();
    const externalId = await this.options.bridge.getCommunityExternalId?.(
      actor.tenantId,
      actor.communityId,
    );
    if (!externalId || externalId.length > 500 || externalId === '.' || externalId === '..')
      throw new StationMessageOwnerError(403);
    if (Date.now() < this.openUntil) throw new StationMessageOwnerError();
    let token: string;
    try {
      token = await this.options.token(actor);
    } catch {
      throw new StationMessageOwnerError();
    }
    if (!token) throw new StationMessageOwnerError();
    try {
      const path = `/lk/communities/${encodeURIComponent(externalId)}/message-requests${request ? '' : `/${encodeURIComponent(requestId)}`}`;
      const response = await this.transport(new URL(path, this.base), {
        method: request ? 'POST' : 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Correlation-ID': actor.correlationId,
          'X-PadlHub-Community-Message-Contract': 'station-message.v1',
          ...(request ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(request ? { body: JSON.stringify(request) } : {}),
      });
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        await response.body?.cancel();
        throw new StationMessageOwnerError(403);
      }
      // Stream bound protects even responses without Content-Length. Never log response bodies.
      const reader = response.body?.getReader();
      if (!reader) throw new StationMessageOwnerError();
      const decoder = new TextDecoder();
      let body = '';
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 40_000) {
            await reader.cancel();
            throw new StationMessageOwnerError();
          }
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      const parsed = stationMessageReceiptSchema.safeParse(JSON.parse(body) as unknown);
      if (
        !parsed.success ||
        parsed.data.requestId !== requestId ||
        (parsed.data.outcome === 'CONFIRMED' &&
          (response.status !== 200 ||
            (request && parsed.data.message.body !== request.text.trim())))
      )
        throw new StationMessageOwnerError();
      if (parsed.data.outcome === 'UNKNOWN' && parsed.data.code === 'MESSAGE_STORE_UNAVAILABLE') {
        if (++this.failures >= 3) this.openUntil = Date.now() + 10_000;
      } else if (response.status === 200) {
        this.failures = 0;
        this.openUntil = 0;
      }
      return parsed.data;
    } catch (error) {
      if (
        !(error instanceof StationMessageOwnerError && error.status === 403) &&
        ++this.failures >= 3
      )
        this.openUntil = Date.now() + 10_000;
      throw error instanceof StationMessageOwnerError ? error : new StationMessageOwnerError();
    }
  }
}
