import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, rmSync, mkdtempSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const bundleName = 'verify-communities-staging-role-split-trusted-inventory-gate.mjs';
const committedBundlePath = join(
  repositoryRoot,
  'deploy/jetson/generated-gate-preflight',
  bundleName,
);

describe('communities role-split trusted-inventory gate preflight bundle', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0).reverse()) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('rebuilds byte-for-byte and contains only Node builtin imports', () => {
    const outputDirectory = realpathSync(
      mkdtempSync(join(tmpdir(), 'phub-role-split-gate-preflight-bundle-')),
    );
    temporaryRoots.push(outputDirectory);
    execFileSync('npm', ['run', 'db:communities-role-split:gate-preflight-bundle:build'], {
      cwd: repositoryRoot,
      env: { ...process.env, PHUB_ROLE_SPLIT_GATE_PREFLIGHT_OUT_DIR: outputDirectory },
      stdio: 'pipe',
    });

    const committed = readFileSync(committedBundlePath);
    const rebuilt = readFileSync(join(outputDirectory, bundleName));
    expect(rebuilt).toEqual(committed);

    const source = committed.toString('utf8');
    const allowedBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gmu)].map(
      ([, specifier]) => specifier!,
    );
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => allowedBuiltins.has(specifier))).toBe(true);
    expect(source).not.toContain('sourceMappingURL=');
  }, 30_000);

  it('fails closed without opening an input or receiving execution authority', () => {
    const direct = spawnSync(process.execPath, [committedBundlePath], {
      encoding: 'utf8',
      env: {
        LANG: 'C',
        LC_ALL: 'C',
        PATH: '/usr/bin:/bin',
      },
    });
    expect(direct.status).toBe(1);
    expect(direct.stdout).toBe('');
    expect(direct.stderr).toBe(
      'COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_GATE_PREFLIGHT_INVALID\n',
    );
  });
});
