const AUTH_CONTINUATION_STORAGE_KEY = 'phub.pushOptIn.authContinuation.v1';
const AUTH_CONTINUATION_TTL_MS = 20 * 60 * 1000;
const PUSH_OPT_IN_PATH = '/push';
const COMMUNITY_RETURN_PREFIXES = ['https://padlhub.ru/', 'https://padlhub.su/lk/'] as const;
const ATTRIBUTION_SOURCE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;

function sessionStorageOrNull(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Returns the community URL only when it is one of the fixed PadlHub destinations.
 * The push opt-in page is the only writer of this value, so an arbitrary redirect
 * must never be accepted, including protocol-relative or credential-bearing URLs.
 */
export function safeCommunityReturnTo(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw || raw.length > 2_000) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (!COMMUNITY_RETURN_PREFIXES.some((prefix) => raw.startsWith(prefix))) return null;
    if (url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export interface PushAttribution {
  readonly source?: string;
  readonly community?: string;
}

function safeAttributionValue(value: string | null, maxLength: number): string | undefined {
  const normalized = (value ?? '').trim();
  if (!normalized || normalized.length > maxLength) return undefined;
  if (
    [...normalized].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  )
    return undefined;
  return normalized;
}

/**
 * Reads the bounded community markers from the LK1 hand-off. They are presentation/analytics
 * attribution only; no authority is derived from them on the client.
 */
export function readPushAttribution(search: string): PushAttribution {
  const params = new URLSearchParams(search);
  const source = safeAttributionValue(params.get('source'), 80);
  const community = safeAttributionValue(params.get('community'), 200);
  return {
    ...(source && ATTRIBUTION_SOURCE_PATTERN.test(source) ? { source } : {}),
    ...(community ? { community } : {}),
  };
}

/**
 * The Viva OAuth callback always redirects to the app root, so a deep link to the
 * push opt-in page has to be remembered in the same tab and restored after login.
 * Only the fixed internal opt-in path is accepted.
 */
export function rememberAuthContinuation(
  href: string,
  session: Storage | null = sessionStorageOrNull(),
  now = Date.now(),
): void {
  if (!session) return;
  try {
    const current = new URL(href);
    if (current.pathname !== PUSH_OPT_IN_PATH) return;
    session.setItem(
      AUTH_CONTINUATION_STORAGE_KEY,
      JSON.stringify({ path: current.pathname + current.search, at: now }),
    );
  } catch {
    // A malformed URL cannot become a continuation target.
  }
}

export function takeAuthContinuation(
  session: Storage | null = sessionStorageOrNull(),
  now = Date.now(),
): string | null {
  if (!session) return null;
  try {
    const raw = session.getItem(AUTH_CONTINUATION_STORAGE_KEY);
    if (!raw) return null;
    session.removeItem(AUTH_CONTINUATION_STORAGE_KEY);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as { readonly path?: unknown; readonly at?: unknown };
    if (
      typeof record.at !== 'number' ||
      now - record.at > AUTH_CONTINUATION_TTL_MS ||
      record.at > now + 60_000
    )
      return null;
    if (typeof record.path !== 'string' || !record.path.startsWith(PUSH_OPT_IN_PATH)) return null;
    if (record.path.startsWith('//') || record.path.includes('\\')) return null;
    return record.path;
  } catch {
    return null;
  }
}
