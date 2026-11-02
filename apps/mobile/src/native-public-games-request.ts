/** Closed unauthenticated catalogue; no user or provider credentials cross it. */
export function nativePublicGamesRequest(
  value: string,
  init: RequestInit | undefined,
  config: { apiBaseUrl: string; tenantKey: string },
): boolean {
  const root = `${config.apiBaseUrl}/public/api/v1/${config.tenantKey}/games`;
  if (!value.startsWith(root)) return false;
  const deny = () => {
    throw new Error('NATIVE_REQUEST_REJECTED');
  };
  const url = new URL(value),
    headers = new Headers(init?.headers);
  if (
    value.split('?')[0] !== root ||
    value.endsWith('?') ||
    (init?.method ?? 'GET') !== 'GET' ||
    init?.body != null ||
    url.hash
  )
    deny();
  const allowed = new Set([
    'accept',
    'x-correlation-id',
    'x-app-platform',
    'x-app-version',
    'x-app-build',
  ]);
  if ([...headers].some(([k, v]) => !allowed.has(k) || v.length > 8192 || /[\r\n]/.test(v))) deny();
  const seen = new Set<string>();
  for (const [k, v] of url.searchParams) {
    if (seen.has(k) || !v) deny();
    seen.add(k);
    if (
      k === 'limit'
        ? !/^(?:[1-9]|[1-4][0-9]|50)$/.test(v)
        : k === 'availability'
          ? !/^(?:JOINABLE|INCLUDE_FULL)$/.test(v)
          : k === 'cursor'
            ? !/^[A-Za-z0-9_-]{1,2048}$/.test(v)
            : true
    )
      deny();
  }
  return true;
}
