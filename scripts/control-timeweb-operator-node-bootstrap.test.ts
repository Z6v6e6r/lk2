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
  const installs = packages
    .map(
      ({ name, version, architecture }) =>
        `Inst ${name} (${version} Ubuntu:26.04/resolute [${architecture}])`,
    )
    .join('\n');
  const configurations = packages
    .map(
      ({ name, version, architecture }) =>
        `Conf ${name} (${version} Ubuntu:26.04/resolute [${architecture}])`,
    )
    .join('\n');
  return `${installs}\n${configurations}\n${summary}\n`;
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

    const configured = validateSimulation(`${exact}Conf openssh-server (1.0)\n`, 'remove');
    expect(configured.status).toBe(2);
    expect(configured.stderr).toContain('STOP rollback_simulation_closure');
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
      '--recover-failed-apply',
      'FAILED_APPLY_ROLLED_BACK',
      'failed_apply_rollback_scope_drift',
      'RECOVERABLE_REMOVAL_STATUSES',
      'recovery_removal_state',
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

  it('binds failed-apply rollback to the observed subset and resumable phases', () => {
    const directory = temporaryDirectory();
    const contractPath = join(directory, 'contract.json');
    writeFileSync(contractPath, contractSource);
    const program = [
      'import importlib.util, json, pathlib, sys',
      'spec = importlib.util.spec_from_file_location("controller", sys.argv[1])',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'contract = module.validate_contract(module.read_json(pathlib.Path(sys.argv[2]), "contract"))',
      'names = [item["name"] for item in contract["apt"]["packages"]]',
      'source_sha = "a" * 40',
      'source_tree = "b" * 40',
      'transaction = {"schema": module.TRANSACTION_SCHEMA, "operation": "apply", "phase": "postcondition_failed", "planId": "plan", "sourceSha": source_sha, "sourceTree": source_tree, "protectedServices": {}, "rebootRequired": False, "failureReason": "node_identity"}',
      'module.read_json = lambda *args, **kwargs: transaction',
      'module.recover_policy_guard = lambda *_args: None',
      'module.load_plan = lambda *_args: {"planId": "plan"}',
      'module.verify_artifacts = lambda *_args: []',
      'module.recoverable_present_packages = lambda *_args: set(names[:2])',
      'module.recoverable_removal_present_packages = lambda *_args: set(names[:2])',
      'module.removal_simulation = lambda _contract, packages: "\\n".join("Purg " + name for name in sorted(packages)) + "\\n"',
      'writes = []',
      'purges = []',
      'module.transaction_write = lambda _contract, value: writes.append(dict(value))',
      'module.purge_command = lambda _contract, packages: purges.append(sorted(packages))',
      'module.finalize_failed_apply_rollback = lambda _contract, value: {"status": "FAILED_APPLY_ROLLED_BACK", "phase": value["phase"], "authorized": value["authorizedPackages"]}',
      'result = module.failed_apply_rollback_mode(contract, source_sha, source_tree)',
      'assert result == {"status": "FAILED_APPLY_ROLLED_BACK", "phase": "removed", "authorized": sorted(names[:2])}',
      'assert [value["phase"] for value in writes] == ["prepared", "removing", "removed"]',
      'assert purges == [sorted(names[:2])]',
      'initial_phases = [value["phase"] for value in writes]',
      'initial_purges = list(purges)',
      'resumed = dict(transaction)',
      'resumed["phase"] = "removing"',
      'writes.clear()',
      'purges.clear()',
      'module.recoverable_removal_present_packages = lambda *_args: {names[1]}',
      'resumed_result = module.continue_failed_apply_rollback(contract, resumed)',
      'assert resumed_result["phase"] == "removed"',
      'assert [value["phase"] for value in writes] == ["removing", "removed"]',
      'assert purges == [[names[1]]]',
      'completed = dict(resumed)',
      'completed["phase"] = "removed"',
      'writes.clear()',
      'purges.clear()',
      'module.recoverable_removal_present_packages = lambda *_args: (_ for _ in ()).throw(AssertionError("removed phase inspected dpkg"))',
      'completed_result = module.continue_failed_apply_rollback(contract, completed)',
      'assert completed_result["phase"] == "removed" and not writes and not purges',
      'drifted = dict(transaction)',
      'drifted.update({"operation": "failed_apply_rollback", "phase": "removing", "authorizedPackages": [names[0]], "latestSimulationPackages": [names[0]], "originalFailureReason": "node_identity"})',
      'module.recoverable_removal_present_packages = lambda *_args: set(names[:2])',
      'try:',
      '    module.continue_failed_apply_rollback(contract, drifted)',
      'except module.Stop as error:',
      '    assert str(error) == "failed_apply_rollback_scope_drift"',
      'else:',
      '    raise AssertionError("expanded rollback scope accepted")',
      'print(json.dumps({"status": result["status"], "phases": initial_phases, "purges": initial_purges}))',
    ].join('\n');
    const result = spawnSync(
      'python3',
      ['-I', '-S', '-B', '-c', program, resolve(controller), contractPath],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      status: 'FAILED_APPLY_ROLLED_BACK',
      phases: ['prepared', 'removing', 'removed'],
      purges: [
        contract.apt.packages
          .slice(0, 2)
          .map(({ name }) => name)
          .sort(),
      ],
    });
  });

  it('rejects the destructive recovery flag outside rollback mode', () => {
    const directory = temporaryDirectory();
    const contractPath = join(directory, 'contract.json');
    writeFileSync(contractPath, contractSource);
    const result = invoke([
      'validate-contract',
      '--contract',
      contractPath,
      '--recover-failed-apply',
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('STOP live_override_forbidden');
  });

  it('accepts only exact safe dpkg removal-intermediate states', () => {
    const directory = temporaryDirectory();
    const contractPath = join(directory, 'contract.json');
    writeFileSync(contractPath, contractSource);
    const program = [
      'import importlib.util, json, pathlib, sys',
      'spec = importlib.util.spec_from_file_location("controller", sys.argv[1])',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'contract = module.validate_contract(module.read_json(pathlib.Path(sys.argv[2]), "contract"))',
      'packages = contract["apt"]["packages"]',
      'def value(item, status):',
      '    return {"status": status, "version": item["version"], "architecture": item["architecture"]}',
      'state = {item["name"]: None for item in packages}',
      'state[packages[0]["name"]] = value(packages[0], "ii ")',
      'state[packages[1]["name"]] = value(packages[1], "pi ")',
      'state[packages[2]["name"]] = value(packages[2], "rc ")',
      'module.installed_state = lambda *_args: state',
      'present = module.recoverable_removal_present_packages(contract)',
      'assert present == {packages[0]["name"], packages[1]["name"], packages[2]["name"]}',
      'state[packages[1]["name"]] = value(packages[1], "piR")',
      'try:',
      '    module.recoverable_removal_present_packages(contract)',
      'except module.Stop as error:',
      '    assert str(error) == "recovery_removal_state"',
      'else:',
      '    raise AssertionError("dpkg error state accepted")',
      'state[packages[1]["name"]] = value(packages[1], "pi ")',
      'state[packages[1]["name"]]["version"] = "unexpected"',
      'try:',
      '    module.recoverable_removal_present_packages(contract)',
      'except module.Stop as error:',
      '    assert str(error) == "recovery_removal_state"',
      'else:',
      '    raise AssertionError("version drift accepted")',
      'print(json.dumps(sorted(present)))',
    ].join('\n');
    const result = spawnSync(
      'python3',
      ['-I', '-S', '-B', '-c', program, resolve(controller), contractPath],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      contract.apt.packages
        .slice(0, 3)
        .map(({ name }) => name)
        .sort(),
    );
  });

  it('persists the failed-apply rollback receipt before guard cleanup', () => {
    const directory = temporaryDirectory();
    const contractPath = join(directory, 'contract.json');
    const transactionPath = join(directory, 'transaction.json');
    const receiptPath = join(directory, 'rollback-receipt.json');
    writeFileSync(contractPath, contractSource);
    writeFileSync(transactionPath, '{}\n');
    const program = [
      'import importlib.util, json, pathlib, sys',
      'spec = importlib.util.spec_from_file_location("controller", sys.argv[1])',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'contract = module.validate_contract(module.read_json(pathlib.Path(sys.argv[2]), "contract"))',
      'contract["state"]["transactionPath"] = sys.argv[3]',
      'contract["state"]["rollbackReceiptPath"] = sys.argv[4]',
      'contract["node"]["path"] = str(pathlib.Path(sys.argv[3]).parent / "absent-node")',
      'module.require_secure_directory = lambda *_args: None',
      'module.installed_state = lambda value: {item["name"]: None for item in value["apt"]["packages"]}',
      'module.service_snapshot = lambda *_args: {"units": {}, "listenersSha256": "0" * 64}',
      'module.reboot_state = lambda *_args: False',
      'events = []',
      'module.remove_policy_guard = lambda *_args: events.append("guard_removed")',
      'transaction = {"planId": "plan", "sourceSha": "a" * 40, "sourceTree": "b" * 40, "originalFailureReason": "node_identity", "authorizedSimulationSha256": "c" * 64, "authorizedPackages": [contract["apt"]["packages"][0]["name"]], "latestSimulationSha256": "d" * 64, "latestSimulationPackages": [contract["apt"]["packages"][0]["name"]], "simulationAttemptCount": 2, "protectedServices": {"units": {}, "listenersSha256": "0" * 64}, "rebootRequired": False}',
      'result = module.finalize_failed_apply_rollback(contract, transaction)',
      'receipt = module.read_json(pathlib.Path(sys.argv[4]), "receipt")',
      'assert receipt["status"] == "FAILED_APPLY_ROLLED_BACK"',
      'assert receipt["authorizedPackages"] == transaction["authorizedPackages"]',
      'assert receipt["authorizedSimulationSha256"] == "c" * 64',
      'assert receipt["latestSimulationSha256"] == "d" * 64',
      'assert receipt["latestSimulationPackages"] == transaction["authorizedPackages"]',
      'assert receipt["simulationAttemptCount"] == 2',
      'assert events == ["guard_removed"]',
      'assert not pathlib.Path(sys.argv[3]).exists()',
      'print(json.dumps(result))',
    ].join('\n');
    const result = spawnSync(
      'python3',
      [
        '-I',
        '-S',
        '-B',
        '-c',
        program,
        resolve(controller),
        contractPath,
        transactionPath,
        receiptPath,
      ],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      status: 'FAILED_APPLY_ROLLED_BACK',
      planId: 'plan',
      packageCount: 1,
    });
  });

  it('keeps normal apply and rollback receipts immutable across cleanup crashes', () => {
    const directory = temporaryDirectory();
    const contractPath = join(directory, 'contract.json');
    const transactionPath = join(directory, 'transaction.json');
    const receiptPath = join(directory, 'receipt.json');
    const rollbackReceiptPath = join(directory, 'rollback-receipt.json');
    writeFileSync(contractPath, contractSource);
    writeFileSync(transactionPath, '{}\n');
    const program = [
      'import importlib.util, json, pathlib, sys',
      'spec = importlib.util.spec_from_file_location("controller", sys.argv[1])',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'contract = module.validate_contract(module.read_json(pathlib.Path(sys.argv[2]), "contract"))',
      'transaction_path = pathlib.Path(sys.argv[3])',
      'receipt_path = pathlib.Path(sys.argv[4])',
      'rollback_receipt_path = pathlib.Path(sys.argv[5])',
      'contract["state"]["transactionPath"] = str(transaction_path)',
      'contract["state"]["receiptPath"] = str(receipt_path)',
      'contract["state"]["rollbackReceiptPath"] = str(rollback_receipt_path)',
      'contract["node"]["path"] = str(transaction_path.parent / "absent-node")',
      'module.require_secure_directory = lambda *_args: None',
      'module.require_secure_file = lambda path, *_args: path.lstat()',
      'node = {"execPath": "/usr/bin/node", "platform": "linux", "architecture": "x64", "version": "22.0.0", "resolvedPath": "/usr/bin/node", "sha256": "1" * 64, "packageOwner": "nodejs"}',
      'snapshot = {"units": {}, "listenersSha256": "2" * 64}',
      'module.require_installed_closure = lambda *_args: {}',
      'module.node_observation = lambda *_args: node',
      'module.apt_lists_snapshot = lambda *_args: []',
      'module.service_snapshot = lambda *_args: snapshot',
      'module.reboot_state = lambda *_args: False',
      'plan = {"planId": "plan", "sourceSha": "a" * 40, "sourceTree": "b" * 40, "contractSha256": "3" * 64, "aptTrust": {}, "aptListsSha256": module.sha256_bytes(module.canonical_bytes([])), "aptLists": [], "simulationSha256": "4" * 64, "uriPlanSha256": "5" * 64, "artifacts": []}',
      'apply_transaction = {"planId": "plan", "sourceSha": "a" * 40, "sourceTree": "b" * 40, "protectedServices": snapshot, "rebootRequired": False}',
      'guard_calls = []',
      'def crash_first_guard(*_args):',
      '    guard_calls.append("called")',
      '    if len(guard_calls) == 1:',
      '        raise module.Stop("cleanup_crash")',
      'module.remove_policy_guard = crash_first_guard',
      'try:',
      '    module.finalize_apply(contract, plan, apply_transaction)',
      'except module.Stop as error:',
      '    assert str(error) == "cleanup_crash"',
      'else:',
      '    raise AssertionError("apply cleanup crash not injected")',
      'apply_receipt_bytes = receipt_path.read_bytes()',
      'assert transaction_path.exists() and "applyCompletedAt" in apply_transaction',
      'bad_apply_receipt = module.read_json(receipt_path, "bad_apply")',
      'bad_apply_receipt["completedAt"] = "mismatch"',
      'receipt_path.write_bytes(module.canonical_bytes(bad_apply_receipt))',
      'try:',
      '    module.finalize_apply(contract, plan, apply_transaction)',
      'except module.Stop as error:',
      '    assert str(error) == "apply_receipt_identity"',
      'else:',
      '    raise AssertionError("mismatched apply receipt accepted")',
      'assert len(guard_calls) == 1 and transaction_path.exists()',
      'receipt_path.write_bytes(apply_receipt_bytes)',
      'apply_result = module.finalize_apply(contract, plan, apply_transaction)',
      'assert apply_result["status"] == "INSTALLED"',
      'assert receipt_path.read_bytes() == apply_receipt_bytes and not transaction_path.exists()',
      'original_receipt = module.read_json(receipt_path, "receipt")',
      'transaction_path.write_text("{}\\n")',
      'rollback_transaction = {"phase": "removed", "planId": "plan", "sourceSha": "a" * 40, "sourceTree": "b" * 40, "protectedServices": snapshot, "rebootRequired": False, "installReceiptSha256": module.sha256_bytes(module.canonical_bytes(original_receipt)), "authorizedSimulationSha256": "6" * 64, "authorizedPackages": sorted(item["name"] for item in contract["apt"]["packages"]), "latestSimulationSha256": "7" * 64, "latestSimulationPackages": [], "simulationAttemptCount": 2}',
      'module.installed_state = lambda value: {item["name"]: None for item in value["apt"]["packages"]}',
      'guard_calls.clear()',
      'try:',
      '    module.finalize_rollback(contract, original_receipt, rollback_transaction)',
      'except module.Stop as error:',
      '    assert str(error) == "cleanup_crash"',
      'else:',
      '    raise AssertionError("rollback cleanup crash not injected")',
      'rollback_receipt_bytes = rollback_receipt_path.read_bytes()',
      'rolled_install_receipt_bytes = receipt_path.read_bytes()',
      'assert transaction_path.exists() and "rollbackCompletedAt" in rollback_transaction',
      'rolled_receipt = module.read_json(receipt_path, "rolled_receipt")',
      'bad_rollback_receipt = module.read_json(rollback_receipt_path, "bad_rollback")',
      'bad_rollback_receipt["completedAt"] = "mismatch"',
      'rollback_receipt_path.write_bytes(module.canonical_bytes(bad_rollback_receipt))',
      'try:',
      '    module.finalize_rollback(contract, rolled_receipt, rollback_transaction)',
      'except module.Stop as error:',
      '    assert str(error) == "rollback_receipt_identity"',
      'else:',
      '    raise AssertionError("mismatched rollback receipt accepted")',
      'assert len(guard_calls) == 1 and transaction_path.exists()',
      'rollback_receipt_path.write_bytes(rollback_receipt_bytes)',
      'rollback_result = module.finalize_rollback(contract, rolled_receipt, rollback_transaction)',
      'assert rollback_result["status"] == "ROLLED_BACK"',
      'assert rollback_receipt_path.read_bytes() == rollback_receipt_bytes',
      'assert receipt_path.read_bytes() == rolled_install_receipt_bytes',
      'assert not transaction_path.exists()',
      'print(json.dumps({"apply": apply_result["status"], "rollback": rollback_result["status"], "guardCalls": len(guard_calls)}))',
    ].join('\n');
    const result = spawnSync(
      'python3',
      [
        '-I',
        '-S',
        '-B',
        '-c',
        program,
        resolve(controller),
        contractPath,
        transactionPath,
        receiptPath,
        rollbackReceiptPath,
      ],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      apply: 'INSTALLED',
      rollback: 'ROLLED_BACK',
      guardCalls: 2,
    });
  });

  it('rejects a stale normal rollback receipt before any rollback mutation', () => {
    const directory = temporaryDirectory();
    const contractPath = join(directory, 'contract.json');
    const transactionPath = join(directory, 'transaction.json');
    const receiptPath = join(directory, 'receipt.json');
    const rollbackReceiptPath = join(directory, 'rollback-receipt.json');
    const policyPath = join(directory, 'policy-rc.d');
    const policyPendingPath = join(directory, 'policy-rc.d.pending');
    writeFileSync(contractPath, contractSource);
    const program = [
      'import importlib.util, pathlib, sys',
      'spec = importlib.util.spec_from_file_location("controller", sys.argv[1])',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'contract = module.validate_contract(module.read_json(pathlib.Path(sys.argv[2]), "contract"))',
      'transaction_path = pathlib.Path(sys.argv[3])',
      'receipt_path = pathlib.Path(sys.argv[4])',
      'rollback_receipt_path = pathlib.Path(sys.argv[5])',
      'policy_path = pathlib.Path(sys.argv[6])',
      'policy_pending_path = pathlib.Path(sys.argv[7])',
      'contract["state"]["transactionPath"] = str(transaction_path)',
      'contract["state"]["receiptPath"] = str(receipt_path)',
      'contract["state"]["rollbackReceiptPath"] = str(rollback_receipt_path)',
      'contract["lifecycle"]["policyRcPath"] = str(policy_path)',
      'contract["lifecycle"]["policyRcPendingPath"] = str(policy_pending_path)',
      'events = []',
      'module.transaction_write = lambda *_args: events.append("transaction")',
      'module.create_policy_guard = lambda *_args: events.append("guard")',
      'module.purge_command = lambda *_args: events.append("purge")',
      'def assert_rejected():',
      '    try:',
      '        module.rollback_mode(contract, "a" * 40, "b" * 40)',
      '    except module.Stop as error:',
      '        assert str(error) == "rollback_receipt_present"',
      '    else:',
      '        raise AssertionError("stale rollback receipt accepted")',
      '    assert events == []',
      '    assert not transaction_path.exists()',
      '    assert not policy_path.exists() and not policy_pending_path.exists()',
      'rollback_receipt_path.write_text("{}\\n")',
      'assert_rejected()',
      'rollback_receipt_path.unlink()',
      'rollback_receipt_path.symlink_to(rollback_receipt_path.parent / "missing-receipt")',
      'assert_rejected()',
    ].join('\n');
    const result = spawnSync(
      'python3',
      [
        '-I',
        '-S',
        '-B',
        '-c',
        program,
        resolve(controller),
        contractPath,
        transactionPath,
        receiptPath,
        rollbackReceiptPath,
        policyPath,
        policyPendingPath,
      ],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
    );

    expect(result.status, result.stderr).toBe(0);
  });
});
