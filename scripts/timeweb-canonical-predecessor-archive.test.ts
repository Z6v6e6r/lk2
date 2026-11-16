import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { extractCanonicalPredecessorArtifactPair } from './timeweb-api-web-upgrade.js';

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function archive(
  deflated = false,
  bomb = false,
  names = ['release-manifest.json', 'release-manifest.sha256'],
) {
  const contents = [
    bomb ? Buffer.alloc(1_048_577, 65) : Buffer.from('{}\n'),
    Buffer.from('checksum\n'),
  ];
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [index, name] of names.entries()) {
    const filename = Buffer.from(name),
      value = contents[index]!;
    const data = deflated ? deflateRawSync(value) : value;
    const local = Buffer.alloc(30),
      header = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    header.writeUInt32LE(0x02014b50);
    local.writeUInt16LE(deflated ? 8 : 0, 8);
    header.writeUInt16LE(deflated ? 8 : 0, 10);
    local.writeUInt32LE(crc32(value), 14);
    header.writeUInt32LE(crc32(value), 16);
    local.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 20);
    const declared = bomb && index === 0 ? 1 : value.length;
    local.writeUInt32LE(declared, 22);
    header.writeUInt32LE(declared, 24);
    local.writeUInt16LE(filename.length, 26);
    header.writeUInt16LE(filename.length, 28);
    header.writeUInt32LE(offset, 42);
    locals.push(local, filename, data);
    central.push(header, filename);
    offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(2, 8);
  end.writeUInt16LE(2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe('bounded retained-predecessor ZIP reader', () => {
  it.each([false, true])(
    'reads the exact pair without extracting files, deflated=%s',
    (deflated) => {
      const pair = extractCanonicalPredecessorArtifactPair(archive(deflated));
      expect([...pair.keys()]).toEqual(['release-manifest.json', 'release-manifest.sha256']);
      expect(pair.get('release-manifest.json')?.toString()).toBe('{}\n');
    },
  );

  it('bounds actual inflate output even when the declared size is small', () => {
    expect(() => extractCanonicalPredecessorArtifactPair(archive(true, true))).toThrow(
      'canonical_artifact_archive',
    );
  });

  it('rejects duplicate or missing pair members', () => {
    expect(() =>
      extractCanonicalPredecessorArtifactPair(
        archive(false, false, ['release-manifest.json', 'release-manifest.json']),
      ),
    ).toThrow();
    expect(() =>
      extractCanonicalPredecessorArtifactPair(archive(false, false, ['release-manifest.json'])),
    ).toThrow();
  });

  it('rejects overlapping local records even when both payload CRCs are valid', () => {
    const base = archive(),
      end = base.length - 22,
      directoryOffset = base.readUInt32LE(end + 16);
    const firstData = 30 + Buffer.byteLength('release-manifest.json');
    const secondLocal = firstData + 3,
      nested = base.subarray(secondLocal, directoryOffset);
    const first = Buffer.from(base.subarray(0, firstData));
    first.writeUInt32LE(crc32(nested), 14);
    first.writeUInt32LE(nested.length, 18);
    first.writeUInt32LE(nested.length, 22);
    const directory = Buffer.from(base.subarray(directoryOffset, end)),
      eocd = Buffer.from(base.subarray(end));
    directory.writeUInt32LE(crc32(nested), 16);
    directory.writeUInt32LE(nested.length, 20);
    directory.writeUInt32LE(nested.length, 24);
    directory.writeUInt32LE(firstData, 46 + Buffer.byteLength('release-manifest.json') + 42);
    eocd.writeUInt32LE(firstData + nested.length, 16);
    expect(() =>
      extractCanonicalPredecessorArtifactPair(Buffer.concat([first, nested, directory, eocd])),
    ).toThrow('canonical_artifact_archive');
  });

  it('rejects malformed ranges, names, headers, methods and integrity', () => {
    const base = archive();
    const end = base.length - 22,
      directory = base.readUInt32LE(end + 16);
    const second = directory + 46 + Buffer.byteLength('release-manifest.json');
    const cases: Array<(bytes: Buffer) => unknown> = [
      (b) => b.writeUInt32LE(0, end),
      (b) => b.writeUInt16LE(1, end + 8),
      (b) => b.writeUInt16LE(1, end + 10),
      (b) => b.writeUInt16LE(1, end + 4),
      (b) => b.writeUInt32LE(directory + 1, end + 16),
      (b) => b.writeUInt32LE(0xffffffff, directory + 42),
      (b) => b.writeUInt32LE(0, 0),
      (b) => b.writeUInt32LE(0, directory),
      (b) => b.writeUInt16LE(1, directory + 8),
      (b) => b.writeUInt16LE(9, directory + 10),
      (b) => b.writeUInt32LE(1_048_577, directory + 24),
      (b) => b.writeUInt32LE(0xffffffff, directory + 20),
      (b) => b.writeUInt16LE(0xffff, directory + 28),
      (b) => b.writeUInt16LE(0xffff, 28),
      (b) => b.writeUInt16LE(8, 8),
      (b) => b.writeUInt32LE(0, directory + 16),
      (b) => {
        b[directory + 46] = 47;
      },
      (b) => {
        b[30] = 47;
      },
      (b) => {
        b[30] = 255;
        b[directory + 46] = 255;
      },
      (b) => b.writeUInt32LE(0, second + 42),
      (b) => Buffer.concat([b, Buffer.from('unclaimed trailing bytes')]),
      (b) => b.subarray(0, b.length - 1),
    ];
    for (const [index, mutate] of cases.entries()) {
      const copy = Buffer.from(base),
        changed = mutate(copy);
      expect(
        () => extractCanonicalPredecessorArtifactPair(Buffer.isBuffer(changed) ? changed : copy),
        String(index),
      ).toThrow();
    }
    expect(() => extractCanonicalPredecessorArtifactPair(Buffer.alloc(4_194_305))).toThrow();
  });
});
