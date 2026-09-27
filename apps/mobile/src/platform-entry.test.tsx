// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const entry = vi.hoisted(() => ({
  platform: 'ios',
  render: vi.fn(),
  loadIOS: vi.fn(),
  loadShared: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => entry.platform },
}));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: entry.render }) }));

describe('mobile platform boot isolation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock('./ios/IOSAuthApp.js', () => {
      entry.loadIOS();
      return { IOSAuthApp: () => null };
    });
    vi.doMock('./shared-app-entry.js', () => {
      entry.loadShared();
      return {};
    });
    document.body.innerHTML = '<div id="root"></div>';
  });

  it('boots iOS without initializing the Android/Web gateway and styles', async () => {
    entry.platform = 'ios';
    await import('./main.js');
    await vi.dynamicImportSettled();
    expect(entry.loadIOS).toHaveBeenCalledOnce();
    expect(entry.loadShared).not.toHaveBeenCalled();
    expect(entry.render).toHaveBeenCalledOnce();
  });

  it.each(['android', 'web'])(
    'preserves the shared %s entry without iOS sessions',
    async (platform) => {
      entry.platform = platform;
      await import('./main.js');
      await vi.dynamicImportSettled();
      expect(entry.loadShared).toHaveBeenCalledOnce();
      expect(entry.loadIOS).not.toHaveBeenCalled();
      expect(entry.render).not.toHaveBeenCalled();
    },
  );
});
