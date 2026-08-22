import { resolve } from 'node:path';

import { defineConfig } from 'tsup';

const outputDirectory = process.env.PHUB_ROLE_SPLIT_RUNTIME_OUT_DIR;

export default defineConfig({
  entry: {
    'communities-staging-role-split-trusted-inventory-runtime':
      'src/communities-staging-role-split-trusted-inventory-runtime-module.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  bundle: true,
  splitting: false,
  sourcemap: false,
  shims: true,
  clean: true,
  noExternal: [/^@phub\//, 'pg'],
  banner: {
    js: "import { createRequire as __phubCreateRequire } from 'node:module';\nconst require = __phubCreateRequire(import.meta.url);",
  },
  outDir: outputDirectory ? resolve(outputDirectory) : resolve('../../deploy/jetson/generated'),
  outExtension: () => ({ js: '.mjs' }),
});
