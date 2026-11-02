// Exact two-lock custody for R1 only. Publication intent includes inode identity before link.
import { r1Encode, r1Exact, r1Hash, r1Same, r1Stop } from './r1-tail-migration-profile.js';
export const R1_TAIL_LOCKS = Object.freeze([
  '/opt/phub/timeweb-beta/standard/active',
  '/etc/phub/.timeweb-beta.provision.lock',
]);
const rootPattern =
  /^\/opt\/phub\/timeweb-beta\/backups\/r1-tail108-119-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function createR1TailLockCustody(root, marker, owner, io) {
  if (!rootPattern.test(root) || !Buffer.isBuffer(marker)) r1Stop('LOCK_SCOPE');
  const file = root + '/ownership.json';
  let record = null;
  function validate(value) {
    r1Exact(value, ['schema', 'markerSha256', 'locks']);
    r1Exact(value.locks, R1_TAIL_LOCKS);
    if (value.schema !== 'PHUB_R1_TAIL_LOCK_CUSTODY_V1' || value.markerSha256 !== r1Hash(marker))
      r1Stop('LOCK_RECORD');
    for (const target of R1_TAIL_LOCKS) {
      const entry = value.locks[target];
      r1Exact(entry, ['device', 'inode', 'stage']);
      if (
        !Number.isSafeInteger(entry.device) ||
        !Number.isSafeInteger(entry.inode) ||
        entry.device < 0 ||
        entry.inode < 1 ||
        typeof entry.stage !== 'string' ||
        !entry.stage.startsWith(target + '.incoming-') ||
        !/^[a-f0-9]{24}$/.test(entry.stage.slice((target + '.incoming-').length))
      )
        r1Stop('LOCK_IDENTITY');
    }
    return value;
  }
  function matches(path, expected, normalize = false) {
    // Check sealed inode BEFORE the inherited reader can normalize an atomic twin.
    let info = io.info(path);
    if (info.dev !== expected.device || info.ino !== expected.inode) r1Stop('LOCK_FOREIGN_INODE');
    if (!io.rawRead(path).equals(marker)) r1Stop('LOCK_FOREIGN_BYTES');
    if (info.nlink === 2) {
      if (!normalize || !io.present(expected.stage)) r1Stop('LOCK_FOREIGN_TWIN');
      const twin = io.info(expected.stage);
      if (twin.dev !== expected.device || twin.ino !== expected.inode || twin.nlink !== 2)
        r1Stop('LOCK_FOREIGN_TWIN');
      if (!io.rawRead(expected.stage).equals(marker)) r1Stop('LOCK_FOREIGN_BYTES');
      io.normalize(path);
      info = io.info(path);
    }
    if (info.nlink !== 1 || !io.read(path).equals(marker)) r1Stop('LOCK_FOREIGN_BYTES');
    return true;
  }
  function load() {
    record = io.present(file) ? validate(JSON.parse(io.read(file).toString())) : null;
    return record;
  }
  function assert(full) {
    owner.assertOwned();
    if (record === null) load();
    for (const target of R1_TAIL_LOCKS) {
      if (!io.present(target)) {
        if (full) r1Stop('LOCK_MISSING');
        continue;
      }
      if (!record) r1Stop('LOCK_UNCLAIMED');
      matches(target, record.locks[target], true);
    }
    return true;
  }
  function claim(live) {
    owner.assertOwned();
    if (io.present(file) || R1_TAIL_LOCKS.some(io.present)) r1Stop('LOCK_ALREADY_PRESENT');
    const locks = {};
    for (const target of R1_TAIL_LOCKS) {
      live();
      const stage = io.stage(target, marker),
        info = io.info(stage);
      locks[target] = { device: info.dev, inode: info.ino, stage };
      if (info.nlink !== 1 || !io.read(stage).equals(marker)) r1Stop('LOCK_STAGE');
    }
    record = validate({
      schema: 'PHUB_R1_TAIL_LOCK_CUSTODY_V1',
      markerSha256: r1Hash(marker),
      locks,
    });
    io.durable(file, r1Encode(record), true); // Both identities durable before either shared name exists.
    for (const target of R1_TAIL_LOCKS) {
      owner.assertOwned();
      live();
      const entry = record.locks[target];
      matches(entry.stage, entry);
      io.link(entry.stage, target); // Exclusive; an unknown target is never overwritten.
      io.unlink(entry.stage);
      io.syncParent(target);
    }
    assert(true);
  }
  function release() {
    assert(false);
    for (const target of R1_TAIL_LOCKS) {
      owner.assertOwned();
      if (io.present(target)) {
        if (!record) r1Stop('LOCK_UNCLAIMED');
        matches(target, record.locks[target], true);
        io.unlink(target);
        io.syncParent(target);
      }
    }
    if (record)
      for (const target of R1_TAIL_LOCKS) {
        const entry = record.locks[target];
        if (io.present(entry.stage)) {
          owner.assertOwned();
          matches(entry.stage, entry);
          io.unlink(entry.stage);
          io.syncParent(entry.stage);
        }
      }
  }
  return Object.freeze({ load, claim, assert, release });
}
