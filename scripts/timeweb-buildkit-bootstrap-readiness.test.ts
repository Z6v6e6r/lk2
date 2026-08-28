import { spawnSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const helper = fileURLToPath(new URL('./timeweb-buildkit-bootstrap-readiness.sh', import.meta.url));
const expectedImage =
  'moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8';
const expectedVersion = 'v0.32.2';
const expectedBuildxVersionLine =
  'github.com/docker/buildx v0.36.1 1d8dde89b8aba914e05e45366770736fea1fd690';
const directories: string[] = [];

interface InspectResult {
  readonly status: number;
  readonly stderr?: string;
  readonly version?: string;
}

interface Scenario {
  readonly containerIds?: readonly string[];
  readonly containerImage?: string;
  readonly containerRunning?: boolean;
  readonly containerState?: string;
  readonly inspections: readonly InspectResult[];
  readonly termIgnoringInspect?: boolean;
}

interface Execution {
  readonly diagnosticDirectory: string;
  readonly directory: string;
  readonly stderr: string;
  readonly stdout: string;
  readonly status: number | null;
}

const fakeDocker = `#!/usr/bin/env bash
set -euo pipefail
state_dir="\${FAKE_DOCKER_STATE_DIR:?}"
printf '%s\\n' "$*" >> "$state_dir/commands.log"
if [[ "\${1:-}" = buildx && "\${2:-}" = version ]]; then
  printf '%s\\n' '${expectedBuildxVersionLine}'
  exit 0
fi
if [[ "\${1:-}" = buildx && "\${2:-}" = inspect ]]; then
  count=0
  if [[ -f "$state_dir/inspect-count" ]]; then count="$(<"$state_dir/inspect-count")"; fi
  count=$((count + 1))
  printf '%s\\n' "$count" > "$state_dir/inspect-count"
  selected="$count"
  if [[ ! -f "$state_dir/inspect-$selected.status" ]]; then
    selected="$(<"$state_dir/inspect-total")"
  fi
  cat "$state_dir/inspect-$selected.stdout"
  cat "$state_dir/inspect-$selected.stderr" >&2
  exit "$(<"$state_dir/inspect-$selected.status")"
fi
if [[ "\${1:-}" = ps ]]; then
  cat "$state_dir/container-observations.txt"
  exit 0
fi
if [[ "\${1:-}" = inspect ]]; then
  cat "$state_dir/container-observation.txt"
  exit 0
fi
printf '%s\\n' "unexpected fake docker command: $*" >&2
exit 96
`;

const fakeTimeout = `#!/usr/bin/env bash
set -euo pipefail
signal_option="\${1:-}"
kill_after_option="\${2:-}"
duration="\${3:-}"
shift 3
if [[ "\${FAKE_TERM_IGNORING_INSPECT:-0}" = 1 && "\${1:-}" = docker && "\${2:-}" = buildx && "\${3:-}" = inspect ]]; then
  [[ "$signal_option" = --signal=TERM ]]
  [[ "$kill_after_option" = --kill-after=1s ]]
  [[ "$duration" = 5s || "$duration" =~ ^[1-4]s$ ]]
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_STATE_DIR/commands.log"
  ready_file="$FAKE_DOCKER_STATE_DIR/hung-child.ready"
  rm -f "$ready_file"
  node -e 'const fs = require("node:fs"); process.on("SIGTERM", () => {}); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);' "$ready_file" &
  child_pid=$!
  while [[ ! -s "$ready_file" ]]; do :; done
  kill -TERM "$child_pid"
  kill -0 "$child_pid"
  kill -KILL "$child_pid"
  set +e
  wait "$child_pid" 2>/dev/null
  set -e
  if kill -0 "$child_pid" 2>/dev/null; then exit 98; fi
  printf '%s\\n' "$child_pid" >> "$FAKE_DOCKER_STATE_DIR/killed-child-pids.log"
  exit 124
fi
exec "$@"
`;

const fakeSleep = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${FAKE_DOCKER_STATE_DIR:?}/sleep.log"
`;

async function prepareScenario(scenario: Scenario): Promise<Execution> {
  const directory = await mkdtemp(join(tmpdir(), 'phub-timeweb-buildkit-readiness-'));
  directories.push(directory);
  const binaryDirectory = join(directory, 'bin');
  const stateDirectory = join(directory, 'state');
  const diagnosticDirectory = join(directory, 'diagnostics');
  const temporaryDirectory = join(directory, 'tmp');
  await Promise.all([
    mkdir(binaryDirectory),
    mkdir(stateDirectory),
    mkdir(diagnosticDirectory),
    mkdir(temporaryDirectory),
  ]);
  await Promise.all([
    writeFile(join(binaryDirectory, 'docker'), fakeDocker),
    writeFile(join(binaryDirectory, 'timeout'), fakeTimeout),
    writeFile(join(binaryDirectory, 'sleep'), fakeSleep),
  ]);
  await Promise.all(
    ['docker', 'timeout', 'sleep'].map((name) => chmod(join(binaryDirectory, name), 0o755)),
  );
  await writeFile(join(stateDirectory, 'inspect-total'), `${scenario.inspections.length}\n`);
  await Promise.all(
    scenario.inspections.flatMap((inspection, index) => {
      const attempt = index + 1;
      const stdout = inspection.version
        ? `Name: explicit-builder\nBuildKit version: ${inspection.version}\n`
        : 'Name: explicit-builder\n';
      return [
        writeFile(join(stateDirectory, `inspect-${attempt}.status`), `${inspection.status}\n`),
        writeFile(join(stateDirectory, `inspect-${attempt}.stdout`), stdout),
        writeFile(join(stateDirectory, `inspect-${attempt}.stderr`), inspection.stderr ?? ''),
      ];
    }),
  );
  await writeFile(
    join(stateDirectory, 'container-observations.txt'),
    `${(scenario.containerIds ?? ['abc123def456'])
      .map((id) => `${id}|buildx_buildkit_phub-timeweb-publish-123-10`)
      .join('\n')}${(scenario.containerIds ?? ['abc123def456']).length === 0 ? '' : '\n'}`,
  );
  await writeFile(
    join(stateDirectory, 'container-observation.txt'),
    `${scenario.containerRunning ?? true}|${scenario.containerState ?? 'running'}|${
      scenario.containerImage ?? expectedImage
    }\n`,
  );

  const fakeEnvironment = {
    ...process.env,
    FAKE_DOCKER_STATE_DIR: stateDirectory,
    FAKE_TERM_IGNORING_INSPECT: scenario.termIgnoringInspect ? '1' : '0',
    PATH: `${binaryDirectory}:${process.env.PATH ?? ''}`,
    TMPDIR: temporaryDirectory,
  };
  const buildxVersion = spawnSync('docker', ['buildx', 'version'], {
    encoding: 'utf8',
    env: fakeEnvironment,
  });
  expect(buildxVersion.status, buildxVersion.stderr).toBe(0);
  expect(buildxVersion.stdout.trim()).toBe(expectedBuildxVersionLine);
  const result = spawnSync(
    'bash',
    [
      helper,
      '--builder',
      'phub-timeweb-publish-123-1',
      '--service',
      'web',
      '--expected-version',
      expectedVersion,
      '--expected-image',
      expectedImage,
      '--diagnostic-dir',
      diagnosticDirectory,
    ],
    {
      encoding: 'utf8',
      env: fakeEnvironment,
      timeout: 20_000,
    },
  );
  return {
    diagnosticDirectory,
    directory,
    stderr: result.stderr,
    stdout: result.stdout,
    status: result.status,
  };
}

async function readSummary(execution: Execution): Promise<string> {
  return readFile(join(execution.diagnosticDirectory, 'summary.txt'), 'utf8');
}

async function commandCount(execution: Execution, prefix: string): Promise<number> {
  const commands = await readFile(join(execution.directory, 'state', 'commands.log'), 'utf8');
  return commands.split('\n').filter((line) => line.startsWith(prefix)).length;
}

async function sleepCount(execution: Execution): Promise<number> {
  try {
    const sleeps = await readFile(join(execution.directory, 'state', 'sleep.log'), 'utf8');
    return sleeps.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('Timeweb publication BuildKit readiness helper', () => {
  it('recovers after two transient exit-255 observations and accepts only exact readiness', async () => {
    const execution = await prepareScenario({
      inspections: [
        { status: 255, stderr: 'endpoint is starting' },
        { status: 255, stderr: 'endpoint is still starting' },
        { status: 0, version: expectedVersion },
      ],
    });

    expect(execution.status, execution.stderr).toBe(0);
    expect(execution.stdout).toContain(
      'TIMEWEB_BUILDKIT_READINESS_PASSED|builder=phub-timeweb-publish-123-1|attempt=3',
    );
    expect(await commandCount(execution, 'buildx inspect ')).toBe(3);
    expect(await commandCount(execution, 'buildx version')).toBe(1);
    expect(await sleepCount(execution)).toBe(2);
    expect(await readSummary(execution)).toContain('verified=true\nreason=verified\n');
    await expect(
      access(join(execution.diagnosticDirectory, 'attempt-3.container.txt')),
    ).resolves.toBeUndefined();
  }, 30_000);

  it('fails immediately when BuildKit reports any non-exact version', async () => {
    const execution = await prepareScenario({ inspections: [{ status: 0, version: 'v0.32.1' }] });

    expect(execution.status).toBe(1);
    expect(await commandCount(execution, 'buildx inspect ')).toBe(1);
    expect(await sleepCount(execution)).toBe(0);
    expect(await readSummary(execution)).toContain('reason=buildkit_version_mismatch\n');
  }, 30_000);

  it('exhausts exactly five transient attempts without sleeping in real time', async () => {
    const sensitiveStderr = 'Authorization: Bearer must-not-leak';
    const execution = await prepareScenario({
      inspections: Array.from({ length: 5 }, () => ({ status: 255, stderr: sensitiveStderr })),
    });

    expect(execution.status).toBe(1);
    expect(await commandCount(execution, 'buildx inspect ')).toBe(5);
    expect(await sleepCount(execution)).toBe(4);
    const summary = await readSummary(execution);
    expect(summary).toContain('max_attempts=5\nattempt_count=5\n');
    expect(summary).toContain('total_retry_budget_seconds=29\n');
    expect(summary).toContain('kill_after_seconds=1\n');
    expect(summary).toContain('reason=buildkit_readiness_exhausted\n');
    const sanitized = await readFile(
      join(execution.diagnosticDirectory, 'attempt-5.stderr.txt'),
      'utf8',
    );
    expect(sanitized).toContain('[REDACTED_SENSITIVE_LINE]');
    expect(sanitized).not.toContain('must-not-leak');
  }, 30_000);

  it('escalates TERM to KILL for an ignoring inspect child without leaving a survivor', async () => {
    const execution = await prepareScenario({
      inspections: [{ status: 255 }],
      termIgnoringInspect: true,
    });

    expect(execution.status, execution.stderr).toBe(1);
    expect(await commandCount(execution, 'docker buildx inspect ')).toBe(5);
    expect(await sleepCount(execution)).toBe(4);
    const killedPids = (
      await readFile(join(execution.directory, 'state', 'killed-child-pids.log'), 'utf8')
    )
      .trim()
      .split('\n')
      .map(Number);
    expect(killedPids).toHaveLength(5);
    for (const killedPid of killedPids) {
      expect(() => process.kill(killedPid, 0)).toThrow();
    }
    expect(await readSummary(execution)).toContain('reason=buildkit_readiness_exhausted\n');
  }, 30_000);

  it.each([
    ['missing', []],
    ['duplicate', ['abc123def456', 'def456abc123']],
  ])(
    'fails immediately for a %s matching container set',
    async (_name, containerIds) => {
      const execution = await prepareScenario({
        containerIds,
        inspections: [{ status: 255 }],
      });

      expect(execution.status).toBe(1);
      expect(await commandCount(execution, 'buildx inspect ')).toBe(1);
      expect(await sleepCount(execution)).toBe(0);
      expect(await readSummary(execution)).toContain('reason=matching_container_count_mismatch\n');
    },
    30_000,
  );

  it('fails immediately when the running container uses any other image', async () => {
    const execution = await prepareScenario({
      containerImage: `moby/buildkit@sha256:${'0'.repeat(64)}`,
      inspections: [{ status: 0, version: expectedVersion }],
    });

    expect(execution.status).toBe(1);
    expect(await commandCount(execution, 'buildx inspect ')).toBe(1);
    expect(await readSummary(execution)).toContain('reason=buildkit_image_mismatch\n');
  }, 30_000);

  it('can become ready only after the exact version appears', async () => {
    const execution = await prepareScenario({
      inspections: [{ status: 255 }, { status: 255 }, { status: 0, version: expectedVersion }],
    });

    expect(execution.status, execution.stderr).toBe(0);
    expect(await commandCount(execution, 'buildx inspect ')).toBe(3);
    expect(await sleepCount(execution)).toBe(2);
    const commands = await readFile(join(execution.directory, 'state', 'commands.log'), 'utf8');
    expect(commands).not.toMatch(/(?:^|\n)(?:login|buildx build|push)(?: |$)/u);
  }, 30_000);
});
