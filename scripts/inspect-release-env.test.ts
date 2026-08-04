import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const inspector = fileURLToPath(
  new URL('../deploy/jetson/inspect-release-env.sh', import.meta.url),
);
const temporaryDirectories: string[] = [];

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function inspect(content: string): Promise<CommandResult> {
  const temporary = await mkdtemp(join(tmpdir(), 'phub-release-env-inspection-'));
  temporaryDirectories.push(temporary);
  const releaseEnv = join(temporary, 'release.env');
  await writeFile(releaseEnv, content, 'utf8');

  return new Promise((resolve) => {
    execFile('/bin/sh', [inspector, releaseEnv], (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stdout, stderr });
    });
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('release.env metadata-only inspector', () => {
  it('accepts valid release metadata without printing values', async () => {
    const secretValue = 'do-not-print-valid-value';
    const result = await inspect(`# active release\nREGISTRY=${secretValue}\nRELEASE=abc123\n`);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('release_env_valid\n');
    expect(result.stdout).not.toContain(secretValue);
    expect(result.stderr).not.toContain(secretValue);
  });

  it('reports only safe metadata for invalid lines and redacts every value', async () => {
    const carriageReturnSecret = 'carriage-return-secret';
    const unsafeKeySecret = 'unsafe-key-secret';
    const result = await inspect(
      `REGISTRY=ghcr.io/example\nAPI_TOKEN=${carriageReturnSecret}\r\nlower.key=${unsafeKeySecret}\n`,
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('release_env_invalid line=2 key=API_TOKEN length=33');
    expect(result.stderr).toContain('release_env_invalid line=3 key=UNSAFE_KEY length=27');
    expect(result.stderr).toContain('values were redacted');
    expect(`${result.stdout}${result.stderr}`).not.toContain(carriageReturnSecret);
    expect(`${result.stdout}${result.stderr}`).not.toContain(unsafeKeySecret);
  });
});
