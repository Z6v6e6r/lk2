import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
      expect(dockerfile).toContain(
        'npm ci --omit=dev --include=optional --workspaces --no-audit --no-fund',
      );
      expect(dockerfile).toContain(
        'find apps packages -name node_modules -prune -exec rm -rf -- {} +',
      );
      expect(dockerfile).toContain(
        `node scripts/verify-production-workspace-imports.js ${service}`,
      );
      expect(dockerfile).not.toContain('COPY --from=build /workspace/node_modules');
      expect(dockerfile).not.toContain('npm prune');
    });
  }
});
