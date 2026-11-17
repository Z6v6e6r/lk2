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

  it('matches any existing representation when the client sends a wildcard', () => {
    expect(ifNoneMatchMatches('*', '"avatar-v1"')).toBe(true);
    // A stored object without an ETag still exists, so "*" must still match it.
    expect(ifNoneMatchMatches('*', undefined)).toBe(true);
  });

  it('does not match a changed object', () => {
    expect(ifNoneMatchMatches('"avatar-v0"', '"avatar-v1"')).toBe(false);
  });

  it('treats a comma inside a quoted tag as part of the tag', () => {
    expect(ifNoneMatchMatches('"a,b", "avatar-v1"', '"avatar-v1"')).toBe(true);
    expect(ifNoneMatchMatches('"a,b"', '"a"')).toBe(false);
  });

  it('ignores a malformed header instead of answering 304', () => {
    expect(ifNoneMatchMatches('avatar-v1', '"avatar-v1"')).toBe(false);
    expect(ifNoneMatchMatches('W/', '"avatar-v1"')).toBe(false);
    expect(ifNoneMatchMatches('"unterminated', '"avatar-v1"')).toBe(false);
    expect(ifNoneMatchMatches(', ,', '"avatar-v1"')).toBe(false);
    expect(ifNoneMatchMatches('', '"avatar-v1"')).toBe(false);
    expect(ifNoneMatchMatches(undefined, '"avatar-v1"')).toBe(false);
  });

  it('still matches a valid tag when a neighbouring entry is malformed', () => {
    expect(ifNoneMatchMatches('broken, "avatar-v1"', '"avatar-v1"')).toBe(true);
  });

  it('accepts a repeated header value', () => {
    expect(ifNoneMatchMatches(['"avatar-v1"', '"avatar-v2"'], '"avatar-v2"')).toBe(true);
    expect(ifNoneMatchMatches(['"avatar-v1"', '"avatar-v2"'], '"avatar-v3"')).toBe(false);
  });
});
