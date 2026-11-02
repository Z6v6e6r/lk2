import { describe, expect, it } from 'vitest';
import { createR1TailLockCustody, R1_TAIL_LOCKS } from './r1-tail-migration-locks.js';
import type { R1LockIO } from './r1-tail-migration-locks.js';
const root = '/opt/phub/timeweb-beta/backups/r1-tail108-119-00000000-0000-4000-8000-000000000001';
const marker = Buffer.from('synthetic exact plan/operation-bound marker\n');
function fixture() {
  type Inode = { dev: number; ino: number; nlink: number; bytes: Buffer };
  const files = new Map<string, Inode>();
  let next = 100,
    step = 0,
    fail = 0;
  const events: string[] = [];
  const mutation = (name: string, fn: () => void) => {
    fn();
    events.push(name);
    if (++step === fail) throw Error('SYNTHETIC_ACK_LOST');
  };
  const inode = (path: string) => {
    const row = files.get(path);
    if (!row) throw Error('SYNTHETIC_ENOENT');
    return row;
  };
  const io: R1LockIO = {
    present: (path) => files.has(path),
    read: (path) => Buffer.from(inode(path).bytes),
    rawRead: (path) => Buffer.from(inode(path).bytes),
    info: (path) => inode(path),
    stage: (target, bytes) => {
      const path = target + '.incoming-' + String(next).padStart(24, '0');
      mutation('stage', () => {
        files.set(path, { dev: 1, ino: next++, nlink: 1, bytes: Buffer.from(bytes) });
      });
      return path;
    },
    durable: (path, bytes, exclusive) => {
      mutation('durable', () => {
        if (exclusive && files.has(path)) throw Error('SYNTHETIC_EEXIST');
        files.set(path, { dev: 1, ino: next++, nlink: 1, bytes: Buffer.from(bytes) });
      });
    },
    link: (from, to) => {
      mutation('link', () => {
        if (files.has(to)) throw Error('SYNTHETIC_EEXIST');
        const row = inode(from);
        row.nlink++;
        files.set(to, row);
      });
    },
    unlink: (path) => {
      mutation('unlink', () => {
        const row = inode(path);
        files.delete(path);
        row.nlink--;
      });
    },
    syncParent: () => {
      mutation('fsync', () => {});
    },
    normalize: (path) => {
      const row = inode(path);
      const twins = [...files].filter(
        ([name, value]) => name.startsWith(path + '.incoming-') && value === row,
      );
      if (twins.length !== 1) throw Error('SYNTHETIC_TWIN');
      io.unlink(twins[0]![0]);
      io.syncParent(path);
    },
  };
  const owner = { assertOwned: () => {} };
  return {
    io,
    files,
    events,
    instance: () => createR1TailLockCustody(root, marker, owner, io),
    crash: (at: number) => {
      step = 0;
      fail = at;
    },
    clear: () => {
      step = 0;
      fail = 0;
      events.length = 0;
    },
  };
}
describe('fixed R1 write-ahead lock inode custody', () => {
  it.each(Array.from({ length: 9 }, (_, i) => i + 1))(
    'recovers claim ACK loss at publication boundary%i without unknown lock deletion',
    (point) => {
      const f = fixture();
      f.crash(point);
      expect(() => f.instance().claim(() => {})).toThrow('SYNTHETIC_ACK_LOST');
      f.clear();
      const recovery = f.instance();
      recovery.load();
      expect(() => recovery.assert(false)).not.toThrow();
      recovery.release();
      expect(R1_TAIL_LOCKS.some((path) => f.files.has(path))).toBe(false);
      // Before the inode record exists, only unpublished staging files can remain; never guess/delete them.
      if (point < 3)
        expect([...f.files.keys()].every((path) => path.includes('.incoming-'))).toBe(true);
      f.clear();
      recovery.release();
      expect(f.events).toEqual([]);
    },
  );
  it.each([1, 2, 3, 4])('recovers release ACK loss at unlink/fsync boundary%i', (point) => {
    const f = fixture();
    f.instance().claim(() => {});
    f.crash(point);
    const current = f.instance();
    current.load();
    expect(() => current.release()).toThrow('SYNTHETIC_ACK_LOST');
    f.clear();
    const recovery = f.instance();
    recovery.load();
    recovery.release();
    expect(R1_TAIL_LOCKS.some((path) => f.files.has(path))).toBe(false);
  });
  it.each(['inode', 'bytes', 'twin'] as const)(
    'retains a foreign%s lock and refuses recovery',
    (kind) => {
      const f = fixture();
      f.instance().claim(() => {});
      const path = R1_TAIL_LOCKS[0]!;
      const current = f.files.get(path)!;
      if (kind === 'inode') f.files.set(path, { ...current, ino: 99999 });
      if (kind === 'bytes') current.bytes = Buffer.from('foreign');
      if (kind === 'twin') {
        current.nlink = 2;
        f.files.set(path + '.incoming-' + 'f'.repeat(24), current);
      }
      f.clear();
      const recovery = f.instance();
      recovery.load();
      expect(() => recovery.release()).toThrow('R1_TAIL_LOCK_FOREIGN_');
      expect(f.files.has(path)).toBe(true);
      expect(f.events).toEqual([]);
    },
  );
  it('does not normalize a known inode twin whose bytes became foreign', () => {
    const f = fixture();
    f.crash(4);
    expect(() => f.instance().claim(() => {})).toThrow('SYNTHETIC_ACK_LOST');
    const path = R1_TAIL_LOCKS[0]!,
      row = f.files.get(path)!;
    expect(row.nlink).toBe(2);
    row.bytes = Buffer.from('foreign-in-place');
    f.clear();
    const recovery = f.instance();
    recovery.load();
    expect(() => recovery.release()).toThrow('R1_TAIL_LOCK_FOREIGN_BYTES');
    expect(f.events).toEqual([]);
    expect(row.nlink).toBe(2);
    expect([...f.files.keys()].filter((name) => name.startsWith(path + '.incoming-'))).toHaveLength(
      1,
    );
  });
  it('checks current authority again before each lock publication', () => {
    const f = fixture();
    let checks = 0;
    expect(() =>
      f.instance().claim(() => {
        if (++checks === 4) throw Error('EXPIRED');
      }),
    ).toThrow('EXPIRED');
    const recovery = f.instance();
    recovery.load();
    recovery.release();
    expect(R1_TAIL_LOCKS.some((path) => f.files.has(path))).toBe(false);
  });
});
