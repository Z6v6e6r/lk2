import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  summarizeCommand,
  verifyPinnedBuildkitBootstrap,
  type CommandResult,
} from './verify-pinned-buildkit-bootstrap.js';

const image =
  'moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8';
const version = 'v0.32.2';
const directories: string[] = [];

function result(status: number, stdout = '', stderr = ''): CommandResult {
  return { status, stdout, stderr };
}

function container(state: 'exited' | 'running', observedImage = image): CommandResult {
  return result(
    0,
    JSON.stringify({
      image: observedImage,
      status: state,
      running: state === 'running',
      restarting: false,
      exitCode: state === 'running' ? 0 : 1,
    }),
  );
}

async function input() {
  const directory = await mkdtemp(join(tmpdir(), 'phub-buildkit-bootstrap-'));
  directories.push(directory);
  return {
    service: 'api' as const,
    builder: 'phub-timeweb-pr-provenance-123-1-api',
    image,
    version,
    diagnosticPath: join(directory, 'api-buildkit-bootstrap.json'),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('pinned BuildKit bootstrap verification', () => {
  it('retries a transient exit 255 and accepts only the exact ready builder', async () => {
    const commandResults = [
      result(255, '', 'transient runner failure'),
      container('exited'),
      result(0, `Name: builder\nBuildKit version: ${version}\n`),
      container('running'),
    ];
    const runCommand = vi.fn(() => commandResults.shift() ?? result(1));
    const sleep = vi.fn(() => Promise.resolve());
    const configuration = await input();

    const diagnostic = await verifyPinnedBuildkitBootstrap(configuration, { runCommand, sleep });

    expect(diagnostic).toMatchObject({
      verified: true,
      reason: 'verified',
      attemptCount: 2,
      pushed: false,
      authorizesPublication: false,
      authorizesDeploy: false,
    });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      'docker',
      ['buildx', 'inspect', configuration.builder, '--bootstrap'],
      60_000,
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      'docker',
      expect.arrayContaining(['inspect', 'buildx_buildkit_phub-timeweb-pr-provenance-123-1-api0']),
      60_000,
    );
  });

  it('fails closed immediately on a BuildKit version mismatch', async () => {
    const configuration = await input();
    const runCommand = vi
      .fn()
      .mockReturnValueOnce(result(0, 'BuildKit version: v0.31.1\n'))
      .mockReturnValueOnce(container('running'));

    await expect(
      verifyPinnedBuildkitBootstrap(configuration, {
        runCommand,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({
      reason: 'buildkit_version_mismatch',
    });
    expect(runCommand).toHaveBeenCalledTimes(2);
    const diagnostic = JSON.parse(await readFile(configuration.diagnosticPath, 'utf8')) as {
      readonly reason: string;
      readonly attemptCount: number;
    };
    expect(diagnostic).toEqual(expect.objectContaining({ reason: 'buildkit_version_mismatch' }));
    expect(diagnostic.attemptCount).toBe(1);
  });

  it('fails closed immediately on a pinned BuildKit image mismatch', async () => {
    const configuration = await input();
    const differentImage = `moby/buildkit@sha256:${'0'.repeat(64)}`;
    const runCommand = vi
      .fn()
      .mockReturnValueOnce(result(0, `BuildKit version: ${version}\n`))
      .mockReturnValueOnce(container('running', differentImage));

    await expect(
      verifyPinnedBuildkitBootstrap(configuration, {
        runCommand,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({ reason: 'buildkit_image_mismatch' });
    expect(runCommand).toHaveBeenCalledTimes(2);
    const diagnostic = JSON.parse(await readFile(configuration.diagnosticPath, 'utf8')) as {
      readonly reason: string;
      readonly attemptCount: number;
    };
    expect(diagnostic).toMatchObject({ reason: 'buildkit_image_mismatch', attemptCount: 1 });
  });

  it('records only bounded command metadata and hashes, never raw output', () => {
    const stdout = 'BuildKit version: v0.32.2\n';
    const stderr = 'credential-shaped-value-must-not-be-copied';
    const summary = summarizeCommand(result(255, stdout, stderr));

    expect(summary).toEqual({
      exitCode: 255,
      signal: null,
      timedOut: false,
      errorCode: null,
      stdoutBytes: Buffer.byteLength(stdout),
      stdoutSha256: createHash('sha256').update(stdout).digest('hex'),
      stderrBytes: Buffer.byteLength(stderr),
      stderrSha256: createHash('sha256').update(stderr).digest('hex'),
    });
    expect(JSON.stringify(summary)).not.toContain(stdout.trim());
    expect(JSON.stringify(summary)).not.toContain(stderr);
  });

  it('stops after three non-ready attempts and preserves the no-push boundary', async () => {
    const configuration = await input();
    const runCommand = vi.fn((_command: string, arguments_: readonly string[]) =>
      arguments_[0] === 'buildx' ? result(255) : result(1),
    );

    await expect(
      verifyPinnedBuildkitBootstrap(configuration, {
        runCommand,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({
      reason: 'buildkit_bootstrap_not_ready',
    });
    expect(runCommand).toHaveBeenCalledTimes(6);
    const diagnostic = JSON.parse(await readFile(configuration.diagnosticPath, 'utf8')) as {
      readonly attemptCount: number;
      readonly pushed: boolean;
      readonly authorizesPublication: boolean;
      readonly authorizesDeploy: boolean;
    };
    expect(diagnostic).toMatchObject({
      attemptCount: 3,
      pushed: false,
      authorizesPublication: false,
      authorizesDeploy: false,
    });
  });
});
