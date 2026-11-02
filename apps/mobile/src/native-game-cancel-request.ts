/** Exact existing local CANCEL wire; no caller-selected provider method or target origin. */
export function gameCancelRequest(
  value: string,
  init: RequestInit | undefined,
  config: {
    apiBaseUrl: string;
    tenantKey: string;
  },
): { resourceId: string } | null {
  const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}/games/`;
  if (!value.startsWith(root) || !value.includes('/cancel')) return null;
  const match =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/cancel$/.exec(
      value.slice(root.length),
    );
  const headers = new Headers(init?.headers);
  if (
    !match ||
    match[0] !== value.slice(root.length) ||
    init?.method !== 'POST' ||
    typeof init.body !== 'string' ||
    !/^\s*\{\s*"reasonCode"\s*:\s*"ORGANIZER_REQUEST"\s*\}\s*$/.test(init.body) ||
    init.body.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(headers.get('idempotency-key') ?? '') ||
    !/^Bearer [A-Za-z0-9._-]{8,8192}$/.test(headers.get('authorization') ?? '') ||
    (headers.has('content-type') && headers.get('content-type') !== 'application/json')
  ) {
    throw new Error('NATIVE_REQUEST_REJECTED');
  }
  return { resourceId: match[1]! };
}
