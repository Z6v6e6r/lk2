import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { runCommunitiesLegacyWriterInventory as runInventoryCli } from './verify-communities-legacy-writer-inventory.js';
import {
  calculateCommunitiesNodeRedFunctionDigest,
  type CommunitiesLegacyNodeRedNode,
} from './communities-legacy-writer-inventory-support.js';

const directories: string[] = [];
const execFile = promisify(execFileCallback);

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

type FixtureFiles = {
  readonly arguments_: readonly string[];
  readonly flowPath: string;
  readonly allowlistPath: string;
  readonly flowPin: string;
  readonly allowlistPin: string;
};

async function fixtureFiles(nodes: CommunitiesLegacyNodeRedNode[]): Promise<FixtureFiles> {
  const directory = await mkdtemp(join(tmpdir(), 'communities-writers-'));
  directories.push(directory);
  const flowPath = join(directory, 'flow.json');
  const flowBytes = Buffer.from(JSON.stringify(nodes));
  const flowPin = createHash('sha256').update(flowBytes).digest('hex');
  const allowlistPath = join(directory, 'function-allowlist.json');
  const allowlistBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 'communities-node-red-function-allowlist-v1',
      sourceFlowSha256: flowPin,
      functionDigests: nodes
        .filter(
          (node) =>
            node.d !== true &&
            node.type === 'function' &&
            !nodes.some(
              (parent) => parent.id === node.z && parent.type === 'tab' && parent.disabled === true,
            ),
        )
        .map(calculateCommunitiesNodeRedFunctionDigest),
    }),
  );
  const allowlistPin = createHash('sha256').update(allowlistBytes).digest('hex');
  await writeFile(flowPath, flowBytes, { mode: 0o600 });
  await writeFile(allowlistPath, allowlistBytes, { mode: 0o600 });
  await chmod(flowPath, 0o600);
  await chmod(allowlistPath, 0o600);
  return {
    arguments_: ['--flow', flowPath, '--function-allowlist', allowlistPath],
    flowPath,
    allowlistPath,
    flowPin,
    allowlistPin,
  };
}

async function runFixture(files: FixtureFiles) {
  return runInventoryCli(files.arguments_, files.flowPin, files.allowlistPin);
}

const validFlow = (): CommunitiesLegacyNodeRedNode[] => [
  {
    id: 'route',
    z: 'flow',
    type: 'http in',
    method: 'post',
    url: '/lk/communities/:communityId/messages',
    wires: [['writer']],
  },
  {
    id: 'writer',
    z: 'flow',
    type: 'mongodb4',
    collection: 'lk_community_events',
    operation: 'insertOne',
    wires: [],
  },
];

describe('Communities legacy writer inventory CLI', () => {
  it('returns a redacted success report for a private valid flow', async () => {
    const files = await fixtureFiles(validFlow());
    const result = await runFixture(files);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: 'NODE_RED_WRITER_INVENTORY_COMPLETE',
      authorizesMutation: false,
    });
    expect(result.stdout).not.toContain(files.flowPath);
    expect(result.stdout).not.toContain('route');
  });

  it('returns exit 1 with a redacted NO_GO report for an unknown writer', async () => {
    const nodes = validFlow();
    (nodes[1] as { collection: string }).collection = 'lk_media_assets';
    const result = await runFixture(await fixtureFiles(nodes));
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: 'NO_GO',
      unknown: 1,
      blockers: ['NODE_RED_UNKNOWN_WRITERS'],
    });
  });

  it('rejects missing, malformed and relative arguments without path disclosure', async () => {
    const files = await fixtureFiles(validFlow());
    const path = files.flowPath;
    for (const arguments_ of [
      [],
      ['--wat', path],
      ['--flow', 'relative.json'],
      ['--flow', path, '--function-allowlist'],
    ]) {
      const result = await runInventoryCli(arguments_, files.flowPin, files.allowlistPin);
      expect(result).toEqual({
        exitCode: 2,
        stdout: '',
        stderr: 'COMMUNITIES_LEGACY_WRITER_INVENTORY_INVALID_INPUT\n',
      });
      expect(result.stderr).not.toContain(path);
    }
  });

  it('requires an independently supplied exact raw-flow SHA-256 pin', async () => {
    const files = await fixtureFiles(validFlow());
    expect((await runInventoryCli(files.arguments_, undefined, files.allowlistPin)).exitCode).toBe(
      2,
    );
    expect((await runInventoryCli(files.arguments_, files.flowPin, undefined)).exitCode).toBe(2);
    expect(
      (await runInventoryCli(files.arguments_, 'b'.repeat(64), files.allowlistPin)).exitCode,
    ).toBe(2);
    expect((await runInventoryCli(files.arguments_, files.flowPin, 'c'.repeat(64))).exitCode).toBe(
      2,
    );
  });

  it('rejects symlinks, non-private modes, malformed JSON and oversized files', async () => {
    const files = await fixtureFiles(validFlow());
    const path = files.flowPath;
    const link = join(dirname(path), 'link.json');
    await symlink(path, link);
    expect(
      (
        await runInventoryCli(
          ['--flow', link, '--function-allowlist', files.allowlistPath],
          files.flowPin,
          files.allowlistPin,
        )
      ).exitCode,
    ).toBe(2);
    await chmod(path, 0o644);
    expect((await runFixture(files)).exitCode).toBe(2);
    await chmod(path, 0o600);
    await writeFile(path, '{', { mode: 0o600 });
    expect((await runFixture(files)).exitCode).toBe(2);
    await truncate(path, 32 * 1024 * 1024 + 1);
    expect((await runFixture(files)).exitCode).toBe(2);
  });

  it('rejects an allowlist for another flow and duplicate function digests', async () => {
    const files = await fixtureFiles([
      ...validFlow(),
      { id: 'function', z: 'flow', type: 'function', func: 'return msg;', wires: [] },
    ]);
    const functionDigest = calculateCommunitiesNodeRedFunctionDigest({
      id: 'function',
      z: 'flow',
      type: 'function',
      func: 'return msg;',
    });
    for (const allowlist of [
      {
        schemaVersion: 'communities-node-red-function-allowlist-v1',
        sourceFlowSha256: 'd'.repeat(64),
        functionDigests: [functionDigest],
      },
      {
        schemaVersion: 'communities-node-red-function-allowlist-v1',
        sourceFlowSha256: files.flowPin,
        functionDigests: [functionDigest, functionDigest],
      },
    ]) {
      const bytes = Buffer.from(JSON.stringify(allowlist));
      await writeFile(files.allowlistPath, bytes, { mode: 0o600 });
      await chmod(files.allowlistPath, 0o600);
      const pin = createHash('sha256').update(bytes).digest('hex');
      expect((await runInventoryCli(files.arguments_, files.flowPin, pin)).exitCode).toBe(2);
    }
  });

  it('uses a path-safe subprocess entrypoint', async () => {
    try {
      await execFile(
        process.execPath,
        ['--import', 'tsx', 'scripts/verify-communities-legacy-writer-inventory.ts'],
        { cwd: process.cwd() },
      );
      throw new Error('expected failure');
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      expect(failure.code).toBe(2);
      expect(failure.stdout).toBe('');
      expect(failure.stderr).toBe('COMMUNITIES_LEGACY_WRITER_INVENTORY_INVALID_INPUT\n');
    }
  });
});
