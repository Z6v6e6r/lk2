import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

type TarEntry = {
  readonly name: string;
  readonly body?: Buffer;
  readonly linkName?: string;
  readonly type?: '0' | '1' | '2' | '5';
};

const writeField = (header: Buffer, offset: number, length: number, value: string) => {
  header.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'ascii');
};

const tar = (entries: readonly TarEntry[]) => {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    writeField(header, 0, 100, entry.name);
    writeField(header, 100, 8, entry.type === '5' ? '0000755\0' : '0000644\0');
    writeField(header, 108, 8, '0000000\0');
    writeField(header, 116, 8, '0000000\0');
    writeField(header, 124, 12, `${body.length.toString(8).padStart(11, '0')}\0`);
    writeField(header, 136, 12, '00000000000\0');
    header.fill(0x20, 148, 156);
    writeField(header, 156, 1, entry.type ?? '0');
    writeField(header, 157, 100, entry.linkName ?? '');
    writeField(header, 257, 6, 'ustar\0');
    writeField(header, 263, 2, '00');
    const checksum = [...header].reduce((sum, value) => sum + value, 0);
    writeField(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
    chunks.push(header, body);
    if (body.length % 512 !== 0) chunks.push(Buffer.alloc(512 - (body.length % 512)));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
};

describe('verified OCI layout extractor', () => {
  it('rejects unsafe entries, duplicates, links and content-address mismatches', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'phub-oci-layout-test-'));
    const script = fileURLToPath(new URL('./extract-verified-oci-layout.sh', import.meta.url));
    const blob = Buffer.from('verified blob');
    const digest = createHash('sha256').update(blob).digest('hex');
    const layout = Buffer.from(JSON.stringify({ imageLayoutVersion: '1.0.0' }));
    const index = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        manifests: [
          { digest: `sha256:${digest}`, mediaType: 'application/test', size: blob.length },
        ],
      }),
    );
    const regularEntries: readonly TarEntry[] = [
      { name: 'blobs/', type: '5' },
      { name: 'blobs/sha256/', type: '5' },
      { name: 'oci-layout', body: layout },
      { name: 'index.json', body: index },
      { name: `blobs/sha256/${digest}`, body: blob },
    ];
    let sequence = 0;
    const run = async (entries: readonly TarEntry[]) => {
      sequence += 1;
      const archive = join(temporary, `fixture-${sequence}.tar`);
      const destination = join(temporary, `layout-${sequence}`);
      const evidence = join(temporary, `evidence-${sequence}`);
      await writeFile(archive, tar(entries));
      return spawnSync('bash', [script, archive, destination, evidence], { encoding: 'utf8' });
    };

    try {
      const valid = await run(regularEntries);
      expect(valid.status, `${valid.stderr}\n${valid.stdout}`).toBe(0);
      expect((await run([...regularEntries, { name: 'index.json', body: index }])).status).not.toBe(
        0,
      );
      expect((await run([...regularEntries, { name: '../escape', body: blob }])).status).not.toBe(
        0,
      );
      expect((await run([...regularEntries, { name: '/escape', body: blob }])).status).not.toBe(0);
      expect(
        (await run([...regularEntries, { name: `blobs/sha256/${'0'.repeat(63)}`, body: blob }]))
          .status,
      ).not.toBe(0);
      expect(
        (
          await run([
            ...regularEntries.slice(0, -1),
            { name: `blobs/sha256/${digest}`, linkName: 'index.json', type: '2' },
          ])
        ).status,
      ).not.toBe(0);
      expect(
        (
          await run([
            ...regularEntries.slice(0, -1),
            { name: `blobs/sha256/${digest}`, linkName: 'index.json', type: '1' },
          ])
        ).status,
      ).not.toBe(0);
      expect(
        (
          await run([
            ...regularEntries.slice(0, -1),
            { name: `blobs/sha256/${'0'.repeat(64)}`, body: blob },
          ])
        ).status,
      ).not.toBe(0);
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });
});
