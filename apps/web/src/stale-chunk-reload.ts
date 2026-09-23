/**
 * Recovery for a shell that outlived its release.
 *
 * A browser tab opened before a deploy keeps the previous shell in memory. When it later pulls a
 * lazily loaded route, the hashed chunk of that release is gone and the dynamic import fails, which
 * looks like "the section does not open at all" while the API is perfectly healthy. Vite reports
 * that failure as a `vite:preloadError` event, so the app can reload once and pick up the shell that
 * matches the deployed assets.
 *
 * The reload is deliberately bounded: the timestamp of the last automatic reload is kept in
 * sessionStorage and a second failure inside the window is treated as a real breakage instead of
 * reloading forever. When that marker cannot be stored the automatic reload is skipped, because an
 * untracked retry is exactly the loop this guard exists to prevent.
 */

export const STALE_CHUNK_RELOAD_WINDOW_MS = 10_000;
export const STALE_CHUNK_RELOAD_MARKER_KEY = 'phub.web.staleChunkReloadAt';

export interface StaleChunkReloadHost {
  addEventListener(type: string, listener: (event: Event) => void): void;
  readonly location: { reload(): void };
  readonly sessionStorage?: Pick<Storage, 'getItem' | 'setItem'> | undefined;
}

export function shouldReloadForStaleChunk(
  lastReloadAt: number | null,
  now: number,
  windowMs: number = STALE_CHUNK_RELOAD_WINDOW_MS,
): boolean {
  return lastReloadAt === null || now - lastReloadAt > windowMs;
}

function readLastReloadAt(host: StaleChunkReloadHost): number | null {
  try {
    const value = host.sessionStorage?.getItem(STALE_CHUNK_RELOAD_MARKER_KEY);
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function markReload(host: StaleChunkReloadHost, at: number): boolean {
  try {
    if (!host.sessionStorage) return false;
    host.sessionStorage.setItem(STALE_CHUNK_RELOAD_MARKER_KEY, String(at));
    return true;
  } catch {
    return false;
  }
}

export function installStaleChunkReload(
  host: StaleChunkReloadHost,
  now: () => number = Date.now,
): void {
  host.addEventListener('vite:preloadError', (event) => {
    const current = now();
    const lastReloadAt = readLastReloadAt(host);
    if (!shouldReloadForStaleChunk(lastReloadAt, current)) {
      // The same chunk failed twice in a row: another reload would only loop. Let the app show its
      // own failure state instead of a permanent reload cycle.
      event.preventDefault();
      return;
    }
    if (!markReload(host, current)) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    host.location.reload();
  });
}
