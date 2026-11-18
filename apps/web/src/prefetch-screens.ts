import { runWhenIdle } from './deferred-idle.js';

/**
 * Warms the chunks of the screens the bottom navigation can open next, after the first screen has
 * been painted. Lazy splitting keeps the entry small, but the first tap would otherwise pay for the
 * chunk immediately; this makes that first open behave like the old eager bundle without moving
 * bytes back into the critical path.
 *
 * The prefetch starts only after two animation frames (the first screen is already on screen) and
 * from an idle callback. Failures are ignored on purpose: a missing prefetch only means the screen
 * loads on demand as before.
 */
// Only the games screen is warmed: it is the data-bearing destination of the primary navigation,
// and importing more screens executes their modules on the main thread right after the first paint,
// which was measured to delay the very transition the prefetch is meant to protect.
const PRIMARY_SCREENS = [() => import('./GamesPage.js')];

export function prefetchPrimaryScreens(
  schedule: (task: () => void) => () => void = runWhenIdle,
): () => void {
  let cancelled = false;
  let cancelIdle: (() => void) | undefined;
  const frame = requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (cancelled) return;
      cancelIdle = schedule(() => {
        if (cancelled) return;
        for (const load of PRIMARY_SCREENS) {
          void load().catch(() => undefined);
        }
      });
    });
  });
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
    if (cancelIdle) cancelIdle();
  };
}
