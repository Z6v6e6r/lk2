import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/communities-staging-role-split-v3-anchor-rehearsal.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  bundle: true,
  splitting: false,
  sourcemap: true,
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  clean: false,
  noExternal: [/^@phub\//, /^pg$/],
});
