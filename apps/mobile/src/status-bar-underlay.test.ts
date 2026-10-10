// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installStatusBarUnderlay } from './status-bar-underlay.js';

const native = vi.hoisted(() => ({
  enabled: true,
  setUnderlap: vi.fn(),
  addListener:
    vi.fn<
      (
        event: string,
        listener: (insets: { top: number }) => void,
      ) => Promise<{ remove: () => Promise<void> }>
    >(),
  remove: vi.fn<() => Promise<void>>(),
  setStyle: vi.fn(),
  register: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => native.enabled, isPluginAvailable: () => true },
  SystemBars: { setStyle: native.setStyle },
  SystemBarsStyle: { Dark: 'DARK', Light: 'LIGHT' },
  SystemBarType: { StatusBar: 'StatusBar' },
  registerPlugin: (name: string) => {
    native.register(name);
    return name === 'PadlHubViewport' ? native : { setStyle: native.setStyle };
  },
}));
let stop = () => undefined as void;
async function settle(): Promise<void> {
  await vi.waitFor(() => expect(native.setUnderlap).toHaveBeenCalled());
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
function home(): void {
  document.body.innerHTML = '<div class="figma-home"><div class="fh-main-box"></div></div>';
}
beforeEach(() => {
  vi.clearAllMocks();
  native.enabled = true;
  native.setUnderlap.mockImplementation(({ enabled }: { enabled: boolean }) =>
    Promise.resolve({
      top: enabled ? 59 : 0,
    }),
  );
  native.remove.mockResolvedValue(undefined);
  native.addListener.mockResolvedValue({ remove: native.remove });
  native.setStyle.mockResolvedValue(undefined);
  home();
});
afterEach(() => {
  stop();
  document.body.innerHTML = '';
});

describe('native opaque Home status strip', () => {
  it('keeps dark icons and restores containment if the native underlap call fails', async () => {
    native.setUnderlap.mockRejectedValueOnce(new Error('Viewport is unavailable'));
    stop = installStatusBarUnderlay();
    await vi.waitFor(() => expect(native.setUnderlap).toHaveBeenLastCalledWith({ enabled: false }));
    expect(document.documentElement.classList.contains('phub-status-underlap')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--phub-status-bar-top')).toBe('');
    expect(native.setStyle).toHaveBeenLastCalledWith({ style: 'LIGHT', bar: 'StatusBar' });
    const calls = native.setUnderlap.mock.calls.length;
    document.dispatchEvent(new Event('scroll'));
    await settle();
    expect(native.setUnderlap).toHaveBeenCalledTimes(calls);
  });
  it('keeps light icons and real cutout spacing while white cards and photos scroll below the purple strip', async () => {
    stop = installStatusBarUnderlay();
    await settle();
    expect(native.setUnderlap).toHaveBeenCalledWith({ enabled: true });
    expect(document.documentElement.classList.contains('phub-status-underlap')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--phub-status-bar-top')).toBe('59px');
    expect(native.setStyle).toHaveBeenLastCalledWith({ style: 'DARK', bar: 'StatusBar' });
    const calls = native.setStyle.mock.calls.length;
    const sheet = document.querySelector<HTMLElement>('.fh-main-box')!;
    sheet.style.background = 'white';
    sheet.innerHTML = '<img alt="Synthetic court" src="/synthetic-court.jpg">';
    sheet.scrollTop = 450;
    document.dispatchEvent(new Event('scroll'));
    await settle();
    expect(native.setUnderlap).toHaveBeenCalledTimes(1);
    expect(native.setStyle).toHaveBeenCalledTimes(calls);
    expect(native.setStyle).toHaveBeenLastCalledWith({ style: 'DARK', bar: 'StatusBar' });
    sheet.scrollTop = 0;
    document.dispatchEvent(new Event('scroll'));
    await settle();
    expect(native.setStyle).toHaveBeenCalledTimes(calls);
  });

  it('follows rotation insets and restores native containment for dialogs and other routes', async () => {
    stop = installStatusBarUnderlay();
    await settle();
    native.addListener.mock.calls[0]![1]({ top: 24 });
    expect(document.documentElement.style.getPropertyValue('--phub-status-bar-top')).toBe('24px');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    await vi.waitFor(() => expect(native.setUnderlap).toHaveBeenLastCalledWith({ enabled: false }));
    await settle();
    expect(document.documentElement.classList.contains('phub-status-underlap')).toBe(false);
    dialog.remove();
    await vi.waitFor(() => expect(native.setUnderlap).toHaveBeenLastCalledWith({ enabled: true }));
    await settle();
    document.body.innerHTML = '<main>Профиль</main>';
    await vi.waitFor(() => expect(native.setUnderlap).toHaveBeenLastCalledWith({ enabled: false }));
    await settle();
    expect(document.documentElement.style.getPropertyValue('--phub-status-bar-top')).toBe('0px');
    expect(native.setStyle).toHaveBeenLastCalledWith({ style: 'LIGHT', bar: 'StatusBar' });
  });

  it('serializes a route change during a native layout update', async () => {
    let finish: ((value: { top: number }) => void) | undefined;
    native.setUnderlap.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    stop = installStatusBarUnderlay();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    document.body.innerHTML = '<main>Профиль</main>';
    finish!({ top: 59 });
    await vi.waitFor(() => expect(native.setUnderlap).toHaveBeenLastCalledWith({ enabled: false }));
    await settle();
    expect(document.documentElement.classList.contains('phub-status-underlap')).toBe(false);
  });

  it('does not initialize native presentation in the browser', () => {
    native.enabled = false;
    stop = installStatusBarUnderlay();
    expect(native.register).not.toHaveBeenCalled();
    expect(native.setUnderlap).not.toHaveBeenCalled();
  });
});
