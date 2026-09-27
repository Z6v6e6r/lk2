/**
 * Chat messages arrive as plain text, so a pasted link stays inert until the reader copies it by
 * hand. This module splits one message body into text and external-link segments; callers render the
 * segments as React children, so nothing is ever injected as HTML and `javascript:`, `data:` and
 * similar schemes can never reach an `href`. Only destinations that `URL` parses as `http:` or
 * `https:` become links.
 */

export type ChatLinkSegment =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'link'; readonly value: string; readonly href: string };

/**
 * A scheme-less host is linked only for well-known TLDs. Without that allow-list ordinary Russian
 * abbreviations (`т.д.`, `и.о.`), file names (`смета.xlsx`) and version-like text would turn into
 * links. A host with any other TLD still works when it carries `http://`, `https://` or `www.`.
 */
const KNOWN_TLDS = [
  'website',
  'digital',
  'academy',
  'network',
  'online',
  'school',
  'studio',
  'agency',
  'travel',
  'social',
  'cloud',
  'world',
  'space',
  'store',
  'games',
  'media',
  'email',
  'club',
  'tech',
  'site',
  'shop',
  'live',
  'team',
  'page',
  'link',
  'wiki',
  'zone',
  'plus',
  'style',
  'news',
  'blog',
  'life',
  'game',
  'info',
  'name',
  'com',
  'net',
  'org',
  'edu',
  'gov',
  'biz',
  'app',
  'dev',
  'xyz',
  'top',
  'vip',
  'fit',
  'run',
  'art',
  'one',
  'fun',
  'io',
  'me',
  'co',
  'tv',
  'cc',
  'gg',
  'ai',
  'ru',
  'su',
  'ua',
  'kz',
  'by',
  'uz',
  'am',
  'ge',
  'az',
  'md',
  'kg',
  'tj',
  'tm',
  'ee',
  'lv',
  'lt',
  'uk',
  'de',
  'fr',
  'es',
  'it',
  'nl',
  'pl',
  'cz',
  'fi',
  'se',
  'ch',
  'at',
  'be',
  'dk',
  'no',
  'pt',
  'gr',
  'ro',
  'bg',
  'hu',
  'ie',
  'tr',
  'il',
  'ae',
  'us',
  'ca',
  'au',
  'nz',
  'jp',
  'cn',
  'kr',
  'in',
  'br',
  'mx',
  'ar',
  'cl',
  'za',
  'eg',
] as const;

/** Up to a handful of labels keeps deep hosts working and the scan bounded on pathological input. */
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/** A trailing sentence dot is allowed, a following label character or `.` is not (`a.co.uk`). */
const BARE_DOMAIN = `(?:${LABEL}\\.){1,10}(?:${KNOWN_TLDS.join('|')})(?!\\.?[a-z0-9-])`;
/**
 * Characters that may not appear inside a link. Quotes and angle brackets are excluded so a
 * candidate can never break out of an attribute, and whitespace bounds every candidate.
 */
const UNQUOTED = `[^\\s<>"'«»\\\\]+`;

const LINK_CANDIDATE = new RegExp(
  `https?://${UNQUOTED}|www\\.${UNQUOTED}|${BARE_DOMAIN}(?::\\d{1,5})?(?:/[^\\s<>"'«»\\\\]*)?`,
  'giu',
);

/** A candidate glued to a word, a number or an e-mail local part is not a link of its own. */
const PRECEDING_WORD_CHARACTER = /[\p{L}\p{N}_@]/u;
const SCHEME_PATTERN = /^https?:\/\//iu;
const SCHEMELESS_HOST = new RegExp(
  `^${LABEL}(?:\\.${LABEL})+(?::\\d{1,5})?(?:[/?#][^\\s]*)?$`,
  'iu',
);

const SENTENCE_ENDINGS = new Set(['.', ',', ';', ':', '!', '?', '…', '·']);
const BRACKET_PAIRS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };

function occurrences(value: string, character: string): number {
  let count = 0;
  for (const candidate of value) {
    if (candidate === character) count += 1;
  }
  return count;
}

/**
 * Returns the address without the punctuation that belongs to the sentence. `(см. https://padlhub.ru).`
 * links the address itself and leaves both brackets and the final dot as text.
 */
function trimTrailing(value: string): string {
  let trimmed = value;
  for (;;) {
    const last = trimmed.at(-1);
    if (last === undefined) return trimmed;
    if (SENTENCE_ENDINGS.has(last)) {
      trimmed = trimmed.slice(0, -1);
      continue;
    }
    const opener = BRACKET_PAIRS[last];
    if (opener !== undefined && occurrences(trimmed, last) > occurrences(trimmed, opener)) {
      trimmed = trimmed.slice(0, -1);
      continue;
    }
    return trimmed;
  }
}

/** Returns the destination to open, or `null` when the candidate is not an http(s) address. */
function linkHref(value: string): string | null {
  const hasScheme = SCHEME_PATTERN.test(value);
  if (!hasScheme && !SCHEMELESS_HOST.test(value)) return null;
  const candidate = hasScheme ? value : `https://${value}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname) return null;
    return candidate;
  } catch {
    return null;
  }
}

/** Splits one message body into the text and link pieces a renderer has to keep apart. */
export function splitChatLinks(body: string): readonly ChatLinkSegment[] {
  if (!body) return [];
  const segments: ChatLinkSegment[] = [];
  let cursor = 0;
  for (const match of body.matchAll(LINK_CANDIDATE)) {
    const start = match.index;
    if (start === undefined) continue;
    const preceding = start === 0 ? '' : (body[start - 1] ?? '');
    if (preceding !== '' && PRECEDING_WORD_CHARACTER.test(preceding)) continue;
    // `padlhub.ru@example.com` is an e-mail local part, not a link followed by text.
    if ((body[start + match[0].length] ?? '') === '@') continue;
    const value = trimTrailing(match[0]);
    const href = linkHref(value);
    if (href === null) continue;
    if (start > cursor) segments.push({ kind: 'text', value: body.slice(cursor, start) });
    segments.push({ kind: 'link', value, href });
    cursor = start + value.length;
  }
  if (cursor < body.length) segments.push({ kind: 'text', value: body.slice(cursor) });
  return segments;
}
