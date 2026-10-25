// Monotonic, candidate-only filesystem barrier. No provider configuration or delivery writes.
import { createHash } from 'node:crypto';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  fchmodSync,
  fsyncSync,
  writeSync,
  linkSync,
  unlinkSync,
} from 'node:fs';
const fail = (code) => {
  throw Error('NOTIFICATION_DELIVERY_GATE_' + code);
};
export const FCM_GATE_TARGET = '/run/phub/fcm-rollout-gate';
export function fcmGateBinding(op, operationSha256, planSha256) {
  if (![operationSha256, planSha256].every((v) => /^[a-f0-9]{64}$/.test(v ?? ''))) fail('BINDING');
  return {
    operationSha256,
    planSha256,
    releaseId: `${op.candidateSha}-${op.publicationRunId}-1`,
    workerImage: op.workerImage,
  };
}
export const fcmGateToken = (binding, state) =>
  JSON.stringify({ schema: 'PHUB_FCM_ROLLOUT_GATE_V1', state, ...binding }) + '\n';
export function fcmGateEnvironment(binding) {
  return {
    FCM_ROLLOUT_GATE_DIRECTORY: FCM_GATE_TARGET,
    FCM_ROLLOUT_OPERATION_SHA256: binding.operationSha256,
    FCM_ROLLOUT_PLAN_SHA256: binding.planSha256,
    FCM_ROLLOUT_RELEASE_ID: binding.releaseId,
    FCM_ROLLOUT_WORKER_IMAGE: binding.workerImage,
  };
}
export function fcmGateComposeOverride(directory, binding) {
  return (
    JSON.stringify({
      services: {
        worker: {
          environment: fcmGateEnvironment(binding),
          volumes: [
            {
              type: 'bind',
              source: directory,
              target: FCM_GATE_TARGET,
              read_only: true,
              bind: { create_host_path: false },
            },
          ],
        },
      },
    }) + '\n'
  );
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function validateDirectory(directory) {
  const st = lstatSync(directory);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.uid !== 0 ||
    st.gid !== 0 ||
    (st.mode & 0o7777) !== 0o755
  )
    fail('DIRECTORY');
}
function tokenContents(path, modes = [0o644], links = [1]) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.uid !== 0 ||
      st.gid !== 0 ||
      !modes.includes(st.mode & 0o7777) ||
      !links.includes(st.nlink) ||
      st.size > 2048
    )
      fail('TOKEN_CUSTODY');
    return { bytes: readFileSync(fd), stat: st };
  } finally {
    closeSync(fd);
  }
}
function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function validateInventory(directory, state) {
  const allowed =
    state === 'HELD'
      ? ['held.json', '.held.incoming']
      : ['held.json', 'released.json', '.released.incoming'];
  if (readdirSync(directory).some((name) => !allowed.includes(name))) fail('INVENTORY');
}
function createToken(directory, binding, state) {
  validateDirectory(directory);
  validateInventory(directory, state);
  const path = `${directory}/${state.toLowerCase()}.json`,
    incoming = `${directory}/.${state.toLowerCase()}.incoming`;
  const bytes = Buffer.from(fcmGateToken(binding, state));
  // A crash may leave only the operation-owned prefix, or the exact two-name inode.
  // A final path is never overwritten. Only an unpublished exact prefix is discarded.
  if (present(path)) {
    const final = tokenContents(path, [0o644], [1, 2]);
    if (!final.bytes.equals(bytes)) fail('TOKEN_BINDING');
    if (present(incoming)) {
      const staged = tokenContents(incoming, [0o644], [2]);
      if (
        final.stat.nlink !== 2 ||
        staged.stat.dev !== final.stat.dev ||
        staged.stat.ino !== final.stat.ino ||
        !staged.bytes.equals(bytes)
      )
        fail('TOKEN_TWIN');
      unlinkSync(incoming);
    } else if (final.stat.nlink !== 1) fail('TOKEN_TWIN');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    syncDirectory(directory);
    return;
  }
  if (present(incoming)) {
    const staged = tokenContents(incoming, [0o600, 0o644], [1]);
    if (!staged.bytes.equals(bytes.subarray(0, staged.bytes.length))) fail('TOKEN_PREFIX');
    unlinkSync(incoming);
    syncDirectory(directory);
  }
  const fd = openSync(
    incoming,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const n = writeSync(fd, bytes, offset, bytes.length - offset);
      if (n < 1) fail('WRITE');
      offset += n;
    }
    fchmodSync(fd, 0o644);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  linkSync(incoming, path); // no-replace publication; directory bind observes the new name
  syncDirectory(directory);
  unlinkSync(incoming);
  syncDirectory(directory);
}
// Read-only pre-runtime failure classification; no cleanup or terminal authority for a sender.
export function classifyFcmGatePreparation(directory, binding) {
  if (!present(directory)) return 'ABSENT';
  validateDirectory(directory);
  validateInventory(directory, 'HELD');
  if (present(`${directory}/held.json`)) {
    const final = tokenContents(`${directory}/held.json`, [0o644], [1, 2]);
    if (final.bytes.toString() !== fcmGateToken(binding, 'HELD')) fail('TOKEN_BINDING');
    if (present(`${directory}/.held.incoming`)) {
      const twin = tokenContents(`${directory}/.held.incoming`, [0o644], [2]);
      if (
        final.stat.nlink !== 2 ||
        final.stat.ino !== twin.stat.ino ||
        final.stat.dev !== twin.stat.dev ||
        !final.bytes.equals(twin.bytes)
      )
        fail('TOKEN_TWIN');
      return 'HELD_WITH_EXACT_TWIN';
    }
    if (final.stat.nlink !== 1) fail('TOKEN_TWIN');
    return 'HELD';
  }
  if (present(`${directory}/.held.incoming`)) {
    const prefix = tokenContents(`${directory}/.held.incoming`, [0o600, 0o644], [1]).bytes;
    if (!prefix.equals(Buffer.from(fcmGateToken(binding, 'HELD')).subarray(0, prefix.length)))
      fail('TOKEN_PREFIX');
    return 'UNPUBLISHED_HELD_PREFIX';
  }
  return 'EMPTY';
}
export function readFcmDeliveryGate(directory, binding) {
  validateDirectory(directory);
  const names = readdirSync(directory).sort();
  if (!['["held.json"]', '["held.json","released.json"]'].includes(JSON.stringify(names)))
    fail('INVENTORY');
  for (const name of names) {
    const fd = openSync(`${directory}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (
        !st.isFile() ||
        st.nlink !== 1 ||
        st.uid !== 0 ||
        st.gid !== 0 ||
        (st.mode & 0o7777) !== 0o644 ||
        st.size < 1 ||
        st.size > 2048
      )
        fail('TOKEN_CUSTODY');
      if (
        readFileSync(fd, 'utf8') !==
        fcmGateToken(binding, name === 'held.json' ? 'HELD' : 'RELEASED')
      )
        fail('TOKEN_BINDING');
    } finally {
      closeSync(fd);
    }
  }
  return names.length === 1 ? 'HELD' : 'RELEASED';
}
export function holdFcmDeliveryGate(directory, binding) {
  mkdirSync(directory, { mode: 0o755 });
  const fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    fchmodSync(fd, 0o755);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(directory.slice(0, directory.lastIndexOf('/')));
  validateDirectory(directory);
  createToken(directory, binding, 'HELD');
  if (readFcmDeliveryGate(directory, binding) !== 'HELD') fail('HOLD');
}
export function classifyFcmGateRelease(directory, binding) {
  validateDirectory(directory);
  validateInventory(directory, 'RELEASED');
  const held = tokenContents(`${directory}/held.json`);
  if (held.bytes.toString() !== fcmGateToken(binding, 'HELD')) fail('TOKEN_BINDING');
  const finalPath = `${directory}/released.json`,
    incomingPath = `${directory}/.released.incoming`;
  if (present(finalPath)) {
    const final = tokenContents(finalPath, [0o644], [1, 2]);
    if (final.bytes.toString() !== fcmGateToken(binding, 'RELEASED')) fail('TOKEN_BINDING');
    if (present(incomingPath)) {
      const incoming = tokenContents(incomingPath, [0o644], [2]);
      if (
        final.stat.nlink !== 2 ||
        final.stat.dev !== incoming.stat.dev ||
        final.stat.ino !== incoming.stat.ino ||
        !final.bytes.equals(incoming.bytes)
      )
        fail('TOKEN_TWIN');
    } else if (final.stat.nlink !== 1) fail('TOKEN_TWIN');
    return 'RELEASED';
  }
  if (present(incomingPath)) {
    const prefix = tokenContents(incomingPath, [0o600, 0o644], [1]).bytes;
    if (!prefix.equals(Buffer.from(fcmGateToken(binding, 'RELEASED')).subarray(0, prefix.length)))
      fail('TOKEN_PREFIX');
  }
  return 'HELD';
}
export function releaseFcmDeliveryGate(directory, binding) {
  // Only callers holding durable release intent may finish a published/unpublished token.
  validateDirectory(directory);
  const held = tokenContents(`${directory}/held.json`);
  if (held.bytes.toString() !== fcmGateToken(binding, 'HELD')) fail('TOKEN_BINDING');
  createToken(directory, binding, 'RELEASED');
  if (readFcmDeliveryGate(directory, binding) !== 'RELEASED') fail('RELEASE');
}
export function validateFcmGateRuntime(actual, directory, binding) {
  const mounts = actual.mounts.filter((m) => m.Destination === FCM_GATE_TARGET);
  if (
    mounts.length !== 1 ||
    mounts[0].Type !== 'bind' ||
    mounts[0].Source !== directory ||
    mounts[0].RW !== false
  )
    fail('MOUNT');
  const env = actual.environment;
  for (const [key, value] of Object.entries(fcmGateEnvironment(binding))) {
    if (env.filter((v) => v.startsWith(key + '=')).length !== 1 || !env.includes(key + '=' + value))
      fail('ENVIRONMENT');
  }
  return true;
}
export const fcmGateTokenSha256 = (binding, state) =>
  createHash('sha256').update(fcmGateToken(binding, state)).digest('hex');
