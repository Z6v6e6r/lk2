import { constants, type Stats } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { readRootOwnedEvidence, type RootOwnedEvidenceIo } from './root-owned-evidence.js';

type MetadataOptions = {
  dev?: number;
  ino?: number;
  uid?: number;
  nlink?: number;
  mode?: number;
  size?: number;
  file?: boolean;
  symlink?: boolean;
};

function metadata(options: MetadataOptions = {}): Stats {
  return {
    dev: options.dev ?? 1,
    ino: options.ino ?? 2,
    uid: options.uid ?? 0,
    nlink: options.nlink ?? 1,
    mode: options.mode ?? 0o100400,
    size: options.size ?? 4,
    isFile: () => options.file ?? true,
    isSymbolicLink: () => options.symlink ?? false,
  } as Stats;
}

function fakeIo(
  content: Buffer,
  before: Stats,
  after: Stats = before,
  pathAfter: Stats = after,
): { io: RootOwnedEvidenceIo; flags: number[]; close: ReturnType<typeof vi.fn> } {
  const flags: number[] = [];
  const close = vi.fn(() => Promise.resolve());
  let read = false;
  let stats = 0;
  const io = {
    open: vi.fn((_path: string, value: number) => {
      flags.push(value);
      return Promise.resolve({
        stat: vi.fn(() => Promise.resolve(stats++ === 0 ? before : after)),
        read: vi.fn((buffer: Buffer, offset: number, length: number) => {
          if (read) return Promise.resolve({ bytesRead: 0, buffer });
          read = true;
          const bytesRead = Math.min(length, content.length);
          content.copy(buffer, offset, 0, bytesRead);
          return Promise.resolve({ bytesRead, buffer });
        }),
        close,
      });
    }),
    lstat: vi.fn(() => Promise.resolve(pathAfter)),
  } as unknown as RootOwnedEvidenceIo;
  return { io, flags, close };
}

describe('root-owned evidence same-FD custody', () => {
  it('opens with numeric no-follow/non-blocking flags and reads only the verified FD', async () => {
    const target = fakeIo(Buffer.from('safe'), metadata());
    await expect(readRootOwnedEvidence('/run/phub/input', 16, target.io)).resolves.toEqual(
      Buffer.from('safe'),
    );
    expect(target.flags).toEqual([
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ]);
    expect(target.close).toHaveBeenCalledOnce();
  });

  it.each([
    ['attacker file swap', metadata(), metadata(), metadata({ ino: 99 })],
    ['symlink swap', metadata(), metadata(), metadata({ ino: 99, file: false, symlink: true })],
    ['FIFO target', metadata({ file: false, mode: 0o010400 }), metadata(), metadata()],
    ['oversized target', metadata({ size: 17 }), metadata({ size: 17 }), metadata({ size: 17 })],
    ['same-FD mutation', metadata(), metadata({ size: 5 }), metadata({ size: 5 })],
  ])('rejects %s before inventory/DB execution', async (_name, before, after, pathAfter) => {
    const target = fakeIo(Buffer.from('safe'), before, after, pathAfter);
    await expect(readRootOwnedEvidence('/run/phub/input', 16, target.io)).rejects.toThrow(
      'INPUT_CUSTODY_INVALID',
    );
    expect(target.close).toHaveBeenCalledOnce();
  });
});
