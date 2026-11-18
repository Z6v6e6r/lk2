type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Runs a startup read that the first screen does not need (badge counts, friend requests) once the
 * browser has spare capacity. The read still happens on this screen without another tap; only its
 * place in the queue changes, so the profile and game content are not competing with badges.
 * Environments without `requestIdleCallback` (jsdom, older WebViews) still run the task.
 */
/**
 * Defers the *start* of a non-critical read until the browser is idle, then follows its outcome.
 * The caller keeps the same `.then` shape, so a slow secondary block cannot delay the content the
 * screen is actually about.
 *
 * `shouldStart` is checked inside the idle callback: if the screen unmounted or the session changed
 * while waiting, the read is never sent, so a late callback cannot touch another screen or account.
 * The idle callback is a scheduling hint with a ceiling, not a delivery guarantee.
 */
export function deferRead<T>(
  start: () => Promise<T>,
  options: { readonly timeoutMs?: number; readonly shouldStart?: () => boolean } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    runWhenIdle(() => {
      // The screen that asked is gone: never start the read. The promise is abandoned together with
      // that effect, and rejecting here would show a failure for a screen nobody is looking at.
      if (options.shouldStart && !options.shouldStart()) return;
      start().then(resolve, reject);
    }, options.timeoutMs ?? 2_000);
  });
}

export function runWhenIdle(task: () => void, timeoutMs = 2_000): () => void {
  const idle = window as IdleWindow;
  if (typeof idle.requestIdleCallback === 'function') {
    const handle = idle.requestIdleCallback(task, { timeout: timeoutMs });
    return () => idle.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(task, 0);
  return () => window.clearTimeout(handle);
}
