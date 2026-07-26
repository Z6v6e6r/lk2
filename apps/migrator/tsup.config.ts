import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    main: 'src/main.ts',
    'backfill-game-conversations': '../../scripts/backfill-game-conversations.ts',
    'set-messaging-runtime': '../../scripts/set-messaging-runtime.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  noExternal: [/^@phub\//],
});
