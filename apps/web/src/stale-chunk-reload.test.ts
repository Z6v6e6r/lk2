import { describe, expect, it, vi } from 'vitest';

import {
  STALE_CHUNK_RELOAD_MARKER_KEY,
  STALE_CHUNK_RELOAD_WINDOW_MS,
  installStaleChunkReload,
  shouldReloadForStaleChunk,
} from './stale-chunk-reload.js';

function fakeHost(
  options: {
    readonly noStorage?: boolean;
    readonly failGet?: boolean;
    readonly failSet?: boolean;
  } = {},
) {
  const listeners = new Map<string, (event: Event) => void>();
  const stored = new Map<string, string>();
  const reload = vi.fn();
  const sessionStorage = options.noStorage
    ? undefined
    : {
        getItem(key: string): string | null {
          if (options.failGet) throw new Error('storage denied');
          return stored.get(key) ?? null;
        },
        setItem(key: string, value: string): void {
          if (options.failSet) throw new Error('storage denied');
          stored.set(key, value);
        },
      };
  const host = {
    addEventListener(type: string, listener: (event: Event) => void): void {
      listeners.set(type, listener);
    },
    location: { reload },
    ...(sessionStorage ? { sessionStorage } : {}),
  };
  const fire = (): { readonly preventDefault: ReturnType<typeof vi.fn> } => {
    const event = { preventDefault: vi.fn() };
    listeners.get('vite:preloadError')?.(event as unknown as Event);
    return event;
  };
  return { host, fire, reload, stored };
}

describe('stale chunk reload', () => {
  it('reloads once and records the moment of the automatic reload', () => {
    const { host, fire, reload, stored } = fakeHost();
    installStaleChunkReload(host, () => 1_000);

    const event = fire();
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(stored.get(STALE_CHUNK_RELOAD_MARKER_KEY)).toBe('1000');
  });

  it('refuses a second reload inside the window instead of looping', () => {
    const { host, fire, reload } = fakeHost();
    let now = 1_000;
    installStaleChunkReload(host, () => now);

    fire();
    now = 1_000 + STALE_CHUNK_RELOAD_WINDOW_MS - 1;
    const event = fire();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads again once the window has passed, so a later deploy can self-heal', () => {
    const { host, fire, reload } = fakeHost();
    let now = 1_000;
    installStaleChunkReload(host, () => now);

    fire();
    now = 1_000 + STALE_CHUNK_RELOAD_WINDOW_MS + 1;
    fire();

    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('skips the automatic reload when the guard cannot be recorded', () => {
    const { host, fire, reload } = fakeHost({ failSet: true });
    installStaleChunkReload(host, () => 1_000);

    const event = fire();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('skips the automatic reload without session storage at all', () => {
    const { host, fire, reload } = fakeHost({ noStorage: true });
    installStaleChunkReload(host, () => 1_000);

    expect(() => fire()).not.toThrow();
    expect(reload).not.toHaveBeenCalled();
  });

  it('treats an unreadable marker as absent', () => {
    const { host, fire, reload } = fakeHost({ failGet: true });
    installStaleChunkReload(host, () => 1_000);

    // Reading throws, so the marker is unknown; recording still works and one reload is allowed.
    expect(() => fire()).not.toThrow();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('compares the window boundary explicitly', () => {
    expect(shouldReloadForStaleChunk(null, 5_000)).toBe(true);
    expect(shouldReloadForStaleChunk(1_000, 1_000 + STALE_CHUNK_RELOAD_WINDOW_MS)).toBe(false);
    expect(shouldReloadForStaleChunk(1_000, 1_001 + STALE_CHUNK_RELOAD_WINDOW_MS)).toBe(true);
  });
});
