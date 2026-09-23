/**
 * Server-side client for the legacy LK1 support contour that CUP operators already answer.
 *
 * The browser never talks to this provider: `apps/api` owns the boundary, resolves the caller's
 * own verified phone number and maps provider identifiers to PadlHub ones. Every call is bounded by
 * a timeout and a retry budget and is protected by a circuit breaker; logs and metrics never carry
 * the phone number or the message body.
 */

import { STATION_SUPPORT_MEDIA_MAX_ATTACHMENTS } from './station-support-media.js';

/** The CUP ingest declares one attachment URL up to 8 000 000 characters (an inline base64 image). */
const STATION_SUPPORT_ATTACHMENT_URL_MAX_LENGTH = 8_000_000;

export interface StationSupportProviderDialog {
  readonly dialogId: string;
  readonly stationId: string | null;
  readonly stationName: string;
  readonly status: string;
  readonly updatedAt: string | null;
  readonly updatedTs: number;
  readonly lastMessage: {
    readonly preview: string;
    readonly direction: 'INBOUND' | 'OUTBOUND' | 'SYSTEM';
    readonly authorType: string;
    readonly createdAt: string | null;
    readonly createdTs: number;
  } | null;
}

/**
 * One provider picture. The provider mixes inline base64 with hosted links, so the raw value is
 * carried unchanged and only the route decides which forms are safe to materialize.
 */
export interface StationSupportProviderAttachment {
  readonly type: 'IMAGE';
  readonly url: string;
  readonly name: string | null;
  readonly mimeType: string | null;
  readonly size: number | null;
}

export interface StationSupportProviderMessage {
  readonly messageId: string;
  readonly dialogId: string;
  readonly direction: 'INBOUND' | 'OUTBOUND' | 'SYSTEM';
  readonly authorType: string;
  /** The operator (or client) name the provider stored; the browser shows it as the answer author. */
  readonly senderName: string | null;
  readonly text: string;
  readonly attachments: readonly StationSupportProviderAttachment[];
  readonly createdAt: string | null;
  readonly createdTs: number;
  readonly externalMessageId: string | null;
}

/** The outbound attachment shape the CUP ingest DTO declares. */
export interface StationSupportEventAttachment {
  readonly type: 'IMAGE';
  readonly url: string;
  readonly name?: string;
  readonly mimeType?: string;
  readonly size?: number;
}

export interface StationSupportEventInput {
  readonly phoneDigits: string;
  readonly externalUserId: string;
  readonly externalChatId: string;
  readonly displayName: string;
  readonly text: string;
  readonly stationId: string;
  readonly stationName: string;
  readonly attachments?: readonly StationSupportEventAttachment[];
  readonly externalMessageId: string;
  readonly correlationId: string;
}

export interface StationSupportProvider {
  listDialogs(input: {
    readonly phoneDigits: string;
    readonly correlationId: string;
  }): Promise<readonly StationSupportProviderDialog[]>;
  listMessages(input: {
    readonly dialogId: string;
    readonly limit: number;
    readonly beforeTs: number;
    readonly correlationId: string;
  }): Promise<readonly StationSupportProviderMessage[]>;
  sendEvent(input: StationSupportEventInput): Promise<{
    readonly dialogId: string | null;
  }>;
}

export type StationSupportProviderErrorCode =
  | 'SUPPORT_PROVIDER_UNAVAILABLE'
  | 'SUPPORT_PROVIDER_TIMEOUT'
  | 'SUPPORT_PROVIDER_CIRCUIT_OPEN'
  | 'SUPPORT_PROVIDER_INVALID_RESPONSE'
  /** The provider understood and refused the command; the same request cannot succeed by retrying. */
  | 'SUPPORT_PROVIDER_REJECTED';

export class StationSupportProviderError extends Error {
  public constructor(
    public readonly code: StationSupportProviderErrorCode,
    options?: { readonly cause?: unknown },
  ) {
    super(code, options);
    this.name = 'StationSupportProviderError';
  }
}

export interface StationSupportProviderMetric {
  readonly operation: 'list-dialogs' | 'list-messages' | 'send-event';
  readonly outcome: 'success' | 'failure';
  readonly attempt: number;
  readonly durationMs: number;
  readonly status?: number;
  readonly code?: string;
}

/** The provider keys clients by digits without a leading plus, accepting either 8 or +7 forms. */
export function normalizeSupportPhoneDigits(value: string | null | undefined): string | null {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith('7')) return digits;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A dialog history page is small; an unbounded provider body must never reach the API process. */
const SUPPORT_PROVIDER_MAX_BYTES = 2 * 1024 * 1024;

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('SUPPORT_PROVIDER_BODY_TOO_LARGE');
        throw new StationSupportProviderError('SUPPORT_PROVIDER_INVALID_RESPONSE');
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

/** Provider identifiers are opaque; a numeric legacy id must not collapse to null. */
function identifier(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return text(value);
}

function number(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Math.trunc(Number(value));
  }
  return null;
}

function direction(value: unknown): 'INBOUND' | 'OUTBOUND' | 'SYSTEM' {
  const normalized = text(value)?.toUpperCase();
  if (normalized === 'OUTBOUND' || normalized === 'SYSTEM') return normalized;
  return 'INBOUND';
}

function recordList(payload: unknown, keys: readonly string[]): readonly Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  for (const key of keys) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
}

function normalizeDialog(row: Record<string, unknown>): StationSupportProviderDialog | null {
  const dialogId = identifier(row.id) ?? identifier(row._id);
  if (!dialogId) return null;
  const lastMessageRow = isRecord(row.lastMessage) ? row.lastMessage : null;
  const preview =
    text(lastMessageRow?.preview) ??
    text(lastMessageRow?.textPreview) ??
    text(lastMessageRow?.text) ??
    text(row.lastMessagePreview) ??
    '';
  const lastCreatedTs = number(lastMessageRow?.createdTs) ?? number(row.lastMessageTs) ?? null;
  const lastCreatedAt = text(lastMessageRow?.createdAt) ?? text(row.lastMessageAt);
  return {
    dialogId,
    stationId: identifier(row.stationId),
    stationName: text(row.stationName) ?? 'Без станции',
    status: text(row.status) ?? 'OPEN',
    updatedAt: text(row.updatedAt),
    updatedTs: number(row.updatedTs) ?? lastCreatedTs ?? 0,
    lastMessage:
      preview || lastCreatedTs !== null
        ? {
            preview,
            direction: direction(lastMessageRow?.direction),
            authorType: text(lastMessageRow?.authorType) ?? 'CLIENT',
            createdAt: lastCreatedAt,
            createdTs: lastCreatedTs ?? 0,
          }
        : null,
  };
}

/**
 * The provider stores `attachments` as plain objects and only ever declares `IMAGE`. A value that is
 * neither an inline base64 picture nor a bounded link is kept out of the message instead of being
 * handed to the browser.
 */
function normalizeAttachments(value: unknown): readonly StationSupportProviderAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: StationSupportProviderAttachment[] = [];
  for (const row of value) {
    if (!isRecord(row)) continue;
    const url = text(row.url);
    if (!url || url.length > STATION_SUPPORT_ATTACHMENT_URL_MAX_LENGTH) continue;
    if (text(row.type)?.toUpperCase() !== 'IMAGE') continue;
    if (!/^(?:https?:\/\/|data:image\/)/i.test(url)) continue;
    attachments.push({
      type: 'IMAGE',
      url,
      name: text(row.name)?.slice(0, 240) ?? null,
      mimeType: text(row.mimeType)?.slice(0, 120) ?? null,
      size: number(row.size) ?? null,
    });
    if (attachments.length >= STATION_SUPPORT_MEDIA_MAX_ATTACHMENTS) break;
  }
  return attachments;
}

function normalizeMessage(row: Record<string, unknown>): StationSupportProviderMessage | null {
  const mongoId = isRecord(row._id) ? identifier(row._id.$oid) : null;
  const messageId = identifier(row.id) ?? mongoId;
  const dialogId = text(row.dialogId);
  if (!messageId || !dialogId) return null;
  const createdAt = text(row.createdAt);
  const createdTs =
    number(row.createdTs) ?? number(row.timestamp) ?? (createdAt ? Date.parse(createdAt) : 0);
  const sender = isRecord(row.sender) ? row.sender : null;
  return {
    messageId,
    dialogId,
    direction: direction(row.direction),
    authorType: text(row.authorType) ?? 'CLIENT',
    senderName: (text(row.senderName) ?? text(sender?.name))?.slice(0, 160) ?? null,
    text: text(row.text) ?? text(row.message) ?? text(row.content) ?? '',
    attachments: normalizeAttachments(row.attachments),
    createdAt,
    createdTs: Number.isFinite(createdTs) ? createdTs : 0,
    externalMessageId: text(row.externalMessageId),
  };
}

export class LegacyStationSupportClient implements StationSupportProvider {
  private consecutiveFailures = 0;
  private circuitOpenedAt = 0;

  public constructor(
    private readonly options: {
      readonly baseUrl: string;
      readonly timeoutMs: number;
      readonly maxAttempts: number;
      readonly circuitFailureThreshold: number;
      readonly circuitResetMs: number;
      readonly fetchImplementation?: typeof fetch;
      readonly onMetric?: (metric: StationSupportProviderMetric) => void;
    },
  ) {
    const parsed = new URL(options.baseUrl);
    const localHost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (
      (parsed.protocol !== 'https:' && !localHost) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('SUPPORT_LEGACY_BASE_URL_INVALID');
    }
  }

  public async listDialogs(input: {
    readonly phoneDigits: string;
    readonly correlationId: string;
  }): Promise<readonly StationSupportProviderDialog[]> {
    const query = new URLSearchParams({
      phone: input.phoneDigits,
      channel: 'WEB',
      includeClosed: '1',
    });
    const payload = await this.request({
      operation: 'list-dialogs',
      path: `/dialogs?${query.toString()}`,
      correlationId: input.correlationId,
      retryable: true,
    });
    if (payload === null) {
      throw new StationSupportProviderError('SUPPORT_PROVIDER_INVALID_RESPONSE');
    }
    return recordList(payload, ['dialogs', 'items', 'content', 'data'])
      .map(normalizeDialog)
      .filter((dialog): dialog is StationSupportProviderDialog => dialog !== null);
  }

  public async listMessages(input: {
    readonly dialogId: string;
    readonly limit: number;
    readonly beforeTs: number;
    readonly correlationId: string;
  }): Promise<readonly StationSupportProviderMessage[]> {
    const query = new URLSearchParams({
      limit: String(input.limit),
      beforeTs: String(input.beforeTs),
    });
    const payload = await this.request({
      operation: 'list-messages',
      path: `/dialogs/${encodeURIComponent(input.dialogId)}/messages?${query.toString()}`,
      correlationId: input.correlationId,
      retryable: true,
    });
    if (payload === null) {
      throw new StationSupportProviderError('SUPPORT_PROVIDER_INVALID_RESPONSE');
    }
    return recordList(payload, ['messages', 'items', 'content', 'data'])
      .map(normalizeMessage)
      .filter((message): message is StationSupportProviderMessage => message !== null)
      .sort((left, right) => left.createdTs - right.createdTs);
  }

  public async sendEvent(input: StationSupportEventInput): Promise<{
    readonly dialogId: string | null;
  }> {
    const payload = await this.request({
      operation: 'send-event',
      path: '/dialogs/events',
      method: 'POST',
      correlationId: input.correlationId,
      retryable: false,
      // The event body carries only properties the CUP ingest DTO declares. That DTO is validated
      // with `whitelist: true, forbidNonWhitelisted: true`, so one undeclared property refuses the
      // whole command with HTTP 400: `phoneNumber` was exactly that property (the DTO declares
      // `phone` and `primaryPhone` only), and every station message was rejected before the station
      // was even read. `kind: 'TEXT'` keeps the message an actionable client text: without it the
      // ingest classifies an event that carries a station as `STATION_SELECTION`, which the operator
      // inbox does not treat as a message waiting for an answer. `attachments` is declared as an
      // optional image array, and it is omitted entirely for a text-only message so the existing
      // request stays byte-identical.
      body: {
        connector: 'WEB_LK',
        channel: 'WEB',
        direction: 'INBOUND',
        authorType: 'CLIENT',
        eventType: 'MESSAGE',
        kind: 'TEXT',
        phone: input.phoneDigits,
        primaryPhone: input.phoneDigits,
        externalUserId: input.externalUserId,
        externalChatId: input.externalChatId,
        externalMessageId: input.externalMessageId,
        displayName: input.displayName,
        text: input.text,
        stationId: input.stationId,
        stationName: input.stationName,
        authStatus: 'AUTHORIZED',
        ...(input.attachments && input.attachments.length > 0
          ? { attachments: input.attachments }
          : {}),
      },
    });
    if (payload === null) {
      throw new StationSupportProviderError('SUPPORT_PROVIDER_INVALID_RESPONSE');
    }
    const dialog = isRecord(payload) && isRecord(payload.dialog) ? payload.dialog : null;
    return {
      dialogId: dialog ? (identifier(dialog.id) ?? identifier(dialog._id)) : null,
    };
  }

  private async request(input: {
    readonly operation: StationSupportProviderMetric['operation'];
    readonly path: string;
    readonly method?: 'GET' | 'POST';
    readonly correlationId: string;
    readonly body?: unknown;
    /**
     * Automatic retry is limited to idempotent reads. A write is attempted exactly once: the
     * provider's dedup window is short and unverified, so the route owns replay by reading the
     * message back with the same external identifier instead of risking a duplicate.
     */
    readonly retryable: boolean;
  }): Promise<unknown> {
    if (
      this.circuitOpenedAt > 0 &&
      Date.now() - this.circuitOpenedAt < this.options.circuitResetMs
    ) {
      throw new StationSupportProviderError('SUPPORT_PROVIDER_CIRCUIT_OPEN');
    }
    const fetchImplementation =
      this.options.fetchImplementation ?? ((request, init) => globalThis.fetch(request, init));
    const maxAttempts = input.retryable ? this.options.maxAttempts : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const response = await fetchImplementation(
          new URL(`${this.options.baseUrl}${input.path}`),
          {
            method: input.method ?? 'GET',
            headers: {
              Accept: 'application/json',
              'X-Correlation-ID': input.correlationId,
              ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
            redirect: 'error',
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          this.options.onMetric?.({
            operation: input.operation,
            outcome: 'failure',
            attempt,
            durationMs: Date.now() - startedAt,
            status: response.status,
            code: `SUPPORT_PROVIDER_HTTP_${response.status}`,
          });
          // A 4xx other than 429 is a refused command, not a lost write or an unhealthy provider:
          // it must not consume the retry budget or count towards the shared circuit breaker.
          if (response.status !== 429 && response.status < 500) {
            throw new StationSupportProviderError('SUPPORT_PROVIDER_REJECTED', {
              cause: new Error(`HTTP_${response.status}`),
            });
          }
          lastError = new StationSupportProviderError('SUPPORT_PROVIDER_UNAVAILABLE');
          if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
          }
          continue;
        }
        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > SUPPORT_PROVIDER_MAX_BYTES) {
          throw new StationSupportProviderError('SUPPORT_PROVIDER_INVALID_RESPONSE');
        }
        const body = await readBoundedResponseText(response, SUPPORT_PROVIDER_MAX_BYTES);
        let payload: unknown;
        try {
          payload = JSON.parse(body) as unknown;
        } catch {
          // The SyntaxError message can quote the provider body, which may contain PII, so it is
          // never attached as a cause. The failure is reported once, by the catch below.
          this.options.onMetric?.({
            operation: input.operation,
            outcome: 'failure',
            attempt,
            durationMs: Date.now() - startedAt,
            status: response.status,
            code: 'SUPPORT_PROVIDER_INVALID_RESPONSE',
          });
          throw new StationSupportProviderError('SUPPORT_PROVIDER_INVALID_RESPONSE');
        }
        this.consecutiveFailures = 0;
        this.circuitOpenedAt = 0;
        this.options.onMetric?.({
          operation: input.operation,
          outcome: 'success',
          attempt,
          durationMs: Date.now() - startedAt,
          status: response.status,
        });
        return payload;
      } catch (error) {
        if (error instanceof StationSupportProviderError) {
          // A refused command says nothing about provider health.
          if (error.code !== 'SUPPORT_PROVIDER_REJECTED') this.recordFailure();
          throw error;
        }
        lastError = error;
        const code =
          error instanceof Error && error.name === 'AbortError'
            ? 'SUPPORT_PROVIDER_TIMEOUT'
            : 'SUPPORT_PROVIDER_UNAVAILABLE';
        this.options.onMetric?.({
          operation: input.operation,
          outcome: 'failure',
          attempt,
          durationMs: Date.now() - startedAt,
          code,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    }
    this.recordFailure();
    throw new StationSupportProviderError(
      lastError instanceof Error && lastError.name === 'AbortError'
        ? 'SUPPORT_PROVIDER_TIMEOUT'
        : 'SUPPORT_PROVIDER_UNAVAILABLE',
      { cause: lastError },
    );
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.options.circuitFailureThreshold) {
      this.circuitOpenedAt = Date.now();
    }
  }
}
