import { buildApp, type BuildAppOptions } from '../app.js';

/** Route fixtures own only synthetic domain state. Session denial has dedicated real-builder tests. */
export function buildAppWithActiveSession(options: BuildAppOptions) {
  return buildApp({ accessSessionChecker: () => Promise.resolve(true), ...options });
}
