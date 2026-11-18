import { describe, expect, it } from 'vitest';

import { ifNoneMatchMatches } from './conditional-media-get.js';

describe('ifNoneMatchMatches', () => {
  it('matches the exact stored ETag', () => {
    expect(ifNoneMatchMatches('"avatar-v1"', '"avatar-v1"')).toBe(true);
  });

  it('treats a weak tag on either side as equal (weak comparison)', () => {
    expect(ifNoneMatchMatches('W/"avatar-v1"', '"avatar-v1"')).toBe(true);
    expect(ifNoneMatchMatches('"avatar-v1"', 'W/"avatar-v1"')).toBe(true);
  });

  it('matches one tag out of a comma-separated list, ignoring whitespace', () => {
    expect(ifNoneMatchMatches('"other",   W/"avatar-v1" , "third"', '"avatar-v1"')).toBe(true);
    expect(ifNoneMatchMatches('"other","third"', '"avatar-v1"')).toBe(false);
  });

  it('matches any existing representation only when the wildcard is the whole field', () => {
    expect(ifNoneMatchMatches('*', '"avatar-v1"')).toBe(true);
    expect(ifNoneMatchMatches('  *  ', '"avatar-v1"')).toBe(true);
    // A stored object without an ETag still exists, so a lone "*" must still match it.
    expect(ifNoneMatchMatches('*', undefined)).toBe(true);
    // A wildcard mixed with tags is not the wildcard production; fail safe.
    expect(ifNoneMatchMatches('*, "avatar-v1"', '"avatar-v1"')).toBe(false);
    expect(ifNoneMatchMatches('"avatar-v1", *', '"avatar-v1"')).toBe(false);
  });

  it('does not match a changed object', () => {
    expect(ifNoneMatchMatches('"avatar-v0"', '"avatar-v1"')).toBe(false);
  });

  it('keeps a comma inside a quoted tag as part of that tag', () => {
    expect(ifNoneMatchMatches('"a,b", "avatar-v1"', '"avatar-v1"')).toBe(true);
    expect(ifNoneMatchMatches('"a,b"', '"a"')).toBe(false);
  });

  it('rejects a tag with trailing garbage instead of matching its prefix', () => {
    expect(ifNoneMatchMatches('"avatar-v1"x', '"avatar-v1"')).toBe(false);
    expect(ifNoneMatchMatches('W/"avatar-v1"junk', '"avatar-v1"')).toBe(false);
    expect(ifNoneMatchMatches('"avatar-v1" "avatar-v2"', '"avatar-v1"')).toBe(false);
  });

  it('ignores a malformed header instead of answering 304', () => {
    expect(ifNoneMatchMatches('avatar-v1', '"avatar-v1"')).toBe(false);
    expect(ifNoneMatchMatches('W/', '"avatar-v1"')).toBe(false);
    expect(ifNoneMatchMatches('"unterminated', '"avatar-v1"')).toBe(false);
    expect(ifNoneMatchMatches(', ,', '"avatar-v1"')).toBe(false);
    expect(ifNoneMatchMatches('', '"avatar-v1"')).toBe(false);
    expect(ifNoneMatchMatches(undefined, '"avatar-v1"')).toBe(false);
  });

  it('fails the whole field when one entry is malformed', () => {
    expect(ifNoneMatchMatches('broken, "avatar-v1"', '"avatar-v1"')).toBe(false);
    expect(ifNoneMatchMatches('"avatar-v1", broken', '"avatar-v1"')).toBe(false);
  });

  it('accepts a repeated header value as a list', () => {
    expect(ifNoneMatchMatches(['"avatar-v1"', '"avatar-v2"'], '"avatar-v2"')).toBe(true);
    expect(ifNoneMatchMatches(['"avatar-v1"', '"avatar-v2"'], '"avatar-v3"')).toBe(false);
  });
});
