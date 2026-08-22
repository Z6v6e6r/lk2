import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'tsup';

const outputDirectory = process.env.PHUB_ROLE_SPLIT_RUNTIME_OUT_DIR;
const repositoryNodeModules = fileURLToPath(new URL('../../node_modules', import.meta.url));

try {
  const nodeModules = lstatSync(repositoryNodeModules);
  if (!nodeModules.isDirectory() || nodeModules.isSymbolicLink()) throw new Error();
} catch {
  throw new Error('COMMUNITIES_ROLE_SPLIT_RUNTIME_BUNDLE_DEPENDENCY_TREE_INVALID');
}

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
