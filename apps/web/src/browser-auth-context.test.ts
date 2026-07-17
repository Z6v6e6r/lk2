import { describe, expect, it } from 'vitest';

import { isIOSBrowser, preferredAuthEntryView } from './browser-auth-context.js';

describe('browser authentication context', () => {
  it('recognizes an iPhone browser and prefers phone authentication', () => {
    const browser = {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Mobile/23F77 Safari/604.1',
      platform: 'iPhone',
      maxTouchPoints: 5,
    };

    expect(isIOSBrowser(browser)).toBe(true);
    expect(preferredAuthEntryView(browser)).toBe('phone');
  });

  it('recognizes iPadOS desktop-mode user agents from touch capability', () => {
    expect(
      isIOSBrowser({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        platform: 'MacIntel',
        maxTouchPoints: 5,
      }),
    ).toBe(true);
  });

  it('keeps the Viva OAuth entry screen on non-iOS browsers', () => {
    const browser = {
      userAgent:
        'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/150 Mobile Safari/537.36',
      platform: 'Linux armv8l',
      maxTouchPoints: 5,
    };

    expect(isIOSBrowser(browser)).toBe(false);
    expect(preferredAuthEntryView(browser)).toBe('oauth');
  });
});
