/**
 * Weak comparison of `If-None-Match` against a stored object ETag (RFC 9110 §13.1.2).
 *
 * Public media URLs keep the same address while the stored bytes keep the same ETag, so a browser
 * or a Capacitor WebView that revalidates an unchanged avatar can be answered with a bodyless 304
 * instead of the whole image. A missing or malformed tag simply falls through to the normal 200.
 */
export function ifNoneMatchMatches(
  header: string | readonly string[] | undefined,
  etag: string | undefined,
): boolean {
  if (!header || !etag) return false;
  const raw = typeof header === 'string' ? header : header.join(',');
  const normalize = (value: string): string => value.trim().replace(/^W\//, '');
  const target = normalize(etag);
  if (!target) return false;
  return raw.split(',').some((candidate) => {
    const entry = candidate.trim();
    return entry === '*' || normalize(entry) === target;
  });
}
