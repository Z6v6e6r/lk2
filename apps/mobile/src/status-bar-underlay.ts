import {
  Capacitor,
  registerPlugin,
  SystemBars,
  SystemBarsStyle,
  SystemBarType,
} from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

interface ViewportInsets {
  readonly top: number;
}
interface ViewportPlugin {
  setUnderlap(options: { readonly enabled: boolean }): Promise<ViewportInsets>;
  addListener(
    event: 'insetsChanged',
    listener: (insets: ViewportInsets) => void,
  ): Promise<PluginListenerHandle>;
}
/** Let Home artwork scroll under system UI; other screens keep native containment. */
export function installStatusBarUnderlay(): () => void {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('PadlHubViewport'))
    return () => undefined;
  const viewport = registerPlugin<ViewportPlugin>('PadlHubViewport');
  const html = document.documentElement;
  let top = 0;
  let applied: boolean | undefined;
  let updating = false;
  let stopped = false;
  let failed = false;
  let frame = 0;
  let iconStyle: SystemBarsStyle | undefined;
  let listener: PluginListenerHandle | undefined;

  function homeUnderlay(): HTMLElement | null {
    const dialog = Array.from(
      document.querySelectorAll<HTMLElement>('[role="dialog"], dialog[open]'),
    ).some(
      (element) =>
        !element.hidden &&
        element.getAttribute('aria-hidden') !== 'true' &&
        getComputedStyle(element).display !== 'none',
    );
    return dialog ? null : document.querySelector<HTMLElement>('.figma-home');
  }

  function updateIconStyle(): void {
    const home = applied ? homeUnderlay() : null;
    const sheet = home?.querySelector<HTMLElement>('.fh-main-box');
    const overLightSheet = sheet && sheet.getBoundingClientRect().top <= top;
    const overPhoto = Boolean(
      home &&
      document
        .elementsFromPoint?.(innerWidth / 2, top / 2)
        .some(
          (element) =>
            element.matches('img, video, canvas') ||
            getComputedStyle(element).backgroundImage.includes('url('),
        ),
    );
    const next =
      home && (!overLightSheet || overPhoto) ? SystemBarsStyle.Dark : SystemBarsStyle.Light;
    if (next === iconStyle) return;
    iconStyle = next;
    // DARK means light glyphs. Navigation-bar appearance remains separately native-owned.
    void SystemBars.setStyle({ style: next, bar: SystemBarType.StatusBar }).catch(() => undefined);
  }

  function applyInsets(insets: ViewportInsets): void {
    if (stopped || failed || !Number.isFinite(insets.top) || insets.top < 0) return;
    top = insets.top;
    html.style.setProperty('--phub-status-bar-top', `${top}px`);
    updateIconStyle();
  }

  async function reconcile(): Promise<void> {
    frame = 0;
    if (stopped || failed) return;
    const enabled = Boolean(homeUnderlay());
    if (updating || enabled === applied) {
      updateIconStyle();
      return;
    }
    updating = true;
    try {
      const insets = await viewport.setUnderlap({ enabled });
      if (stopped) return;
      applied = enabled;
      html.classList.toggle('phub-status-underlap', enabled);
      applyInsets(insets);
    } catch {
      // Unsupported native shells retain their existing contained viewport.
      failed = true;
      applied = false;
      top = 0;
      html.classList.remove('phub-status-underlap');
      html.style.removeProperty('--phub-status-bar-top');
      updateIconStyle();
      void viewport.setUnderlap({ enabled: false }).catch(() => undefined);
    } finally {
      updating = false;
      if (!stopped && !failed && Boolean(homeUnderlay()) !== enabled) schedule();
    }
  }

  function schedule(): void {
    if (!stopped && !frame) frame = requestAnimationFrame(() => void reconcile());
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['open', 'hidden', 'aria-hidden'],
  });
  document.addEventListener('scroll', schedule, { passive: true, capture: true });
  window.addEventListener('resize', schedule, { passive: true });
  void viewport
    .addListener('insetsChanged', applyInsets)
    .then((handle) => {
      if (stopped) void handle.remove();
      else listener = handle;
    })
    .catch(() => undefined);
  schedule();

  return () => {
    stopped = true;
    observer.disconnect();
    cancelAnimationFrame(frame);
    document.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule);
    void listener?.remove();
    html.classList.remove('phub-status-underlap');
    html.style.removeProperty('--phub-status-bar-top');
    void viewport.setUnderlap({ enabled: false }).catch(() => undefined);
  };
}
