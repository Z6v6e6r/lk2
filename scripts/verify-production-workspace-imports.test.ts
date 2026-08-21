import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const fixtures: string[] = [];
const verifierSource = readFileSync(
  join(process.cwd(), 'scripts', 'verify-production-workspace-imports.js'),
  'utf8',
);

function fixture(
  importSpecifier = '@phub/auth',
  dependencies: Record<string, string> = { '@phub/auth': '0.1.0' },
) {
  const root = mkdtempSync(join(tmpdir(), 'phub-production-imports-'));
  fixtures.push(root);
  mkdirSync(join(root, 'apps', 'realtime', 'dist'), { recursive: true });
  mkdirSync(join(root, 'packages', 'auth', 'dist'), { recursive: true });
  mkdirSync(join(root, 'node_modules', '@phub'), { recursive: true });
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts', 'verify-production-workspace-imports.js'), verifierSource);
  writeFileSync(join(root, 'apps', 'realtime', 'package.json'), JSON.stringify({ dependencies }));
  writeFileSync(join(root, 'apps', 'realtime', 'dist', 'app.js'), `import '${importSpecifier}';\n`);
  writeFileSync(
    join(root, 'packages', 'auth', 'package.json'),
    JSON.stringify({ type: 'module', exports: './dist/index.js' }),
  );
  writeFileSync(join(root, 'packages', 'auth', 'dist', 'index.js'), 'export const ok = true;\n');
  symlinkSync(join(root, 'packages', 'auth'), join(root, 'node_modules', '@phub', 'auth'));
  return root;
}

function run(root: string) {
  return spawnSync(
    process.execPath,
    [join(root, 'scripts', 'verify-production-workspace-imports.js'), 'realtime'],
    { cwd: root, encoding: 'utf8' },
  );
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('production workspace import verifier', () => {
  it('loads declared workspace imports from built package output', () => {
    const result = run(fixture());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('production_workspace_imports application=realtime status=passed\n');
  });

  it('rejects a missing workspace package', () => {
    const root = fixture();
    rmSync(join(root, 'node_modules', '@phub', 'auth'));
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ERR_MODULE_NOT_FOUND');
  });

  it('rejects undeclared imports without loading them', () => {
    const result = run(fixture('unexpected-package'));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Built application imports undeclared production dependency: unexpected-package',
    );
  });

  it('rejects a declared external dependency that is absent from the production install', () => {
    const result = run(
      fixture('missing-external', {
        '@phub/auth': '0.1.0',
        'missing-external': '1.0.0',
      }),
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ERR_MODULE_NOT_FOUND');
  });
});

describe('Node production image dependency layout', () => {
  for (const service of ['api', 'worker', 'realtime', 'migrator']) {
    it(`${service} performs a clean locked workspace install and import verification`, () => {
      const dockerfile = readFileSync(join('apps', service, 'Dockerfile'), 'utf8');
      const runtimeUser = dockerfile.indexOf('USER appuser');
      const importVerification = dockerfile.indexOf(
        `RUN node scripts/verify-production-workspace-imports.js ${service}`,
      );
      expect(dockerfile).toContain(
        'npm ci --omit=dev --include=optional --workspaces --no-audit --no-fund',
      );
      expect(dockerfile).toContain(
        'find apps packages -name node_modules -prune -exec rm -rf -- {} +',
      );
      expect(dockerfile).toContain(
        `node scripts/verify-production-workspace-imports.js ${service}`,
      );
      expect(dockerfile).toContain('chmod -R a+rX apps packages');
      expect(dockerfile).toContain('scripts node_modules');
      expect(dockerfile).toContain('chmod a+r package.json package-lock.json .npmrc');
      expect(runtimeUser).toBeGreaterThan(0);
      expect(importVerification).toBeGreaterThan(runtimeUser);
      expect(dockerfile).not.toMatch(/chmod[^\n]*(?:a\+w|o\+w|777)/);
      expect(dockerfile).not.toContain('COPY --from=build /workspace/node_modules');
      expect(dockerfile).not.toContain('npm prune');
    });
  }

  it('keeps the copied migration tree readable by the non-root migrator', () => {
    const dockerfile = readFileSync(join('apps', 'migrator', 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('chmod -R a+rX apps packages migrations scripts node_modules');
  });

  it('normalizes restrictive checkout files for read-only non-root access', () => {
    const root = mkdtempSync(join(tmpdir(), 'phub-production-permissions-'));
    fixtures.push(root);
    for (const directory of ['apps/api', 'packages/auth', 'scripts', 'node_modules/@phub/auth']) {
      mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
    }
    for (const path of [
      'apps/api/package.json',
      'packages/auth/package.json',
      'scripts/verify-production-workspace-imports.js',
      'node_modules/@phub/auth/package.json',
      'package.json',
      'package-lock.json',
      '.npmrc',
    ]) {
      writeFileSync(join(root, path), '{}\n', { mode: 0o600 });
      chmodSync(join(root, path), 0o600);
    }

    const recursive = spawnSync(
      'chmod',
      ['-R', 'a+rX', 'apps', 'packages', 'scripts', 'node_modules'],
      { cwd: root, encoding: 'utf8' },
    );
    const manifests = spawnSync('chmod', ['a+r', 'package.json', 'package-lock.json', '.npmrc'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(recursive.status, recursive.stderr).toBe(0);
    expect(manifests.status, manifests.stderr).toBe(0);

    for (const path of [
      'apps/api/package.json',
      'packages/auth/package.json',
      'scripts/verify-production-workspace-imports.js',
      'node_modules/@phub/auth/package.json',
      'package.json',
      'package-lock.json',
      '.npmrc',
    ]) {
      const mode = statSync(join(root, path)).mode & 0o777;
      expect(mode & 0o004, path).toBe(0o004);
      expect(mode & 0o002, path).toBe(0);
    }
    for (const path of ['apps', 'packages', 'scripts', 'node_modules']) {
      expect(statSync(join(root, path)).mode & 0o001, path).toBe(0o001);
    }
  });
});
