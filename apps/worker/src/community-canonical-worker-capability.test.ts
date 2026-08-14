import { describe, expect, it } from 'vitest';

import { isCanonicalCommunityWorkerEnabled } from './community-canonical-worker-capability.js';

describe('canonical Communities worker capability', () => {
  it('is default-deny for mock and legacy read modes', () => {
    expect(isCanonicalCommunityWorkerEnabled('mock')).toBe(false);
    expect(isCanonicalCommunityWorkerEnabled('legacy')).toBe(false);
  });

  it('is enabled only for the canonical local read mode', () => {
    expect(isCanonicalCommunityWorkerEnabled('local')).toBe(true);
  });
});
