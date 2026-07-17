export interface BrowserAuthNavigator {
  readonly userAgent: string;
  readonly platform: string;
  readonly maxTouchPoints: number;
}

export type AuthEntryView = 'oauth' | 'phone';

export function isIOSBrowser(navigatorLike: BrowserAuthNavigator | undefined): boolean {
  if (!navigatorLike) return false;
  if (/(iPad|iPhone|iPod)/i.test(navigatorLike.userAgent)) return true;

  // iPadOS can identify itself as macOS while still exposing a touch-first browser.
  return navigatorLike.platform === 'MacIntel' && navigatorLike.maxTouchPoints > 1;
}

export function preferredAuthEntryView(
  navigatorLike: BrowserAuthNavigator | undefined,
): AuthEntryView {
  return isIOSBrowser(navigatorLike) ? 'phone' : 'oauth';
}
