import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, rmSync, mkdtempSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const committedBundlePath = join(
  repositoryRoot,
  'deploy/jetson/generated/communities-staging-role-split-trusted-inventory-runtime.mjs',
);
const bundleName = 'communities-staging-role-split-trusted-inventory-runtime.mjs';
const sha256 = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');

describe('communities role-split trusted-inventory runtime bundle', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0).reverse()) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('rebuilds byte-for-byte and contains no package imports', () => {
    const outputDirectory = realpathSync(
      mkdtempSync(join(tmpdir(), 'phub-role-split-runtime-bundle-')),
    );
    temporaryRoots.push(outputDirectory);
    execFileSync('npm', ['run', 'db:communities-role-split:runtime-bundle:build'], {
      cwd: repositoryRoot,
      env: { ...process.env, PHUB_ROLE_SPLIT_RUNTIME_OUT_DIR: outputDirectory },
      stdio: 'pipe',
    });

    const committed = readFileSync(committedBundlePath);
    const rebuilt = readFileSync(join(outputDirectory, bundleName));
    expect(sha256(rebuilt)).toBe(sha256(committed));

    const source = committed.toString('utf8');
    const allowedBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gmu)].map(
      ([, specifier]) => specifier!,
    );
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => allowedBuiltins.has(specifier))).toBe(true);
    expect(source).not.toContain('sourceMappingURL=');
  }, 30_000);

  it('is importable but rejects direct execution before receiving any runtime inputs', async () => {
    const module = (await import(
      `${pathToFileURL(committedBundlePath).href}?test=${Date.now()}`
    )) as {
      readonly COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_LOADER_VERSION: string;
      readonly COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_RUNTIME_MODULE_VERSION: string;
      readonly issueCommunitiesStagingRoleSplitTrustedInventoryAuthorization: unknown;
      readonly loadCommunitiesStagingRoleSplitTrustedInventoryAuthorization: unknown;
      readonly createCommunitiesStagingRoleSplitTrustedInventoryRuntimeWiring: unknown;
    };
    expect(module.COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_RUNTIME_MODULE_VERSION).toBe(
      'communities-staging-role-split-trusted-inventory-runtime-module-v2',
    );
    expect(
      module.COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_LOADER_VERSION,
    ).toBe('communities-staging-role-split-trusted-inventory-authorization-loader-v1');
    expect(typeof module.issueCommunitiesStagingRoleSplitTrustedInventoryAuthorization).toBe(
      'function',
    );
    expect(typeof module.loadCommunitiesStagingRoleSplitTrustedInventoryAuthorization).toBe(
      'function',
    );
    expect(typeof module.createCommunitiesStagingRoleSplitTrustedInventoryRuntimeWiring).toBe(
      'function',
    );
    expect(Object.keys(module).sort()).toEqual([
      'COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_LOADER_VERSION',
      'COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_RUNTIME_MODULE_VERSION',
      'COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_RUNTIME_WIRING_VERSION',
      'CommunitiesStagingRoleSplitTrustedInventoryAuthorizationLoaderError',
      'CommunitiesStagingRoleSplitTrustedInventoryRuntimeWiringError',
      'createCommunitiesStagingRoleSplitTrustedInventoryRuntimeWiring',
      'issueCommunitiesStagingRoleSplitTrustedInventoryAuthorization',
      'loadCommunitiesStagingRoleSplitTrustedInventoryAuthorization',
    ]);

    const direct = spawnSync(process.execPath, [committedBundlePath], {
      encoding: 'utf8',
      env: {
        LANG: 'C',
        LC_ALL: 'C',
        PATH: '/usr/bin:/bin',
      },
    });
    expect(direct.status).toBe(78);
    expect(direct.stdout).toBe('');
    expect(direct.stderr).toBe('COMMUNITIES_ROLE_SPLIT_EXECUTION_NOT_AUTHORIZED\n');
  });
});
