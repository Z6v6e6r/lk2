/**
 * Matching for the `If-None-Match` request header, limited to the grammar browsers actually send:
 * an optional weak prefix (`W/`), double-quoted opaque tags, comma-separated lists and `*`.
 *
 * `*` means "any current representation", so it matches an existing object even when the stored
 * object exposes no ETag. An explicit tag only matches when the stored object exposes the same tag
 * under weak comparison, which is what a revalidating HTTP cache needs.
 *
 * This is not a full RFC 9110 parser. Malformed entries (unquoted tags, an unterminated quoted
 * string, a bare `W/`) are ignored instead of guessed, so a broken header degrades to a normal 200
 * and never to a false 304.
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

/** Returns `undefined` when nothing usable was sent; otherwise the wildcard flag and valid tags. */
function parseIfNoneMatch(
  header: string | readonly string[] | undefined,
): ParsedIfNoneMatch | undefined {
  if (!header) return undefined;
  const raw = typeof header === 'string' ? header : header.join(',');
  if (!raw.trim()) return undefined;

  const tags: string[] = [];
  let wildcard = false;
  let index = 0;

  while (index < raw.length) {
    const character = raw[index];
    if (character === ' ' || character === '\t' || character === ',') {
      index += 1;
      continue;
    }
    if (character === '*') {
      wildcard = true;
      index += 1;
      continue;
    }
    // Optional weak indicator, then an opaque quoted tag. Anything else is malformed for this
    // subset and is skipped up to the next separator.
    let cursor = index;
    if (raw.startsWith('W/', cursor)) cursor += 2;
    if (raw[cursor] !== '"') {
      index = skipToNextSeparator(raw, cursor);
      continue;
    }
    const close = raw.indexOf('"', cursor + 1);
    if (close === -1) {
      index = raw.length;
      continue;
    }
    tags.push(raw.slice(index, close + 1));
    index = close + 1;
  }

  if (!wildcard && tags.length === 0) return undefined;
  return { wildcard, tags };
}

function skipToNextSeparator(raw: string, from: number): number {
  const nextComma = raw.indexOf(',', from);
  return nextComma === -1 ? raw.length : nextComma + 1;
}
