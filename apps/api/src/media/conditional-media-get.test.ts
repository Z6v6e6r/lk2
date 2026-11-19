import { describe, expect, it } from 'vitest';

import { ifNoneMatchMatches } from './conditional-media-get.js';

describe('ifNoneMatchMatches', () => {
  it('matches the exact stored ETag', () => {
    expect(ifNoneMatchMatches('"avatar-v1"', '"avatar-v1"')).toBe(true);
  });

  it('matches a weak tag and a tag inside a list', () => {
    expect(ifNoneMatchMatches('W/"avatar-v1"', '"avatar-v1"')).toBe(true);
    expect(ifNoneMatchMatches('"other", W/"avatar-v1"', '"avatar-v1"')).toBe(true);
  });

  it('matches any representation when the client sends a wildcard', () => {
    expect(ifNoneMatchMatches('*', '"avatar-v1"')).toBe(true);
  });

  it('does not match a changed object, a missing header or a missing ETag', () => {
    expect(ifNoneMatchMatches('"avatar-v0"', '"avatar-v1"')).toBe(false);
    expect(ifNoneMatchMatches(undefined, '"avatar-v1"')).toBe(false);
    expect(ifNoneMatchMatches('*', undefined)).toBe(false);
    expect(ifNoneMatchMatches('', '"avatar-v1"')).toBe(false);
  });

  it('accepts a repeated header without treating an empty list item as a match', () => {
    expect(ifNoneMatchMatches(['"avatar-v1"', '"avatar-v2"'], '"avatar-v2"')).toBe(true);
    expect(ifNoneMatchMatches(' , ', '"avatar-v1"')).toBe(false);
  });
});
