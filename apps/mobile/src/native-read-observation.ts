/** Metadata for the two ordinary reads. No body values or arbitrary header/key text. */
export interface NativeReadEvent {
  readonly stage:
    'initial-get' | 'native-refresh' | 'job' | 'relay-results' | 'complete' | 'final-get';
  /** Local receipt time; never the server's time or the native stage execution time. */
  readonly observedAt: string;
  readonly source: 'network' | 'local' | 'fresh-cache' | 'stale-cache' | 'native-ack' | 'unknown';
  readonly outcome:
    | 'http'
    | 'response'
    | 'local-response'
    | 'cached-response'
    | 'transport-error'
    | 'native-error'
    | 'acknowledged';
  readonly status?: number;
  readonly code?: string;
  readonly correlationId?: string;
  readonly headers?: {
    readonly contentType: 'ABSENT' | 'OTHER' | 'application/json' | 'text/plain';
    readonly cacheControl:
      | 'ABSENT'
      | 'OTHER'
      | 'private, no-store'
      | 'private, max-age=0, stale-while-revalidate=45'
      | 'private, max-age=15, stale-while-revalidate=45';
    readonly retryAfter: string;
  };
  readonly shape?: 'object' | 'array' | 'scalar' | 'invalid' | 'not-inspected';
  readonly fields?: readonly string[];
}

const fields = {
  profile: new Set([
    'userId',
    'displayName',
    'firstName',
    'lastName',
    'phoneLast4',
    'avatarUrl',
    'balanceMinor',
    'currency',
    'level',
    'code',
    'message',
    'correlationId',
  ]),
  bookings: new Set([
    'state',
    'version',
    'generatedAt',
    'staleAt',
    'items',
    'code',
    'message',
    'correlationId',
  ]),
};
const cachePolicies = new Set([
  'private, no-store',
  'private, max-age=0, stale-while-revalidate=45',
  'private, max-age=15, stale-while-revalidate=45',
]);

function header(headers: Record<string, string>, name: string): string | undefined {
  const entries = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
  if (entries.length === 0) return undefined;
  if (entries.length !== 1 || typeof entries[0]?.[1] !== 'string') return '';
  const value = entries[0][1];
  return value.length <= 128 && !/[\r\n\0]/.test(value) ? value : '';
}

export function safeReadHeaders(
  headers: Record<string, string>,
): NonNullable<NativeReadEvent['headers']> {
  const type = header(headers, 'content-type');
  const contentType =
    type === undefined
      ? 'ABSENT'
      : /^(application\/json|text\/plain)(?:;\s*charset=utf-8)?$/i.test(type.trim())
        ? (type.split(';')[0]!.trim().toLowerCase() as 'application/json' | 'text/plain')
        : 'OTHER';
  const cache = header(headers, 'cache-control');
  const normalizedCache = cache
    ?.toLowerCase()
    .split(',')
    .map((value) => value.trim())
    .join(', ');
  const cacheControl =
    cache === undefined
      ? 'ABSENT'
      : cachePolicies.has(normalizedCache!)
        ? (normalizedCache as NonNullable<NativeReadEvent['headers']>['cacheControl'])
        : 'OTHER';
  const retry = header(headers, 'retry-after');
  let retryAfter = retry === undefined ? 'ABSENT' : 'OTHER';
  if (retry && /^(0|[1-9][0-9]{0,4})$/.test(retry) && Number(retry) <= 86400)
    retryAfter = `${Number(retry)} seconds`;
  else if (
    retry &&
    /^[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(retry)
  ) {
    const date = new Date(retry);
    if (
      Number.isFinite(date.getTime()) &&
      date.toUTCString() === retry &&
      date.getUTCFullYear() >= 2000 &&
      date.getUTCFullYear() <= 2100
    )
      retryAfter = date.toISOString();
  }
  return { contentType, cacheControl, retryAfter };
}

export function safeReadShape(
  body: string,
  section: 'profile' | 'bookings',
): Pick<NativeReadEvent, 'shape' | 'fields'> {
  if (body.length > 1_398_104) return { shape: 'not-inspected', fields: [] };
  try {
    const bytes = Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
    if (bytes.length > 1024 * 1024) return { shape: 'not-inspected', fields: [] };
    const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (Array.isArray(payload)) return { shape: 'array', fields: [] };
    if (typeof payload !== 'object' || payload === null) return { shape: 'scalar', fields: [] };
    return {
      shape: 'object',
      fields: Object.keys(payload)
        .filter((key) => fields[section].has(key))
        .sort()
        .slice(0, 16),
    };
  } catch {
    return { shape: 'invalid', fields: [] };
  }
}
