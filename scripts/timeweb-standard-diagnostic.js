// Invocation diagnostics for the enrolled standard controller, never raw command errors.
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const stages = new Set([
  'entry',
  'enrollment',
  'controller',
  'source-ci',
  'source-fetch',
  'runtime-baseline',
  'eligibility',
  'lock',
  'publication',
  'artifact',
  'preflight',
  'pull',
  'artifact-smoke',
  'rollout-journal',
  'activate',
  'initial-readiness',
  'observe',
  'attest-backend',
  'rollback',
  'complete',
]);
const reasons = new Map([
  ['Insecure enrolled path', 'ENROLLED_PATH_UNSAFE'],
  ['Enrolled root controller and numeric CI run required', 'INVOCATION_INVALID'],
  ['Controller must run from enrolled path', 'CONTROLLER_PATH_INVALID'],
  ['Standard delivery not enrolled', 'NOT_ENROLLED'],
  ['Enrolled controller changed', 'CONTROLLER_DRIFT'],
  ['Truncated source jobs', 'SOURCE_JOBS_TRUNCATED'],
  ['Main moved; next successful main run owns the release', 'MAIN_DRIFT'],
  ['Already installed source requires successful-receipt reconciliation', 'ALREADY_INSTALLED'],
  ['Installed baseline drift', 'BASELINE_DRIFT'],
  ['Backend/configuration changed', 'BACKEND_DRIFT'],
  ['Unexpected active writer', 'ACTIVE_WRITER'],
  ['Invalid installed release identity', 'BASELINE_ID_INVALID'],
  ['Noncanonical baseline environment', 'BASELINE_ENV_INVALID'],
  ['Invalid canonical publication run', 'PUBLICATION_INVALID'],
  ['Truncated artifact inventory', 'ARTIFACT_INVENTORY_TRUNCATED'],
  ['Invalid canonical artifact', 'ARTIFACT_INVALID'],
  ['Existing candidate directory requires reconciliation', 'CANDIDATE_EXISTS'],
  ['Canonical archive digest mismatch', 'ARTIFACT_DIGEST_MISMATCH'],
  ['Canonical archive inventory mismatch', 'ARTIFACT_CONTENT_MISMATCH'],
  ['Canonical manifest checksum mismatch', 'MANIFEST_DIGEST_MISMATCH'],
  ['Canonical source mismatch', 'ARTIFACT_SOURCE_MISMATCH'],
  ['Publication already exists; reconcile it instead of automatic retry', 'PUBLICATION_EXISTS'],
  ['Ambiguous publication identity', 'PUBLICATION_AMBIGUOUS'],
  ['Publication rerun is not eligible', 'PUBLICATION_RERUN'],
  ['Publication failed; no automatic retry', 'PUBLICATION_FAILED'],
  ['Publication timed out; reconcile before any next publication', 'PUBLICATION_TIMEOUT'],
  ['Runtime probe failed', 'RUNTIME_PROBE_FAILED'],
  ['Web restarted or changed during observation', 'WEB_DRIFT'],
  ['Web runtime identity mismatch', 'WEB_IDENTITY_MISMATCH'],
  ['Web readiness timeout', 'WEB_READINESS_TIMEOUT'],
  ['Main changed before deployment', 'MAIN_DRIFT'],
  ['Web Compose reference mismatch', 'WEB_COMPOSE_MISMATCH'],
  ['Web restarted during initial readiness', 'WEB_RESTARTED'],
  ['Web release latency threshold', 'LATENCY_THRESHOLD'],
]);
const controlled = new WeakMap();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const validSha = (value) =>
  typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && value !== '0'.repeat(40);
const reject = () => {
  throw new Error('STANDARD_DIAGNOSTIC_UNSAFE');
};
export function standardDeliveryGuardError(message) {
  const error = new Error(message);
  const code =
    reasons.get(message) ??
    (message.startsWith('Standard release ineligible: ') ? 'RANGE_INELIGIBLE' : 'GUARD_REJECTED');
  controlled.set(error, code);
  return error;
}
export function standardDeliveryFailure(error) {
  const code =
    controlled.get(error) ??
    (Number.isInteger(error?.status) ? 'COMMAND_FAILED' : 'UNCLASSIFIED_FAILURE');
  return {
    code,
    ...(Number.isInteger(error?.status) && error.status >= 0 && error.status <= 255
      ? { exitCode: error.status }
      : {}),
    ...(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT'].includes(error?.signal)
      ? { signal: error.signal }
      : {}),
  };
}
function secure(path, mode, ancestor = false) {
  const s = lstatSync(path);
  if (
    s.isSymbolicLink() ||
    (s.uid !== process.getuid() && !(ancestor && s.uid === 0)) ||
    (s.gid !== process.getgid() && !(ancestor && s.uid === 0)) ||
    s.mode & 0o022 ||
    (mode !== undefined && (s.mode & 0o777) !== mode) ||
    (!s.isDirectory() && (!s.isFile() || s.nlink !== 1))
  )
    reject();
  if (path !== '/') secure(dirname(path), undefined, true);
}
function identity(input) {
  if (
    typeof input.sourceCiRunId !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(input.sourceCiRunId) ||
    !validSha(input.controllerSha)
  )
    reject();
  return { sourceCiRunId: input.sourceCiRunId, controllerSha: input.controllerSha };
}
function syncDirectory(path) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function createStandardDeliveryDiagnostic(directory, input) {
  const pinned = identity(input);
  secure(dirname(directory));
  if (!existsSync(directory)) {
    mkdirSync(directory, { mode: 0o700 });
    syncDirectory(dirname(directory));
  }
  secure(directory, 0o700);
  const diagnosticId = `${pinned.sourceCiRunId}-${randomBytes(16).toString('hex')}`;
  const path = join(directory, `${diagnosticId}.json`);
  let current = {
    schema: 'PHUB_STANDARD_DELIVERY_DIAGNOSTIC_V1',
    diagnosticId,
    ...pinned,
    status: 'STARTED',
    stage: 'entry',
    startedAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
  };
  let checksum;
  let available = true;
  function persist(next) {
    secure(directory, 0o700);
    if (existsSync(path)) {
      secure(path, 0o600);
      if (!checksum || hash(readFileSync(path)) !== checksum) reject();
    } else if (checksum) reject();
    const temporary = `${path}.new`;
    const fd = openSync(temporary, 'wx', 0o600);
    const bytes = Buffer.from(JSON.stringify(next) + '\n');
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    secure(temporary, 0o600);
    renameSync(temporary, path);
    syncDirectory(directory);
    secure(path, 0o600);
    checksum = hash(bytes);
    if (hash(readFileSync(path)) !== checksum) reject();
    current = next;
    return {
      diagnosticId,
      receiptSha256: checksum,
      stage: current.stage,
      failedStage: current.failureHistory?.[0]?.stage ?? current.stage,
      failedCode: current.failureHistory?.[0]?.code ?? current.failure?.code ?? 'NONE',
      status: current.status,
      code: current.failure?.code ?? 'NONE',
      ...pinned,
    };
  }
  persist(current);
  function capture(next) {
    // Diagnostics must never turn an otherwise unchanged rollout into a rollback.
    if (available) {
      try {
        persist(next);
        return;
      } catch {
        available = false;
      }
    }
    current = next;
  }
  function terminal(next) {
    if (!available) reject();
    try {
      return persist(next);
    } catch {
      available = false;
      reject();
    }
  }
  return {
    stage(stage, context = {}) {
      if (current.status !== 'STARTED' || !stages.has(stage)) reject();
      const allowed = {};
      for (const [key, value] of Object.entries(context)) {
        if (key === 'candidateSha' && validSha(value)) allowed[key] = value;
        else if (
          key === 'publicationRunId' &&
          typeof value === 'string' &&
          /^[1-9][0-9]{0,19}$/.test(value)
        )
          allowed[key] = value;
        else reject();
      }
      capture({ ...current, ...allowed, stage, observedAt: new Date().toISOString() });
    },
    async boundary(stage, operation) {
      this.stage(stage);
      try {
        return await operation();
      } catch (error) {
        const failureHistory = [
          ...(current.failureHistory ?? []),
          { stage: current.stage, ...standardDeliveryFailure(error) },
        ].slice(0, 8);
        capture({ ...current, failureHistory, observedAt: new Date().toISOString() });
        throw error;
      }
    },
    stop(error) {
      return terminal({
        ...current,
        status: 'STOPPED',
        failure: standardDeliveryFailure(error),
        observedAt: new Date().toISOString(),
      });
    },
    success() {
      return terminal({
        ...current,
        status: 'SUCCESS',
        stage: 'complete',
        observedAt: new Date().toISOString(),
      });
    },
  };
}
