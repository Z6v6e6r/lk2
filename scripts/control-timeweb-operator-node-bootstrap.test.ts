import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { parseStrictJson } from './strict-json.js';

interface BootstrapContract {
  apt: {
    sourceListSha256: string;
    keyringSha256: string;
    packages: Array<{ name: string; version: string; architecture: string }>;
  };
}

const controller = 'scripts/control-timeweb-operator-node-bootstrap.py';
const contractSource = readFileSync('deploy/timeweb/operator-node-bootstrap.v1.json', 'utf8');
const contract = parseStrictJson<BootstrapContract>(contractSource);
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'phub-node-bootstrap-test-'));
  temporaryDirectories.push(path);
  return path;
}

function invoke(args: string[], script = controller) {
  return spawnSync('python3', ['-I', '-S', '-B', script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
}

function installSimulation(
  packages = contract.apt.packages,
  summary = '0 upgraded, 20 newly installed, 0 to remove and 16 not upgraded.',
): string {
  return `${packages
    .map(
      ({ name, version, architecture }) =>
        `Inst ${name} (${version} Ubuntu:26.04/resolute [${architecture}])`,
    )
    .join('\n')}\n${summary}\n`;
}

function validateSimulation(contents: string, action = 'install') {
  const directory = temporaryDirectory();
  const contractPath = join(directory, 'contract.json');
  const simulationPath = join(directory, 'simulation.txt');
  writeFileSync(contractPath, contractSource);
  writeFileSync(simulationPath, contents);
  return invoke([
    'validate-simulation',
    '--contract',
    contractPath,
    '--simulation-file',
    simulationPath,
    '--simulation-action',
    action,
  ]);
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true });
});

describe('Timeweb operator Node bootstrap controller', () => {
  it('accepts the frozen Ubuntu source, keyring and 20-package closure', () => {
    const directory = temporaryDirectory();
    const contractPath = join(directory, 'contract.json');
    writeFileSync(contractPath, contractSource);
    const result = invoke(['validate-contract', '--contract', contractPath]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      packageCount: 20,
      schema: 'PHUB_TIMEWEB_OPERATOR_NODE_BOOTSTRAP_V1',
      status: 'VALID',
    });
  });

  it('rejects an unapproved apt source hash before live work', () => {
    const directory = temporaryDirectory();
    const contractPath = join(directory, 'contract.json');
    const input = structuredClone(contract);
    input.apt.sourceListSha256 = '0'.repeat(64);
    writeFileSync(contractPath, `${JSON.stringify(input)}\n`);
    const result = invoke(['validate-contract', '--contract', contractPath]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('STOP contract_apt_hashes');
  });

  it('rejects a changed package version in the machine contract', () => {
    const directory = temporaryDirectory();
    const contractPath = join(directory, 'contract.json');
    const input = structuredClone(contract);
    input.apt.packages[0]!.version = '8.0.0-2';
    writeFileSync(contractPath, `${JSON.stringify(input)}\n`);
    const result = invoke(['validate-contract', '--contract', contractPath]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('STOP contract_packages');
  });

  it('accepts only the exact new-package install simulation', () => {
    const accepted = validateSimulation(installSimulation());
    expect(accepted.status).toBe(0);

    const extraPackage = validateSimulation(
      `${installSimulation().replace(/0 upgraded,.+\n$/u, '')}Inst curl (9.0 Ubuntu:26.04/resolute [amd64])\n0 upgraded, 21 newly installed, 0 to remove and 16 not upgraded.\n`,
    );
    expect(extraPackage.status).toBe(2);
    expect(extraPackage.stderr).toContain('STOP simulation_closure');
  });

  it('rejects version drift and any upgrade in the accepted install plan', () => {
    const drifted = structuredClone(contract.apt.packages);
    drifted[0]!.version = '8.0.0-2';
    const versionResult = validateSimulation(installSimulation(drifted));
    expect(versionResult.status).toBe(2);
    expect(versionResult.stderr).toContain('STOP simulation_version');

    const upgradeResult = validateSimulation(
      installSimulation(
        contract.apt.packages,
        '1 upgraded, 19 newly installed, 0 to remove and 16 not upgraded.',
      ),
    );
    expect(upgradeResult.status).toBe(2);
    expect(upgradeResult.stderr).toContain('STOP simulation_summary');
  });

  it('accepts rollback only when the exact bootstrap closure is purged', () => {
    const exact = `${contract.apt.packages.map(({ name }) => `Purg ${name}`).join('\n')}\n`;
    expect(validateSimulation(exact, 'remove').status).toBe(0);

    const expanded = validateSimulation(`${exact}Purg openssh-server\n`, 'remove');
    expect(expanded.status).toBe(2);
    expect(expanded.stderr).toContain('STOP rollback_simulation_closure');
  });

  it('keeps live package inputs fixed and disables apt lifecycle snippets', () => {
    const source = readFileSync(controller, 'utf8');
    for (const required of [
      'Dir::Etc::main=/dev/null',
      'Dir::Etc::parts=-',
      'Dir::State::lists=',
      'Acquire::AllowInsecureRepositories=false',
      '"--yes", "update"',
      'DPkg::Lock::Timeout=30',
      'NEEDRESTART_SUSPEND',
      'POLICY_BYTES',
      '--no-download',
      'package_lifecycle_script',
      'package_service_payload',
      'source_not_clean',
    ]) {
      expect(source).toContain(required);
    }
    expect(source).not.toContain('Debug::NoLocking');
  });

  it('does not import a shadow standard-library module beside the controller', () => {
    const directory = temporaryDirectory();
    const copiedController = join(directory, 'control.py');
    const contractPath = join(directory, 'contract.json');
    copyFileSync(controller, copiedController);
    writeFileSync(contractPath, contractSource);
    writeFileSync(join(directory, 'json.py'), 'raise RuntimeError("shadow module executed")\n');

    const result = invoke(['validate-contract', '--contract', contractPath], copiedController);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('shadow module executed');
  });
});
