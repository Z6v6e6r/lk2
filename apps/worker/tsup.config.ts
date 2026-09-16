import { defineConfig } from 'tsup';

export default defineConfig({
  // The operator one-shot for the audited legacy roster repair ships next to the worker because the
  // release image contains only the bundled entrypoints, never the source tree.
  entry: ['src/main.ts', 'src/repair-legacy-game-rosters.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
});
