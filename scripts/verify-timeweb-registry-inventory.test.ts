import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const services = ['api', 'migrator', 'realtime', 'web', 'worker'];
const sourceSha = 'a'.repeat(40);
const workflowSha = 'b'.repeat(40);
const runId = '12345';
const runAttempt = '1';
const tag = `amd64-sha-${sourceSha}-${runId}-${runAttempt}`;

describe('Timeweb registry inventory verifier', () => {
  it('requires every observed tag digest to equal the verified build evidence digest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phub-timeweb-inventory-'));
    const evidenceDirectory = join(directory, 'images');
    const inventoryPath = join(directory, 'inventory.json');
    const verifier = fileURLToPath(
      new URL('./verify-timeweb-registry-inventory.js', import.meta.url),
    );
    await mkdir(evidenceDirectory);
    const digestFor = (index: number) => `sha256:${String(index + 1).padStart(64, '0')}`;
    const inventory = {
      schemaVersion: 1,
      kind: 'phub-timeweb-amd64-registry-inventory',
      sourceSha,
      workflowSha,
      platform: 'linux/amd64',
      runId,
      runAttempt,
      presentImages: 5,
      expectedImages: 5,
      complete: true,
      authorizesDeploy: false,
      images: services.map((service, index) => ({
        service,
        repository: `ghcr.io/z6v6e6r/phub-${service}`,
        publicationTag: tag,
        status: 'present',
        indexDigest: digestFor(index),
      })),
    };
    try {
      await Promise.all(
        services.map((service, index) =>
          writeFile(
            join(evidenceDirectory, `${service}-image.json`),
            JSON.stringify({
              service,
              sourceSha,
              workflowSha,
              repository: `ghcr.io/z6v6e6r/phub-${service}`,
              publicationTag: tag,
              indexDigest: digestFor(index),
              runId,
              runAttempt,
            }),
          ),
        ),
      );
      await writeFile(inventoryPath, JSON.stringify(inventory));
      const run = () =>
        spawnSync(
          process.execPath,
          [verifier, inventoryPath, evidenceDirectory, sourceSha, workflowSha, runId, runAttempt],
          { encoding: 'utf8' },
        );
      expect(run().status).toBe(0);

      inventory.images[3].indexDigest = `sha256:${'f'.repeat(64)}`;
      await writeFile(inventoryPath, JSON.stringify(inventory));
      const mismatch = run();
      expect(mismatch.status).not.toBe(0);
      expect(mismatch.stderr).toContain('registry digest mismatch: web');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
