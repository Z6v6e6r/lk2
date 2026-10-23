import { registerPlugin } from '@capacitor/core';
import { ApiClientError } from '@phub/api-sdk';
import type { MobileRuntimeConfig } from './runtime-config.js';
import { sanitizedNativeSessionError, sessionFailureDetails } from './session-failure.js';
import { resolveCabinetMedia } from './cabinet-media.js';
import { safeReadHeaders, safeReadShape, type NativeReadEvent } from './native-read-observation.js';

export interface AndroidSessionPlugin {
  configuration(): Promise<MobileRuntimeConfig>;
  /** Fixed native capability; no provider credential or payload crosses this bridge. */
  refreshUpcomingBookings?(): Promise<{
    readonly state: 'refreshed';
    readonly milestones?: readonly ['JOB_ACCEPTED', 'RELAY_ACCEPTED', 'COMPLETED'];
  }>;
  cancelUpcomingBookingsRefresh?(): Promise<{ readonly state: 'cancelled' }>;
  request(input: {
    readonly path: string;
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
    /** Internal bridge representation for the one reviewed raw-byte relay route. */
    readonly bodyBase64?: string;
  }): Promise<{
    readonly status: number;
    /** Native provenance, independent of server response headers. Absent on older APKs. */
    readonly source?: 'network' | 'local';
    readonly headers: Record<string, string>;
    /** Base64; Set-Cookie is consumed only by the native session engine. */
    readonly body: string;
    /** Native cache metadata, never read from server-supplied headers. */
    readonly cache?: { readonly state: 'fresh-cache' | 'stale'; readonly savedAt: number };
  }>;
}

export type NativeApiFetch = typeof fetch & {
  /** Retire reads immediately on logout, before slower push cleanup starts. */
  cancelUpcomingBookingsRefresh(): Promise<void>;
};

export const androidSessionPlugin = registerPlugin<AndroidSessionPlugin>('PadlHubAndroidSession');

export interface NativeCacheObservation {
  readonly path: string;
  readonly state: 'fresh-cache' | 'stale' | 'live' | 'unavailable';
  readonly savedAt?: number;
  /** The shared App retains loaded screen state on errors; discard it after a failed read. */
  readonly invalidate?: boolean;
}

export interface NativeReadFailure {
  readonly status?: number;
  /** Reviewed constants only; never a server/native message. */
  readonly code: string;
  readonly correlationId?: string;
}

export interface NativeReadObservation {
  readonly section: 'profile' | 'bookings';
  readonly failure: NativeReadFailure | null;
  /** Last bounded trace, in memory only. Pending observations do not clear errors. */
  readonly trace?: readonly NativeReadEvent[];
  readonly complete?: boolean;
  readonly path?: '/profile' | '/bookings/upcoming';
}

const readErrorCodes = new Set([
  'AUTH_REQUIRED',
  'AUTH_SESSION_REVOKED',
  'AUTH_SESSION_CHECK_UNAVAILABLE',
  'TENANT_CONTEXT_UNAVAILABLE',
  'TENANT_KEY_INVALID',
  'TENANT_NOT_FOUND',
  'TENANT_ACCESS_DENIED',
  'PROFILE_PROJECTION_INVALID',
  'PROFILE_PROJECTION_STALE',
  'BOOKINGS_PROJECTION_INVALID',
  'BOOKINGS_PROJECTION_STALE',
]);
const correlationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readFailureCode(
  status: number,
  bytes: Uint8Array,
  section: NativeReadObservation['section'],
): string | null {
  const failed = Number.isInteger(status) && status >= 300 && status <= 599;
  if (!failed && !(status === 200 && section === 'bookings')) return null;
  // Only small error envelopes or an explicit unavailable state are inspected.
  let payload: unknown;
  if (bytes.byteLength <= 4096) {
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      // HTTP status remains useful without retaining malformed response data.
    }
  }
  if (typeof payload === 'object' && payload !== null) {
    if (!failed && 'state' in payload && payload.state === 'UNAVAILABLE')
      return 'BOOKINGS_UNAVAILABLE';
    if (failed && 'code' in payload && typeof payload.code === 'string')
      return readErrorCodes.has(payload.code) ? payload.code : 'HTTP_ERROR';
  }
  return failed ? 'HTTP_ERROR' : null;
}

function rejected(): ApiClientError {
  return new ApiClientError('Запрос недоступен.', 403, 'NATIVE_REQUEST_REJECTED', 'native');
}

function needsBookingsRefresh(
  result: Awaited<ReturnType<AndroidSessionPlugin['request']>>,
): boolean {
  if (result.status !== 200 && result.status !== 503) return false;
  // This is the already-normalized PadlHub response, never a provider payload.
  if (result.body.length > Math.ceil((1024 * 1024 * 4) / 3)) return false;
  try {
    const binary = atob(result.body);
    if (binary.length > 1024 * 1024) return false;
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (typeof value !== 'object' || value === null) return false;
    if (result.status === 503) return 'code' in value && value.code === 'BOOKINGS_PROJECTION_STALE';
    if ('state' in value && value.state === 'UNAVAILABLE') return true;
    return (
      'state' in value &&
      value.state === 'READY' &&
      'staleAt' in value &&
      typeof value.staleAt === 'string' &&
      Number.isFinite(Date.parse(value.staleAt)) &&
      Date.parse(value.staleAt) <= Date.now()
    );
  } catch {
    return false;
  }
}

const MAX_RELAY_BYTES = 15 * 1024 * 1024;
const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

function isBinaryRelay(path: string, method: string): boolean {
  return method === 'PUT' && new RegExp(`/conversations/${uuid}/media/${uuid}/bytes$`).test(path);
}

function isBinaryBody(value: unknown): value is Blob | Uint8Array | ArrayBuffer {
  return value instanceof Blob || value instanceof Uint8Array || value instanceof ArrayBuffer;
}

async function binaryBase64(value: Blob | Uint8Array | ArrayBuffer): Promise<string> {
  const bytes =
    value instanceof Blob
      ? new Uint8Array(await value.arrayBuffer())
      : value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_RELAY_BYTES) throw rejected();
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)),
    );
  }
  return btoa(binary);
}

/** Native HTTPS + Keystore custody; there is deliberately no browser-fetch fallback. */
export function createNativeApiFetch(
  config: MobileRuntimeConfig,
  plugin: AndroidSessionPlugin = androidSessionPlugin,
  onSessionExpired?: () => void,
  onCacheObservation?: (observation: NativeCacheObservation) => void,
  onReadObservation?: (observation: NativeReadObservation) => void,
): NativeApiFetch {
  let active = false;
  let generation = 0;
  const displayedReads = new Set<string>();
  const readSequence = { profile: 0, bookings: 0 };
  let bookingsRefresh:
    | {
        generation: number;
        promise: Promise<readonly ['JOB_ACCEPTED', 'RELAY_ACCEPTED', 'COMPLETED'] | undefined>;
      }
    | undefined;
  const cancelUpcomingBookingsRefresh = async (): Promise<void> => {
    generation += 1;
    readSequence.bookings += 1;
    for (const section of ['profile', 'bookings'] as const) {
      try {
        onReadObservation?.({
          section,
          failure: null,
          trace: [],
          complete: true,
          path: section === 'profile' ? '/profile' : '/bookings/upcoming',
        });
      } catch {
        /* Diagnostics never delay cancellation. */
      }
    }
    if (!plugin.cancelUpcomingBookingsRefresh) return;
    const result = await plugin.cancelUpcomingBookingsRefresh();
    if (result.state !== 'cancelled' || Object.keys(result).length !== 1) throw rejected();
  };
  const implementation: typeof fetch = async (input, init) => {
    const value = typeof input === 'string' ? input : input instanceof URL ? input.href : '';
    const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}/`;
    // Check before URL normalization, which would hide traversal or encoded delimiters.
    if (!value.startsWith(root) || /[%#\\]|\.\./.test(value.split('?')[0] ?? '')) throw rejected();
    const url = new URL(value);
    if (url.origin !== config.apiBaseUrl || url.username || url.password || url.hash)
      throw rejected();
    const method = init?.method ?? 'GET';
    const relay = isBinaryRelay(url.pathname, method);
    const body = init?.body;
    if (body != null && typeof body !== 'string' && (!relay || !isBinaryBody(body)))
      throw rejected();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    if ('cookie' in headers || 'set-cookie' in headers || 'origin' in headers) throw rejected();
    if (init?.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
    const refresh = url.pathname.endsWith('/auth/session/refresh');
    if (method === 'DELETE' && url.pathname.endsWith('/auth/session')) {
      active = false;
      generation += 1;
      displayedReads.clear();
    }
    const requestGeneration = generation;
    const section =
      !onReadObservation || method !== 'GET'
        ? undefined
        : value === root + 'profile'
          ? 'profile'
          : value === root + 'bookings/upcoming'
            ? 'bookings'
            : undefined;
    const sequence = section ? ++readSequence[section] : 0;
    const requestCorrelation = headers['x-correlation-id'];
    const trace: NativeReadEvent[] = [];
    let stage: NativeReadEvent['stage'] = 'initial-get';
    const currentRead = (): boolean =>
      Boolean(
        section &&
        requestGeneration === generation &&
        readSequence[section] === sequence &&
        !init?.signal?.aborted,
      );
    const observeRead = (failure: NativeReadFailure | null, complete = true): void => {
      if (
        !section ||
        requestGeneration !== generation ||
        sequence !== readSequence[section] ||
        init?.signal?.aborted
      )
        return;
      try {
        onReadObservation?.({
          section,
          failure,
          trace: trace.length <= 5 ? [...trace] : [trace[0]!, ...trace.slice(-4)],
          complete,
          path: section === 'profile' ? '/profile' : '/bookings/upcoming',
        });
      } catch {
        // Diagnostics must not change the response, session or retry policy.
      }
    };
    const recordHttp = (result: Awaited<ReturnType<AndroidSessionPlugin['request']>>): void => {
      if (!currentRead() || !section) return;
      const returnedCorrelations = Object.entries(result.headers).filter(
        ([name]) => name.toLowerCase() === 'x-correlation-id',
      );
      const responseCorrelation =
        returnedCorrelations.length === 0
          ? null
          : returnedCorrelations.length === 1 && typeof returnedCorrelations[0]?.[1] === 'string'
            ? returnedCorrelations[0][1]
            : '';
      const correlationId =
        requestCorrelation &&
        correlationPattern.test(requestCorrelation) &&
        (responseCorrelation === null ||
          (correlationPattern.test(responseCorrelation) &&
            responseCorrelation.toLowerCase() === requestCorrelation.toLowerCase()))
          ? requestCorrelation.toLowerCase()
          : undefined;
      let code: string | null = null;
      if (result.body.length <= 5464) {
        try {
          code = readFailureCode(
            result.status,
            Uint8Array.from(atob(result.body), (character) => character.charCodeAt(0)),
            section,
          );
        } catch {
          /* Never affect transport because metadata cannot be decoded. */
        }
      }
      trace.push({
        stage,
        observedAt: new Date().toISOString(),
        source:
          result.cache?.state === 'stale'
            ? 'stale-cache'
            : result.cache?.state === 'fresh-cache'
              ? 'fresh-cache'
              : result.source === 'network'
                ? 'network'
                : result.source === 'local'
                  ? 'local'
                  : 'unknown',
        outcome: result.cache
          ? 'cached-response'
          : result.source === 'network'
            ? 'http'
            : result.source === 'local'
              ? 'local-response'
              : 'response',
        status: result.status,
        headers: safeReadHeaders(result.headers),
        ...safeReadShape(result.body, section),
        ...(code ? { code } : {}),
        ...(correlationId ? { correlationId } : {}),
      });
      observeRead(null, false);
    };
    const cacheRead = method === 'GET' && [root + 'home/base', root + 'locations'].includes(value);
    const unavailable = (): void => {
      if (!cacheRead || requestGeneration !== generation) return;
      const invalidate = displayedReads.has(url.pathname);
      if (invalidate) {
        displayedReads.clear();
        generation += 1;
      }
      onCacheObservation?.({ path: url.pathname, state: 'unavailable', invalidate });
    };
    try {
      const binary =
        body != null && typeof body !== 'string' ? await binaryBase64(body) : undefined;
      if (init?.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
      const nativeRequest = {
        path: url.pathname + url.search,
        method,
        headers,
        ...(typeof body === 'string' ? { body } : {}),
        ...(binary === undefined ? {} : { bodyBase64: binary }),
      };
      let result = await plugin.request(nativeRequest);
      recordHttp(result);
      if (
        method === 'GET' &&
        value === root + 'bookings/upcoming' &&
        body == null &&
        plugin.refreshUpcomingBookings &&
        needsBookingsRefresh(result)
      ) {
        const requireCurrent = (): void => {
          if (requestGeneration !== generation || init?.signal?.aborted)
            throw new DOMException('Request aborted', 'AbortError');
        };
        requireCurrent();
        if (!bookingsRefresh || bookingsRefresh.generation !== requestGeneration) {
          const pending = plugin.refreshUpcomingBookings().then((ack) => {
            if (
              ack.state !== 'refreshed' ||
              Object.keys(ack).some((key) => !['state', 'milestones'].includes(key))
            )
              throw rejected();
            if (
              ack.milestones !== undefined &&
              (!Array.isArray(ack.milestones) ||
                ack.milestones.length !== 3 ||
                Object.keys(ack.milestones).length !== 3 ||
                ['JOB_ACCEPTED', 'RELAY_ACCEPTED', 'COMPLETED'].some(
                  (milestone, index) => ack.milestones![index] !== milestone,
                ))
            )
              throw rejected();
            return ack.milestones;
          });
          const entry = { generation: requestGeneration, promise: pending };
          bookingsRefresh = entry;
          entry.promise = pending.finally(() => {
            if (bookingsRefresh === entry) bookingsRefresh = undefined;
          });
        }
        const abortRefresh = (): void => {
          void cancelUpcomingBookingsRefresh().catch(() => undefined);
        };
        init?.signal?.addEventListener('abort', abortRefresh, { once: true });
        try {
          stage = 'native-refresh';
          const milestones = await bookingsRefresh.promise;
          requireCurrent();
          if (currentRead()) {
            const acknowledged: NativeReadEvent['stage'][] = milestones
              ? ['job', 'relay-results', 'complete']
              : ['native-refresh'];
            for (const acknowledgedStage of acknowledged)
              trace.push({
                stage: acknowledgedStage,
                observedAt: new Date().toISOString(),
                source: 'native-ack',
                outcome: 'acknowledged',
              });
            observeRead(null, false);
          }
          stage = 'final-get';
          // Success means a fresh ordinary PadlHub read, never a locally constructed DTO.
          result = await plugin.request(nativeRequest);
          requireCurrent();
          recordHttp(result);
        } finally {
          init?.signal?.removeEventListener('abort', abortRefresh);
        }
      }
      if (init?.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
      if (result.status === 200 && (refresh || url.pathname.endsWith('/verify'))) active = true;
      if (result.status === 401 && refresh && active) {
        active = false;
        generation += 1;
        onSessionExpired?.();
      }
      if (requestGeneration === generation && cacheRead) {
        if (result.status === 200) {
          displayedReads.add(url.pathname);
          onCacheObservation?.({
            path: url.pathname,
            state: result.cache?.state ?? 'live',
            ...(result.cache ? { savedAt: result.cache.savedAt } : {}),
          });
        } else {
          unavailable();
        }
      }
      const safeHeaders = Object.fromEntries(
        Object.entries(result.headers).filter(([name]) =>
          ['content-type', 'x-correlation-id', 'retry-after'].includes(name.toLowerCase()),
        ),
      );
      // The added header cannot make an otherwise valid response fail or carry arbitrary text.
      const cacheControl = safeReadHeaders(result.headers).cacheControl;
      if (cacheControl !== 'ABSENT' && cacheControl !== 'OTHER')
        safeHeaders['cache-control'] = cacheControl;
      const bytes = Uint8Array.from(atob(result.body), (character) => character.charCodeAt(0));
      const response = new Response(result.status === 204 ? null : bytes, {
        status: result.status,
        headers: safeHeaders,
      });
      if (section) {
        const code = readFailureCode(result.status, bytes, section);
        const returnedCorrelation = response.headers.get('x-correlation-id');
        const correlationId =
          requestCorrelation &&
          correlationPattern.test(requestCorrelation) &&
          (returnedCorrelation === null ||
            (correlationPattern.test(returnedCorrelation) &&
              returnedCorrelation.toLowerCase() === requestCorrelation.toLowerCase()))
            ? requestCorrelation.toLowerCase()
            : undefined;
        observeRead(
          code
            ? { status: result.status, code, ...(correlationId ? { correlationId } : {}) }
            : null,
        );
      }
      if (
        method === 'GET' &&
        result.status === 200 &&
        response.headers.get('content-type')?.split(';')[0]?.trim() === 'application/json'
      ) {
        // Native transport owns credentials; public media loads use the same API origin
        // without sending them through an image URL or a provider fallback.
        const payload: unknown = await response
          .clone()
          .json()
          .catch(() => undefined);
        if (payload !== undefined) {
          return new Response(JSON.stringify(resolveCabinetMedia(payload, config.apiBaseUrl)), {
            status: result.status,
            headers: safeHeaders,
          });
        }
      }
      return response;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      unavailable();
      const sanitized = sanitizedNativeSessionError(error);
      const correlationId =
        requestCorrelation && correlationPattern.test(requestCorrelation)
          ? requestCorrelation.toLowerCase()
          : undefined;
      if (currentRead())
        trace.push({
          stage,
          observedAt: new Date().toISOString(),
          source: 'unknown',
          outcome:
            sessionFailureDetails(sanitized).code === 'NATIVE_NETWORK_UNAVAILABLE'
              ? 'transport-error'
              : 'native-error',
          code: sessionFailureDetails(sanitized).code,
          ...(correlationId ? { correlationId } : {}),
        });
      observeRead({
        code: sessionFailureDetails(sanitized).code,
        ...(correlationId ? { correlationId } : {}),
      });
      throw sanitized;
    }
  };
  return Object.assign(implementation, { cancelUpcomingBookingsRefresh });
}
