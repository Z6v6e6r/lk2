import { readdir, readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const supportedApplications = new Set(['api', 'worker', 'realtime', 'migrator']);
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
const importPattern = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"]([^'"]+)['"]/g;

async function scanDirectory(directory, bareSpecifiers) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(path, bareSpecifiers);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (
        specifier &&
        !specifier.startsWith('.') &&
        !specifier.startsWith('/') &&
        !specifier.startsWith('node:') &&
        !builtins.has(specifier)
      ) {
        bareSpecifiers.add(specifier);
      }
    }
  }
}

export async function verifyProductionWorkspaceImports(application) {
  if (!supportedApplications.has(application)) {
    throw new Error('Expected one supported production application name');
  }

  const applicationRoot = join('apps', application);
  const manifest = JSON.parse(await readFile(join(applicationRoot, 'package.json'), 'utf8'));
  const declaredDependencies = new Set(Object.keys(manifest.dependencies ?? {}));
  const bareSpecifiers = new Set();

  await scanDirectory(join(applicationRoot, 'dist'), bareSpecifiers);
  for (const dependency of declaredDependencies) {
    if (dependency.startsWith('@phub/')) bareSpecifiers.add(dependency);
  }

  for (const specifier of [...bareSpecifiers].sort()) {
    const dependency = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0];
    if (!declaredDependencies.has(dependency)) {
      throw new Error(`Built application imports undeclared production dependency: ${specifier}`);
    }
    const resolved = fileURLToPath(import.meta.resolve(specifier));
    if (
      dependency.startsWith('@phub/') &&
      (!resolved.startsWith(`${resolve('packages')}${sep}`) ||
        !resolved.includes(`${sep}dist${sep}`))
    ) {
      throw new Error(
        `Workspace dependency does not resolve to built package output: ${specifier}`,
      );
    }
    await import(specifier);
  }

  console.log(`production_workspace_imports application=${application} status=passed`);
}

if (process.argv[1]?.endsWith('verify-production-workspace-imports.js')) {
  await verifyProductionWorkspaceImports(process.argv[2]);
}
