import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const source = readFileSync('.github/workflows/pull-request.yaml', 'utf8');
const workflow = parse(source) as {
  readonly on: { readonly push: { readonly branches: readonly string[] } };
  readonly jobs: Readonly<
    Record<
      string,
      {
        readonly if?: string;
        readonly name?: string;
        readonly needs?: string | readonly string[];
        readonly services?: unknown;
        readonly steps?: readonly {
          readonly if?: string;
          readonly name?: string;
          readonly run?: string;
        }[];
      }
    >
  >;
};

describe('pull request CI profiles and stable gates', () => {
  it('requires the isolated physical game suites in the existing full-quality service job', () => {
    const steps = workflow.jobs['quality-full']?.steps ?? [];
    const required = steps.find(
      (step) => step.run === 'node --import tsx scripts/required-game-ci.ts',
    );
    expect(required).toBeDefined();
    expect(required?.if).toBeUndefined();
    expect(required).not.toHaveProperty('continue-on-error');
    expect(required).toHaveProperty('timeout-minutes', 12);
    expect(required).toHaveProperty(
      'env.CI_GAME_RABBIT_CONTAINER',
      '${{ job.services.rabbitmq.id }}',
    );
    const upload = steps.findIndex((step) => step.name === 'Upload test and coverage diagnostics');
    expect(upload).toBeGreaterThan(steps.indexOf(required!));
    expect(steps[upload]).toHaveProperty(
      'with.path',
      expect.stringContaining('.ci-artifacts/required-game'),
    );
  });

  it('runs the full contour on main and temporary integration branches only', () => {
    expect(workflow.on.push.branches).toEqual(['main', 'integration/**']);
    expect(source).not.toContain('workflow_dispatch');
  });

  it('always defines the stable aggregate contract', () => {
    for (const job of [
      'ci-plan',
      'source-quality',
      'quality',
      'dependency-security',
      'secret-scan',
      'deployment-contract',
      'docker-build',
      'pr-gate',
    ]) {
      expect(workflow.jobs[job]?.name, job).toBe(job);
    }
    expect(workflow.jobs['quality']?.if).toBe('${{ always() }}');
    expect(workflow.jobs['docker-build']?.if).toBe('${{ always() }}');
    expect(workflow.jobs['pr-gate']?.if).toBe('${{ always() }}');
  });

  it('keeps databases and brokers exclusive to full quality', () => {
    expect(workflow.jobs['quality-full']?.services).toBeTruthy();
    expect(workflow.jobs['source-quality']?.services).toBeUndefined();
    expect(workflow.jobs['quality-docs']?.services).toBeUndefined();
    expect(workflow.jobs['quality-web']?.services).toBeUndefined();
    expect(workflow.jobs['quality-docs']?.if).toContain("docs_quality == 'true'");
    expect(workflow.jobs['quality-web']?.if).toContain("web_quality == 'true'");
    expect(workflow.jobs['quality-full']?.if).toContain("full_quality == 'true'");
    expect(workflow.jobs['source-quality']?.if).toContain("full_quality == 'true'");
  });

  it('uses the planner for Docker and never publishes CI images', () => {
    expect(source).toContain('node scripts/select-pr-ci-profile.js');
    expect(source).toContain('PLANNED_SERVICES: ${{ needs.ci-plan.outputs.services }}');
    expect(source).toContain('push: false');
    expect(source).not.toContain('push: true');
  });

  it('runs Timeweb contracts only when explicitly planned and accepts only planned skips', () => {
    const deploymentSteps = workflow.jobs['deployment-contract']?.steps ?? [];
    expect(
      deploymentSteps.some(({ if: condition }) => condition?.includes('deployment_contract')),
    ).toBe(true);
    expect(workflow.jobs['timeweb-provenance-probe']?.if).toContain("provenance_probe == 'true'");
    expect(source).toContain('node scripts/verify-ci-plan.js conditional provenanceProbe');
  });

  it('uses bounded pinned BuildKit readiness diagnostics without publication authority', () => {
    expect(source).toContain('node scripts/verify-pinned-buildkit-bootstrap.js');
    expect(source).toContain('--version "$BUILDKIT_VERSION"');
    expect(source).toContain('$SERVICE-buildkit-bootstrap.json');
    expect(source).toContain('push: false');
    expect(source).not.toContain('docker buildx inspect --bootstrap | grep');
  });

  it('fails the final aggregate on missing, failed or cancelled stable results', () => {
    expect(source).toContain('node scripts/verify-ci-plan.js gate');
    expect(source).toContain('"ci-plan":"${{ needs.ci-plan.result }}"');
    expect(source).toContain('"secret-scan":"${{ needs.secret-scan.result }}"');
  });

  it('extends the exact-range secret scan to integration branches without weakening it', () => {
    expect(source).toContain('refs/heads/main|refs/heads/integration/*');
    expect(source).toContain('git fetch --no-tags origin main:refs/remotes/origin/main');
    expect(source).toContain('base_sha="$(git merge-base "$main_sha" "$head_sha")"');
    expect(source).toContain('A zero before SHA is allowed only for a new integration branch.');
    expect(source).toContain('--diff-merges=remerge $BASE_SHA..$HEAD_SHA');
    expect(source).toContain('--exit-code=2');
  });
});

describe('exact ephemeral provenance builder cleanup', () => {
  const cleanup = workflow.jobs['timeweb-provenance-probe']?.steps?.find(
    ({ name }) => name === 'Remove the ephemeral BuildKit builder',
  );
  const builder = 'phub-timeweb-pr-provenance-37300753114-1-api';

  function runCleanup(mode: string, target = builder) {
    const directory = mkdtempSync(join(tmpdir(), 'phub-provenance-cleanup-'));
    try {
      const docker = join(directory, 'docker');
      writeFileSync(
        docker,
        `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const directory = process.env.FIXTURE_DIRECTORY;
const target = ${JSON.stringify(builder)};
const container = 'buildx_buildkit_' + target + '0';
const volume = container + '_state';
const counter = directory + '/counter';
const calls = directory + '/calls';
fs.appendFileSync(calls, JSON.stringify(args) + '\\n');
let count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
if (args[0] === 'buildx' && args[1] === 'rm') {
  if (JSON.stringify(args) !== JSON.stringify(['buildx','rm','--force','--timeout','60s',target])) process.exit(90);
  fs.writeFileSync(counter, String(++count));
  process.exit(process.env.FIXTURE_MODE === 'persistent' || process.env.FIXTURE_MODE === 'partial' || count === 1 ? 1 : 0);
}
const residue = process.env.FIXTURE_MODE === 'persistent' || (process.env.FIXTURE_MODE === 'retry' && count < 2);
if (args[0] === 'buildx' && args[1] === 'ls') console.log('foreign-builder' + (residue ? '\\n' + target : ''));
else if (args[0] === 'ps') console.log('foreign-container' + (residue ? '\\n' + container : ''));
else if (args[0] === 'volume' && args[1] === 'ls') {
  if (process.env.FIXTURE_MODE === 'daemon-failure') process.exit(91);
  console.log('foreign-volume' + (residue ? '\\n' + volume : ''));
} else process.exit(92);
`,
      );
      chmodSync(docker, 0o700);
      // Avoid real waiting in this disposable command fixture.
      const sleep = join(directory, 'sleep');
      writeFileSync(sleep, '#!/bin/sh\nexit 0\n');
      chmodSync(sleep, 0o700);
      const result = spawnSync('/bin/bash', ['-c', cleanup!.run!], {
        env: {
          PATH: `${directory}:${process.env.PATH}`,
          BUILDER_NAME: target,
          GITHUB_RUN_ID: '37300753114',
          GITHUB_RUN_ATTEMPT: '1',
          SERVICE: 'api',
          FIXTURE_DIRECTORY: directory,
          FIXTURE_MODE: mode,
        },
        encoding: 'utf8',
        timeout: 10_000,
      });
      const callsPath = join(directory, 'calls');
      const calls = (() => {
        try {
          return readFileSync(callsPath, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as string[]);
        } catch {
          return [];
        }
      })();
      return { status: result.status, calls };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it('remains mandatory and verifies all exact residue after a timeout', () => {
    expect(cleanup?.if).toBe('${{ always() }}');
    const result = runCleanup('retry');
    expect(result.status).toBe(0);
    expect(result.calls.filter((args) => args[1] === 'rm')).toHaveLength(2);
    expect(result.calls.every((args) => args[1] !== 'rm' || args.at(-1) === builder)).toBe(true);
    expect(cleanup?.run).not.toContain('prune');
  });

  it('accepts a partial removal error only when builder, container and volume are absent', () => {
    const result = runCleanup('partial');
    expect(result.status).toBe(0);
    expect(result.calls.filter((args) => args[1] === 'rm')).toHaveLength(1);
  });

  it('fails after the bounded budget when exact residue persists', () => {
    const result = runCleanup('persistent');
    expect(result.status).toBe(1);
    expect(result.calls.filter((args) => args[1] === 'rm')).toHaveLength(3);
  });

  it('fails closed when Docker cannot enumerate remaining state', () => {
    expect(runCleanup('daemon-failure').status).not.toBe(0);
  });

  it('rejects a builder belonging to another run before any Docker command', () => {
    const result = runCleanup('retry', 'phub-timeweb-pr-provenance-37300753115-1-api');
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
  });
});

describe('immutable Buildx download recovery', () => {
  const bootstrap = workflow.jobs['timeweb-provenance-probe']?.steps?.find(
    ({ name }) =>
      name === 'Install pinned Buildx v0.36.1 and create pinned BuildKit v0.32.2 builder',
  )?.run;
  const url =
    'https://github.com/docker/buildx/releases/download/$BUILDX_VERSION/buildx-$BUILDX_VERSION.linux-amd64';
  const payload = 'synthetic-buildx-download\n';

  it('keeps immutable authority and bounds only transient download retries', () => {
    expect(bootstrap).toBeDefined();
    expect(bootstrap).toContain(url);
    expect(bootstrap).toContain("--proto '=https' --proto-redir '=https' --tlsv1.2");
    expect(bootstrap).toContain('--connect-timeout 10 --max-time 30');
    expect(bootstrap).toContain('--retry 3 --retry-delay 2 --retry-max-time 100');
    expect(bootstrap).toContain(`trap 'rm -f -- "$download"' EXIT`);
    expect(bootstrap).not.toContain('--retry-all-errors');
    expect(bootstrap!.indexOf('sha256sum --check --strict')).toBeLessThan(
      bootstrap!.indexOf('install -D'),
    );
    expect(bootstrap).toContain('docker buildx version');
    expect(source).toContain(
      'BUILDX_SHA256: 48af8a397ebd60178778bf63611dbcebe5f5e7a9be90eb9147b24b9587455778',
    );
  });

  async function fixture(statuses: number[], validChecksum = true) {
    const directory = mkdtempSync(join(tmpdir(), 'phub-buildx-download-'));
    let requests = 0;
    const server = createServer((_request, response) => {
      const status = statuses[Math.min(requests++, statuses.length - 1)] ?? 500;
      response.writeHead(status, { 'Content-Type': 'application/octet-stream' });
      response.end(status === 200 ? payload : 'synthetic-transient-error');
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('FIXTURE_ADDRESS');
      writeFileSync(join(directory, 'docker-buildx'), 'stale-partial-file');
      // Execute the real download+checksum shell against a disposable loopback HTTP fixture.
      // Only URL/protocol are substituted; retry/deadline/checksum/cleanup commands are unchanged.
      let script = bootstrap!
        .slice(0, bootstrap!.indexOf('install -D'))
        .replace('plugin="$HOME/.docker/cli-plugins/docker-buildx"\n', '')
        .replace(url, `http://127.0.0.1:${address.port}/immutable-fixture`)
        .replace(
          "--proto '=https' --proto-redir '=https'",
          "--proto '=http' --proto-redir '=http'",
        );
      // Darwin uses its native shasum checker; the one-line fixture still
      // runs its real checksum comparison. CI keeps --check --strict unchanged.
      if (process.platform === 'darwin')
        script = script.replace('sha256sum --check --strict', 'shasum -a 256 -c');
      let diagnostic = '';
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn('/bin/bash', ['-c', script], {
          env: {
            PATH: process.env.PATH,
            RUNNER_TEMP: directory,
            BUILDX_VERSION: 'v0.36.1',
            BUILDX_SHA256: validChecksum
              ? createHash('sha256').update(payload).digest('hex')
              : '0'.repeat(64),
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        child.stderr.on('data', (chunk: Buffer) => {
          diagnostic += chunk.toString();
        });
        const deadline = setTimeout(() => {
          child.kill('SIGKILL');
        }, 20000);
        child.once('error', (error) => {
          clearTimeout(deadline);
          reject(error);
        });
        child.once('exit', (exit) => {
          clearTimeout(deadline);
          resolve(exit);
        });
      });
      if (code !== 0 && statuses.includes(200) && validChecksum) throw Error(diagnostic);
      return {
        code,
        requests,
        temporaryDownloadRemoved: !existsSync(join(directory, 'docker-buildx')),
      };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it('recovers a 504 and replaces stale output before verifying the exact bytes', async () => {
    expect(await fixture([504, 200])).toEqual({
      code: 0,
      requests: 2,
      temporaryDownloadRemoved: true,
    });
  }, 30000);
  it('stops after the finite 504 retry budget and removes partial output', async () => {
    const result = await fixture([504]);
    expect(result.code).not.toBe(0);
    expect(result).toMatchObject({ requests: 4, temporaryDownloadRemoved: true });
  }, 30000);
  it('does not retry a permanent 403 or a checksum mismatch', async () => {
    for (const result of [await fixture([403]), await fixture([200], false)]) {
      expect(result.code).not.toBe(0);
      expect(result).toMatchObject({ requests: 1, temporaryDownloadRemoved: true });
    }
  }, 30000);
});
