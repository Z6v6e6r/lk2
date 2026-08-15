import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/main.ts',
    'src/verify-role-boundary.ts',
    'src/verify-chat-push-foundation.ts',
    'src/verify-chat-push-foundation-operational.ts',
    'src/verify-chat-push-foundation-contour.ts',
  ],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  noExternal: [/^@phub\//],
});
