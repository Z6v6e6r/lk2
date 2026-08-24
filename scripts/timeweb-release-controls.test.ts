import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const builder = fileURLToPath(new URL('./build-timeweb-install-bundle.sh', import.meta.url));
const executorSource = readFileSync(
  new URL('../deploy/timeweb/root-executor.sh', import.meta.url),
  'utf8',
);
const probeSource = readFileSync(new URL('./probe-timeweb-green.sh', import.meta.url), 'utf8');
const runbookSource = readFileSync(
  new URL('../docs/runbooks/timeweb-staging-migration.md', import.meta.url),
  'utf8',
);

function fixtureRepository() {
  const directory = mkdtempSync(join(tmpdir(), 'phub-timeweb-bundle-fixture-'));
  mkdirSync(join(directory, 'deploy/timeweb'), { recursive: true });
  mkdirSync(join(directory, 'scripts'), { recursive: true });
  mkdirSync(join(directory, 'nested'));
  mkdirSync(join(directory, 'contracts/openapi'), { recursive: true });
  writeFileSync(join(directory, 'file.txt'), 'committed-content\n');
  writeFileSync(join(directory, 'executable.sh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(directory, 'executable.sh'), 0o755);
  writeFileSync(join(directory, 'nested/entry.txt'), 'nested-content\n');
  writeFileSync(join(directory, 'contracts/openapi/contract.yaml'), 'version: application\n');
  copyFileSync(builder, join(directory, 'scripts/build-timeweb-install-bundle.sh'));
  chmodSync(join(directory, 'scripts/build-timeweb-install-bundle.sh'), 0o755);
  execFileSync('git', ['init', '-q'], { cwd: directory });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: directory });
  execFileSync('git', ['config', 'user.name', 'Timeweb Test'], { cwd: directory });
  execFileSync('git', ['add', '.'], { cwd: directory });
  execFileSync('git', ['commit', '-qm', 'application candidate'], {
    cwd: directory,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  });
  const applicationSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: directory,
    encoding: 'utf8',
  }).trim();
  writeFileSync(
    join(directory, 'deploy/timeweb/application-candidate.env'),
    `PHUB_APPLICATION_SHA=${applicationSha}\n`,
  );
  writeFileSync(
    join(directory, 'deploy/timeweb/install-manifest.txt'),
    'deploy/timeweb/application-candidate.env\nfile.txt\nexecutable.sh\nnested\n',
  );
  execFileSync('git', ['add', '.'], { cwd: directory });
  execFileSync('git', ['commit', '-qm', 'operations candidate'], { cwd: directory });
  return directory;
}

describe('Timeweb deterministic release controls', () => {
  it('builds the same exact-commit archive and file manifest despite dirty working files', () => {
    const repository = fixtureRepository();
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim();
    const first = join(repository, 'out-first');
    const second = join(repository, 'out-second');
    mkdirSync(first);
    mkdirSync(second);

    execFileSync('sh', [join(repository, 'scripts/build-timeweb-install-bundle.sh'), sha, first], {
      cwd: repository,
    });
    writeFileSync(join(repository, 'file.txt'), 'dirty-content-must-not-enter-bundle\n');
    writeFileSync(
      join(repository, 'contracts/openapi/contract.yaml'),
      'version: dirty-working-tree\n',
    );
    execFileSync('sh', [join(repository, 'scripts/build-timeweb-install-bundle.sh'), sha, second], {
      cwd: repository,
    });

    for (const artifact of [
      `timeweb-ops-${sha}.tar.gz`,
      `timeweb-application-contracts-${sha}.tar.gz`,
      `timeweb-ops-${sha}.files.sha256`,
      `timeweb-ops-${sha}.receipt`,
      `timeweb-ops-${sha}.artifacts.sha256`,
    ]) {
      expect(readFileSync(join(first, artifact))).toEqual(readFileSync(join(second, artifact)));
    }
    const applicationSha = readFileSync(
      join(repository, 'deploy/timeweb/application-candidate.env'),
      'utf8',
    )
      .trim()
      .split('=')[1];
    expect(applicationSha).toMatch(/^[0-9a-f]{40}$/u);
    if (applicationSha === undefined) throw new Error('application SHA fixture is absent');
    const filesManifest = readFileSync(join(first, `timeweb-ops-${sha}.files.sha256`), 'utf8');
    expect(filesManifest).toMatch(new RegExp(`^0644\\|[0-9a-f]{64}\\|${sha}\\|file\\.txt$`, 'mu'));
    expect(filesManifest).toMatch(
      new RegExp(`^0755\\|[0-9a-f]{64}\\|${sha}\\|executable\\.sh$`, 'mu'),
    );
    expect(filesManifest).toMatch(
      new RegExp(`^0644\\|[0-9a-f]{64}\\|${sha}\\|nested/entry\\.txt$`, 'mu'),
    );
    expect(filesManifest).toMatch(
      new RegExp(
        `^0644\\|[0-9a-f]{64}\\|${applicationSha}\\|contracts/openapi/contract\\.yaml$`,
        'mu',
      ),
    );
    expect(filesManifest).not.toContain('dirty-content-must-not-enter-bundle');

    const extracted = join(repository, 'extracted');
    mkdirSync(extracted);
    execFileSync('tar', ['-xzf', join(first, `timeweb-ops-${sha}.tar.gz`), '-C', extracted]);
    execFileSync('tar', [
      '-xzf',
      join(first, `timeweb-application-contracts-${sha}.tar.gz`),
      '-C',
      extracted,
    ]);
    for (const relativePath of [
      'file.txt',
      'executable.sh',
      'nested/entry.txt',
      'contracts/openapi/contract.yaml',
    ]) {
      chmodSync(join(extracted, relativePath), 0o600);
    }
    for (const line of filesManifest.trim().split('\n')) {
      const fields = line.split('|');
      expect(fields).toHaveLength(4);
      const mode = fields[0];
      const relativePath = fields[3];
      if (mode === undefined || relativePath === undefined) {
        throw new Error('invalid custody manifest fixture');
      }
      chmodSync(join(extracted, relativePath), Number.parseInt(mode, 8));
    }
    expect(statSync(join(extracted, 'file.txt')).mode & 0o777).toBe(0o644);
    expect(statSync(join(extracted, 'executable.sh')).mode & 0o777).toBe(0o755);
    expect(statSync(join(extracted, 'nested/entry.txt')).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(extracted, 'contracts/openapi/contract.yaml'), 'utf8')).toBe(
      'version: application\n',
    );
  });

  it('fails closed when the commit manifest names an absent path', () => {
    const repository = fixtureRepository();
    writeFileSync(
      join(repository, 'deploy/timeweb/install-manifest.txt'),
      'file.txt\nmissing.txt\n',
    );
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'invalid manifest'], { cwd: repository });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim();
    const output = join(repository, 'out');
    mkdirSync(output);
    const result = spawnSync(
      'sh',
      [join(repository, 'scripts/build-timeweb-install-bundle.sh'), sha, output],
      {
        cwd: repository,
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('manifest_entry_absent');
  });

  it('rejects a working-tree builder that differs from the approved commit', () => {
    const repository = fixtureRepository();
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim();
    writeFileSync(
      join(repository, 'scripts/build-timeweb-install-bundle.sh'),
      `${readFileSync(builder, 'utf8')}\n# dirty\n`,
    );
    chmodSync(join(repository, 'scripts/build-timeweb-install-bundle.sh'), 0o755);
    const output = join(repository, 'out');
    mkdirSync(output);
    const result = spawnSync(
      'sh',
      [join(repository, 'scripts/build-timeweb-install-bundle.sh'), sha, output],
      { cwd: repository, encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dirty_builder');
  });

  it('ignores local Git replace refs when reading the approved commit', () => {
    const repository = fixtureRepository();
    const approvedSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim();
    writeFileSync(join(repository, 'file.txt'), 'replacement-content\n');
    execFileSync('git', ['add', 'file.txt'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'replacement'], { cwd: repository });
    const replacementSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['replace', approvedSha, replacementSha], { cwd: repository });
    const output = join(repository, 'out');
    mkdirSync(output);

    execFileSync(
      'sh',
      [join(repository, 'scripts/build-timeweb-install-bundle.sh'), approvedSha, output],
      { cwd: repository },
    );
    const extracted = join(repository, 'replace-extracted');
    mkdirSync(extracted);
    execFileSync(
      'tar',
      ['-xzf', join(output, `timeweb-ops-${approvedSha}.tar.gz`), '-C', extracted],
      { cwd: repository },
    );
    expect(readFileSync(join(extracted, 'file.txt'), 'utf8')).toBe('committed-content\n');
  });

  it('limits the root executor to explicit operations and preserves volumes on rollback', () => {
    for (const operation of [
      'install-bundle',
      'preflight',
      'rollback-ops',
      'status',
      'probe',
      'start-infrastructure',
      'start-application-dark',
      'start-ingress',
      'rollback-green',
    ]) {
      expect(executorSource).toContain(`${operation})`);
    }
    expect(executorSource).toContain('files_manifest_metadata');
    expect(executorSource).toContain('verify_release_files');
    expect(executorSource).toContain('timeweb-application-contracts-$install_ops_sha.tar.gz');
    expect(executorSource).toContain('candidate_application_binding');
    expect(executorSource).toContain('PHUB_TIMEWEB_OPS_BUNDLE_V2');
    expect(executorSource).toContain('chmod "$install_mode" "$release_file"');
    expect(executorSource).toContain('PHUB_TIMEWEB_ROOT_AUTHORIZATION_V1');
    expect(executorSource).toContain('flock -n 9');
    expect(executorSource).toContain('audit_event AUTHORIZED');
    expect(executorSource).toContain('terminal_audit');
    expect(executorSource).toContain('audit_event FAILED');
    expect(executorSource).toContain('authorization_replayed');
    expect(executorSource).toContain(
      'app_compose --profile worker --profile migration config --quiet',
    );
    expect(executorSource).toContain(
      'app_compose --profile worker --profile migration stop migrator worker api realtime web',
    );
    expect(executorSource).toContain('volumes_preserved=true');
    expect(executorSource).toContain('containers_changed=false');
    expect(executorSource).toContain('rollback_incomplete');
    expect(executorSource).toContain('DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG');
    expect(executorSource).toContain('HTTP_PROXY HTTPS_PROXY ALL_PROXY');
    expect(executorSource).not.toMatch(/\bdocker\s+compose\b[^\n]*\bdown\b/u);
    expect(executorSource).not.toMatch(/\b(?:rm|volume rm|system prune)\b/u);
    expect(executorSource).not.toMatch(/\bup\b[^\n]*\bmigrator\b/u);
  });

  it('requires the custody builder to be extracted from the approved commit', () => {
    expect(runbookSource).toContain(
      '/usr/bin/git show "$ops_sha:scripts/build-timeweb-install-bundle.sh"',
    );
    expect(runbookSource).toContain('git fsck --full');
    expect(runbookSource).toContain('reconstructs every');
    expect(runbookSource).toContain('No hash printed only by the builder');
    expect(runbookSource).not.toContain(
      'sh scripts/build-timeweb-install-bundle.sh <40-character-ops-sha>',
    );
  });

  it('keeps probes aggregate-only and enforces the cutover resource budgets', () => {
    expect(probeSource).toContain('disk_free_below_20_gib');
    expect(probeSource).toContain('disk_usage_above_budget');
    expect(probeSource).toContain('memory_usage_above_budget');
    expect(probeSource).toContain('swap_usage_above_budget');
    expect(probeSource).toContain('cpu_usage_above_budget');
    expect(probeSource).toContain('RestartCount');
    expect(probeSource).toContain('OOMKilled');
    expect(probeSource).toContain('.State.Health.Status');
    expect(probeSource).toContain('prometheus_otel_target_down');
    expect(probeSource).toContain('database_pool_above_budget');
    expect(probeSource).toContain('rabbitmq_backlog_nonzero');
    expect(probeSource).toContain('redis_authenticated_ping');
    expect(probeSource).toContain('nginx_5xx_observed');
    expect(probeSource).toContain('secrets_printed=false');
    expect(probeSource).toContain('DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG');
    expect(probeSource).toContain('HTTP_PROXY HTTPS_PROXY ALL_PROXY');
    expect(probeSource).not.toContain('docker inspect --format {{json .Config.Env}}');
  });
});
