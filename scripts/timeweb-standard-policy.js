import { execFileSync } from 'node:child_process';
import { isPresentationPath, verifyPresentationRange } from './presentation-boundary.js';

export function standardReleasePlan({ paths, presentationVerified, backendUnchanged }) {
  if (!Array.isArray(paths) || paths.length === 0) return { eligible: false, reason: 'empty' };
  const docs = (path) => /^(?:docs\/.+|AGENTS|README)\.md$/.test(path);
  if (
    !backendUnchanged ||
    !presentationVerified ||
    paths.some((path) => !docs(path) && !isPresentationPath(path))
  ) {
    return { eligible: false, reason: 'cumulative-critical-shared-or-unknown' };
  }
  if (paths.every(docs)) return { eligible: false, reason: 'docs-no-runtime-release' };
  return {
    eligible: true,
    component: 'web',
    stages: ['source', 'publication', 'artifact-smoke', 'web-up', 'observe', 'receipt'],
    reason: 'presentation',
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
