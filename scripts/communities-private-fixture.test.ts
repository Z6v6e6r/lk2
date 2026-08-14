import { chmod, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readPrivateFixture, requirePinnedOrigin } from './communities-private-fixture.js';

describe('private Communities load fixture', () => {
  it('reads only a private owned regular file outside the repository', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'communities-private-fixture-'));
    const path = join(directory, 'fixture.json');
    await writeFile(path, '{"ok":true}', { mode: 0o600 });
    await expect(readPrivateFixture(path, 'FIXTURE')).resolves.toBe('{"ok":true}');

    await chmod(path, 0o644);
    await expect(readPrivateFixture(path, 'FIXTURE')).rejects.toThrow('private, owned');
  });

  it('rejects symlinks and oversized fixtures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'communities-private-fixture-'));
    const target = join(directory, 'target.json');
    const link = join(directory, 'link.json');
    await writeFile(target, '{}', { mode: 0o600 });
    await symlink(target, link);
    await expect(readPrivateFixture(link, 'FIXTURE')).rejects.toThrow('private, owned');

    const oversized = join(directory, 'oversized.json');
    await writeFile(oversized, Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 });
    await expect(readPrivateFixture(oversized, 'FIXTURE')).rejects.toThrow('byte limit');
  });

  it('requires the exact independently pinned origin', () => {
    expect(() =>
      requirePinnedOrigin(
        new URL('https://staging.padlhub.test/path'),
        'https://staging.padlhub.test',
        'TARGET',
      ),
    ).not.toThrow();
    expect(() =>
      requirePinnedOrigin(
        new URL('https://staging.evil.test'),
        'https://staging.padlhub.test',
        'TARGET',
      ),
    ).toThrow('independently pinned fixture origin');
  });
});
