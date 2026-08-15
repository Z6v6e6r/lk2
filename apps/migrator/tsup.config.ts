import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/verify-role-boundary.ts', 'src/verify-media-runtime-role.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  noExternal: [/^@phub\//],
});
