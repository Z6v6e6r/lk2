import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'tsup';

const outputDirectory = process.env.PHUB_ROLE_SPLIT_GATE_PREFLIGHT_OUT_DIR;
const repositoryNodeModules = fileURLToPath(new URL('../../node_modules', import.meta.url));

try {
  const nodeModules = lstatSync(repositoryNodeModules);
  if (!nodeModules.isDirectory() || nodeModules.isSymbolicLink()) throw new Error();
} catch {
  throw new Error('COMMUNITIES_ROLE_SPLIT_GATE_PREFLIGHT_BUNDLE_DEPENDENCY_TREE_INVALID');
}

export default defineConfig({
  entry: {
    'verify-communities-staging-role-split-trusted-inventory-gate':
      'src/verify-communities-staging-role-split-trusted-inventory-gate.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: false,
  noExternal: [/^@phub\//],
  outDir: outputDirectory
    ? resolve(outputDirectory)
    : resolve('../../deploy/jetson/generated-gate-preflight'),
  outExtension: () => ({ js: '.mjs' }),
});
