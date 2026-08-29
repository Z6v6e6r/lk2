#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 2_000;
const BUILDER_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/u;
const BUILDKIT_IMAGE = /^moby\/buildkit@sha256:[a-f0-9]{64}$/u;
const BUILDKIT_VERSION = /^v[0-9]+\.[0-9]+\.[0-9]+$/u;
const SERVICE_SET = new Set(['api', 'web']);
const SAFE_CODE = /^[A-Z0-9_]+$/u;
const SAFE_SIGNAL = /^SIG[A-Z0-9]+$/u;
const CONTAINER_FORMAT =
  '{"image":{{json .Config.Image}},"status":{{json .State.Status}},"running":{{json .State.Running}},"restarting":{{json .State.Restarting}},"exitCode":{{json .State.ExitCode}}}';

export class BuildkitBootstrapError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'BuildkitBootstrapError';
    this.reason = reason;
  }
}

function reject(reason) {
  throw new BuildkitBootstrapError(reason);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeString(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeCode(value, pattern) {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

export function summarizeCommand(result) {
  const stdout = safeString(result.stdout);
  const stderr = safeString(result.stderr);
  return {
    exitCode: Number.isInteger(result.status) ? result.status : null,
    signal: normalizeCode(result.signal, SAFE_SIGNAL),
    timedOut: result.error?.code === 'ETIMEDOUT',
    errorCode: normalizeCode(result.error?.code, SAFE_CODE),
    stdoutBytes: Buffer.byteLength(stdout),
    stdoutSha256: sha256(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    stderrSha256: sha256(stderr),
  };
}

function defaultRunCommand(command, arguments_, timeoutMs) {
  return spawnSync(command, arguments_, {
    encoding: 'utf8',
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
    timeout: timeoutMs,
  });
}

function parseVersions(stdout) {
  return [
    ...safeString(stdout).matchAll(/^BuildKit version:\s+(v[0-9]+\.[0-9]+\.[0-9]+)\s*$/gmu),
  ].map((match) => match[1]);
}

function parseContainerState(result) {
  if (result.status !== 0) return null;
  let value;
  try {
    value = JSON.parse(safeString(result.stdout));
  } catch {
    return null;
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('|') !==
      ['exitCode', 'image', 'restarting', 'running', 'status'].sort().join('|') ||
    typeof value.image !== 'string' ||
    typeof value.status !== 'string' ||
    typeof value.running !== 'boolean' ||
    typeof value.restarting !== 'boolean' ||
    !Number.isInteger(value.exitCode)
  ) {
    return null;
  }
  return value;
}

function writeDiagnostic(path, diagnostic) {
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(diagnostic, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
}

function validateInput(input) {
  if (!SERVICE_SET.has(input.service)) reject('invalid_service');
  if (!BUILDER_NAME.test(input.builder)) reject('invalid_builder_name');
  if (!BUILDKIT_IMAGE.test(input.image)) reject('invalid_buildkit_image');
  if (!BUILDKIT_VERSION.test(input.version)) reject('invalid_buildkit_version');
  if (
    typeof input.diagnosticPath !== 'string' ||
    resolve(input.diagnosticPath) !== input.diagnosticPath ||
    !input.diagnosticPath.endsWith('.json')
  ) {
    reject('invalid_diagnostic_path');
  }
}

function diagnosticFor(input, attempts, reason, verified) {
  return {
    schemaVersion: 1,
    kind: 'phub-buildkit-bootstrap-readiness',
    service: input.service,
    builder: input.builder,
    expected: { image: input.image, version: input.version },
    maxAttempts: MAX_ATTEMPTS,
    attemptCount: attempts.length,
    reason,
    verified,
    attempts,
    pushed: false,
    authorizesPublication: false,
    authorizesDeploy: false,
  };
}

function wait(delayMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

export async function verifyPinnedBuildkitBootstrap(input, dependencies = {}) {
  validateInput(input);
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const sleep = dependencies.sleep ?? wait;
  const attempts = [];
  const containerName = `buildx_buildkit_${input.builder}0`;

  for (let number = 1; number <= MAX_ATTEMPTS; number += 1) {
    const inspect = runCommand(
      'docker',
      ['buildx', 'inspect', input.builder, '--bootstrap'],
      ATTEMPT_TIMEOUT_MS,
    );
    const container = runCommand(
      'docker',
      ['inspect', '--format', CONTAINER_FORMAT, containerName],
      ATTEMPT_TIMEOUT_MS,
    );
    const versions = parseVersions(inspect.stdout);
    const state = parseContainerState(container);
    attempts.push({
      number,
      buildxInspect: summarizeCommand(inspect),
      observedVersions: versions,
      containerInspect: summarizeCommand(container),
      containerState: state,
    });

    if (versions.some((version) => version !== input.version)) {
      const diagnostic = diagnosticFor(input, attempts, 'buildkit_version_mismatch', false);
      writeDiagnostic(input.diagnosticPath, diagnostic);
      reject('buildkit_version_mismatch');
    }
    if (state !== null && state.image !== input.image) {
      const diagnostic = diagnosticFor(input, attempts, 'buildkit_image_mismatch', false);
      writeDiagnostic(input.diagnosticPath, diagnostic);
      reject('buildkit_image_mismatch');
    }

    const ready =
      inspect.status === 0 &&
      versions.length === 1 &&
      versions[0] === input.version &&
      state !== null &&
      state.status === 'running' &&
      state.running &&
      !state.restarting;
    if (ready) {
      const diagnostic = diagnosticFor(input, attempts, 'verified', true);
      writeDiagnostic(input.diagnosticPath, diagnostic);
      return diagnostic;
    }

    writeDiagnostic(
      input.diagnosticPath,
      diagnosticFor(input, attempts, 'bootstrap_retrying', false),
    );
    if (number < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }

  writeDiagnostic(
    input.diagnosticPath,
    diagnosticFor(input, attempts, 'buildkit_bootstrap_not_ready', false),
  );
  reject('buildkit_bootstrap_not_ready');
}

function parseArguments(arguments_) {
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      reject('invalid_arguments');
    }
    const name = key.slice(2);
    if (values[name] !== undefined) reject('duplicate_argument');
    values[name] = value;
  }
  if (Object.keys(values).sort().join('|') !== 'builder|diagnostic|image|service|version') {
    reject('invalid_arguments');
  }
  return {
    service: values.service,
    builder: values.builder,
    image: values.image,
    version: values.version,
    diagnosticPath: values.diagnostic,
  };
}

async function main() {
  try {
    await verifyPinnedBuildkitBootstrap(parseArguments(process.argv.slice(2)));
  } catch (error) {
    const reason =
      error instanceof BuildkitBootstrapError ? error.reason : 'unexpected_bootstrap_error';
    console.error(`BuildKit bootstrap verification failed: ${reason}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
