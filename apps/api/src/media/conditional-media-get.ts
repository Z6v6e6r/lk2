/**
 * Matching for the `If-None-Match` request header, limited to the grammar browsers actually send:
 * an optional weak prefix (`W/`), double-quoted opaque tags, comma-separated lists and a lone `*`.
 *
 * Rules that keep this from over-matching:
 * - `*` counts only when it is the whole field value. `*, "x"` is not a wildcard.
 * - a quoted tag must be followed by a separator or the end of the field; `"v1"junk` is malformed.
 * - malformed entries make the whole field unusable, so the route answers `200` instead of guessing.
 *
 * This is not a full RFC 9110 parser: it has no `If-Match`/`If-Modified-Since`, and it compares the
 * quoted opaque value literally after stripping the weak prefix. Within that subset it is
 * deterministic and fails towards `200`, never towards a false `304`.
 */
export function ifNoneMatchMatches(
  header: string | readonly string[] | undefined,
  etag: string | undefined,
): boolean {
  const parsed = parseIfNoneMatch(header);
  if (!parsed) return false;
  if (parsed.wildcard) return true;
  if (parsed.tags.length === 0 || !etag) return false;
  const target = stripWeakPrefix(etag);
  return parsed.tags.some((tag) => stripWeakPrefix(tag) === target);
}

interface ParsedIfNoneMatch {
  readonly wildcard: boolean;
  readonly tags: readonly string[];
}

function stripWeakPrefix(value: string): string {
  return value.trim().replace(/^W\//, '');
}

const isWhitespace = (character: string | undefined): boolean =>
  character === ' ' || character === '\t';

/** Returns `undefined` when the field is absent, empty or malformed; otherwise the parsed tags. */
function parseIfNoneMatch(
  header: string | readonly string[] | undefined,
): ParsedIfNoneMatch | undefined {
  if (!header) return undefined;
  const raw = (typeof header === 'string' ? header : header.join(',')).trim();
  if (!raw) return undefined;
  if (raw === '*') return { wildcard: true, tags: [] };

  const tags: string[] = [];
  let index = 0;

  while (index < raw.length) {
    while (isWhitespace(raw[index])) index += 1;
    if (index >= raw.length) break;
    if (raw[index] === '*') return undefined; // a wildcard cannot share the field with tags

    let cursor = index;
    if (raw.startsWith('W/', cursor)) cursor += 2;
    if (raw[cursor] !== '"') return undefined; // unquoted or truncated tag

    const close = raw.indexOf('"', cursor + 1);
    if (close === -1) return undefined; // unterminated quoted tag
    tags.push(raw.slice(index, close + 1));
    index = close + 1;

    while (isWhitespace(raw[index])) index += 1;
    if (index >= raw.length) break;
    // Tags are comma-separated. Anything else (another tag, garbage) makes the field malformed.
    if (raw[index] !== ',') return undefined;
    index += 1;
    if (index >= raw.length) return undefined; // trailing comma without a tag
  }

  return tags.length > 0 ? { wildcard: false, tags } : undefined;
}
