import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs';

const directory = '/run/phub/fcm-rollout-gate';
const keys = ['operationSha256', 'planSha256', 'releaseId', 'workerImage'] as const;
const envKeys = [
  'FCM_ROLLOUT_OPERATION_SHA256',
  'FCM_ROLLOUT_PLAN_SHA256',
  'FCM_ROLLOUT_RELEASE_ID',
  'FCM_ROLLOUT_WORKER_IMAGE',
] as const;

/** No gate is the legacy mode. Any partial configuration fails closed. Never cache this read. */
export function fcmRolloutClaimAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const names = ['FCM_ROLLOUT_GATE_DIRECTORY', ...envKeys];
  if (names.every((key) => env[key] === undefined)) return true;
  if (env.FCM_ROLLOUT_GATE_DIRECTORY !== directory || envKeys.some((key) => !env[key]))
    return false;
  if (
    !/^[a-f0-9]{64}$/.test(env.FCM_ROLLOUT_OPERATION_SHA256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(env.FCM_ROLLOUT_PLAN_SHA256 ?? '') ||
    !/^[a-f0-9]{40}-[1-9][0-9]*-1$/.test(env.FCM_ROLLOUT_RELEASE_ID ?? '') ||
    !/^ghcr\.io\/z6v6e6r\/phub-worker@sha256:[a-f0-9]{64}$/.test(env.FCM_ROLLOUT_WORKER_IMAGE ?? '')
  )
    return false;
  try {
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== 0 ||
      stat.gid !== 0 ||
      (stat.mode & 0o7777) !== 0o755
    )
      return false;
    if (
      JSON.stringify(readdirSync(directory).sort()) !==
      JSON.stringify(['held.json', 'released.json'])
    )
      return false;
    for (const state of ['held', 'released']) {
      const fd = openSync(`${directory}/${state}.json`, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const file = fstatSync(fd);
        if (
          !file.isFile() ||
          file.nlink !== 1 ||
          file.uid !== 0 ||
          file.gid !== 0 ||
          (file.mode & 0o7777) !== 0o644 ||
          file.size < 1 ||
          file.size > 2048
        )
          return false;
        const expected = {
          schema: 'PHUB_FCM_ROLLOUT_GATE_V1',
          state: state.toUpperCase(),
          ...Object.fromEntries(keys.map((key, index) => [key, env[envKeys[index]!]])),
        };
        // Canonical bytes also reject duplicate JSON members and noncanonical/incomplete writes.
        if (readFileSync(fd, 'utf8') !== JSON.stringify(expected) + '\n') return false;
      } finally {
        closeSync(fd);
      }
    }
    return true;
  } catch {
    return false;
  }
}
