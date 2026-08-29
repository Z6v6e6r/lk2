import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
      'os.link(pending, path, follow_symlinks=False)',
      'policyRcPendingPath',
      '--no-download',
      '--no-remove',
      '--no-upgrade',
      'transaction_phase',
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

  it('creates and verifies the lifecycle guard as 0755 under umask 077', () => {
    const directory = temporaryDirectory();
    const guard = join(directory, 'policy-rc.d');
    const pending = join(directory, '.policy-rc.d.pending');
    const program = [
      'import importlib.util, os, pathlib, sys',
      'spec = importlib.util.spec_from_file_location("controller", sys.argv[1])',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'os.umask(0o077)',
      'module.require_secure_directory = lambda *args: None',
      'contract = {"lifecycle": {"policyRcPath": sys.argv[2], "policyRcPendingPath": sys.argv[3]}}',
      'module.create_policy_guard(contract)',
      'guard = pathlib.Path(sys.argv[2])',
      'pending = pathlib.Path(sys.argv[3])',
      'print(oct(guard.stat().st_mode & 0o777), guard.stat().st_nlink, pending.exists(), guard.read_text())',
      'pathlib.Path(sys.argv[2]).unlink()',
    ].join('\n');
    const result = spawnSync(
      'python3',
      ['-I', '-S', '-B', '-c', program, resolve(controller), guard, pending],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('0o755 1 False #!/bin/sh\nexit 101');
  });

  it('recovers both lifecycle-guard publication crash points', () => {
    const directory = temporaryDirectory();
    const guard = join(directory, 'policy-rc.d');
    const pending = join(directory, '.policy-rc.d.pending');
    const program = [
      'import importlib.util, os, pathlib, stat, sys',
      'spec = importlib.util.spec_from_file_location("controller", sys.argv[1])',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'guard = pathlib.Path(sys.argv[2])',
      'pending = pathlib.Path(sys.argv[3])',
      'contract = {"lifecycle": {"policyRcPath": str(guard), "policyRcPendingPath": str(pending)}}',
      'module.require_secure_directory = lambda *args: None',
      'def candidate(path, links, code):',
      '    value = path.lstat()',
      '    assert stat.S_ISREG(value.st_mode) and value.st_nlink == links and stat.S_IMODE(value.st_mode) == 0o755',
      '    return value',
      'def final(_contract):',
      '    value = guard.lstat()',
      '    assert value.st_nlink == 1 and stat.S_IMODE(value.st_mode) == 0o755 and guard.read_bytes() == module.POLICY_BYTES',
      'module.require_policy_candidate = candidate',
      'module.require_policy_guard = final',
      'pending.write_bytes(b"partial")',
      'pending.chmod(0o755)',
      'module.recover_policy_guard(contract)',
      'assert guard.read_bytes() == module.POLICY_BYTES and not pending.exists()',
      'guard.unlink()',
      'pending.write_bytes(module.POLICY_BYTES)',
      'pending.chmod(0o755)',
      'os.link(pending, guard)',
      'module.recover_policy_guard(contract)',
      'assert guard.read_bytes() == module.POLICY_BYTES and guard.stat().st_nlink == 1 and not pending.exists()',
      'print("RECOVERED")',
    ].join('\n');
    const result = spawnSync(
      'python3',
      ['-I', '-S', '-B', '-c', program, resolve(controller), guard, pending],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('RECOVERED');
  });

  it('accepts only realistic exact full and partial recovery simulations', () => {
    const directory = temporaryDirectory();
    const contractPath = join(directory, 'contract.json');
    const simulationPath = join(directory, 'simulation.txt');
    writeFileSync(contractPath, contractSource);
    const absent = contract.apt.packages.slice(0, 2);
    const partial = contract.apt.packages.slice(2, 3);
    const configured = [...absent, ...partial];
    const program = [
      'import importlib.util, pathlib, sys',
      'spec = importlib.util.spec_from_file_location("controller", sys.argv[1])',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'contract = module.validate_contract(module.read_json(pathlib.Path(sys.argv[2]), "contract"))',
      'contents = pathlib.Path(sys.argv[3]).read_text()',
      'module.parse_install_subset(contents, contract, set(filter(None, sys.argv[4].split(","))), set(filter(None, sys.argv[5].split(","))))',
      'print("VALID")',
    ].join('\n');
    const fullTranscript = `${contract.apt.packages.map(({ name, version }) => `Inst ${name} (${version} Ubuntu:26.04/resolute [amd64])`).join('\n')}\n${contract.apt.packages.map(({ name, version }) => `Conf ${name} (${version} Ubuntu:26.04/resolute [amd64])`).join('\n')}\n0 upgraded, 20 newly installed, 0 to remove and 16 not upgraded.\n`;
    writeFileSync(simulationPath, fullTranscript);
    const full = spawnSync(
      'python3',
      [
        '-I',
        '-S',
        '-B',
        '-c',
        program,
        resolve(controller),
        contractPath,
        simulationPath,
        contract.apt.packages.map(({ name }) => name).join(','),
        '',
      ],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
    );
    expect(full.status, full.stderr).toBe(0);

    writeFileSync(
      simulationPath,
      `${absent.map(({ name, version }) => `Inst ${name} (${version} Ubuntu:26.04/resolute [amd64])`).join('\n')}\n${configured.map(({ name, version }) => `Conf ${name} (${version} Ubuntu:26.04/resolute [amd64])`).join('\n')}\n0 upgraded, 2 newly installed, 0 to remove and 16 not upgraded.\n`,
    );
    const accepted = spawnSync(
      'python3',
      [
        '-I',
        '-S',
        '-B',
        '-c',
        program,
        resolve(controller),
        contractPath,
        simulationPath,
        absent.map(({ name }) => name).join(','),
        partial.map(({ name }) => name).join(','),
      ],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
    );
    expect(accepted.status, accepted.stderr).toBe(0);

    writeFileSync(simulationPath, `${readFileSync(simulationPath, 'utf8')}Remv openssh-server\n`);
    const rejected = spawnSync(
      'python3',
      [
        '-I',
        '-S',
        '-B',
        '-c',
        program,
        resolve(controller),
        contractPath,
        simulationPath,
        absent.map(({ name }) => name).join(','),
        partial.map(({ name }) => name).join(','),
      ],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('recovery_apply_simulation');
  });
});
