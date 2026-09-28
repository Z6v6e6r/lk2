import { execFileSync } from 'node:child_process';
import { isPresentationPath, verifyPresentationRange } from './presentation-boundary.js';
import { isSafeWebPath, verifySafeWebRange } from './safe-web-boundary.js';

/**
 * Two delivery classes share the standard Web route: proven presentation edits, and the allowlisted
 * safe-Web modules of `safe-web-boundary.js`. Both must be verified on the exact range, because the
 * controller runs this against the installed baseline and the candidate; an unverified class fails
 * closed, and every other path keeps the critical/manual component release route.
 */
export function standardReleasePlan({
  paths,
  presentationVerified,
  safeWebVerified = false,
  backendUnchanged,
}) {
  if (!Array.isArray(paths) || paths.length === 0) return { eligible: false, reason: 'empty' };
  const docs = (path) => /^(?:docs\/.+|AGENTS|README)\.md$/.test(path);
  const unknown = (path) => !docs(path) && !isPresentationPath(path) && !isSafeWebPath(path);
  if (!backendUnchanged || paths.some(unknown)) {
    return { eligible: false, reason: 'cumulative-critical-shared-or-unknown' };
  }
  // Each class is verified on its own: a verified safe-Web range never vouches for a presentation
  // path, and vice versa.
  if (paths.some(isPresentationPath) && !presentationVerified) {
    return { eligible: false, reason: 'cumulative-critical-shared-or-unknown' };
  }
  if (paths.some(isSafeWebPath) && !safeWebVerified) {
    return { eligible: false, reason: 'cumulative-critical-shared-or-unknown' };
  }
  // A range that ships no runtime code (documentation only, or only test files of an allowlisted
  // module) is not a Web release: publishing and restarting Web for it would create production work
  // and a receipt with no deployed change.
  const runtimePath = (path) => !docs(path) && !/\.test\.(?:ts|tsx)$/.test(path);
  if (!paths.some(runtimePath)) return { eligible: false, reason: 'docs-no-runtime-release' };
  return {
    eligible: true,
    component: 'web',
    stages: ['source', 'publication', 'artifact-smoke', 'web-up', 'observe', 'receipt'],
    reason: paths.some(isSafeWebPath) ? 'safe-web' : 'presentation',
  };
}

export function standardRange(base, head) {
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? '')))
    throw new Error('Invalid release source');
  execFileSync('git', ['merge-base', '--is-ancestor', base, head], { stdio: 'pipe' });
  const paths = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, head], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  return standardReleasePlan({
    paths,
    presentationVerified: verifyPresentationRange(paths, base, head),
    safeWebVerified: verifySafeWebRange(paths, base, head),
    backendUnchanged: true,
  });
}

export async function runWebTransition(operations) {
  await operations.preflight();
  await operations.pull();
  await operations.artifactSmoke();
  // Journal before any activation; a process crash leaves an explicit pending receipt.
  await operations.journal('pending');
  try {
    await operations.activate();
    await operations.observe();
    await operations.attestBackend();
    await operations.journal('success');
  } catch (error) {
    try {
      await operations.rollback();
      await operations.attestBackend();
      await operations.journal('rolled-back');
    } catch {
      await operations.journal('rollback-failed');
      throw new Error('Web release failed and compatible rollback was not proven');
    }
    throw error;
  }
}

export function standardWebComposeArgs(composeFile, baselineEnv, overlayEnv, operation) {
  const stages = {
    pull: ['pull', 'web'],
    up: ['up', '-d', '--no-deps', 'web'],
    config: ['config', '--format', 'json'],
  };
  if (!Object.hasOwn(stages, operation)) throw new Error('Unsupported standard Web stage');
  return [
    'compose',
    '--env-file',
    baselineEnv,
    '--env-file',
    overlayEnv,
    '-f',
    composeFile,
    ...stages[operation],
  ];
}
