import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertExactTimewebFrozenSource,
  runTimewebSourceGit,
  validateTimewebFrozenSourceObservation,
} from './verify-timeweb-frozen-source.js';

const repositoryRoot = resolve(import.meta.dirname, '..');
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
const exactObservation = {
  repositoryRoot,
  repositoryRootSecure: true,
  protectedFilesSecure: true,
  gitMetadataSecure: true,
  protectedFilesMatchTree: true,
  releaseSourcePathSecure: true,
  topLevel: repositoryRoot,
  head: sourceSha,
  tree: sourceTree,
};

describe('Timeweb frozen source authority', () => {
  it('binds the shared commercial env validator as privileged executable source', () => {
    const source = readFileSync(
      resolve(repositoryRoot, 'scripts/verify-timeweb-frozen-source.js'),
      'utf8',
    );
    const paths = source.slice(
      source.indexOf('const PROTECTED_PATHS'),
      source.indexOf('const trustedAuthorities'),
    );
    expect(paths).toContain("'scripts/timeweb-commercial-runtime-contract.js'");
  });
  it('accepts only the exact clean current Git source', () => {
    expect(
      assertExactTimewebFrozenSource({
        expectedSourceSha: sourceSha,
        expectedSourceTree: sourceTree,
      }),
    ).toMatchObject({ sourceSha, sourceTree });
  });

  it('does not expose Git commands that can invoke repository hooks, filters, or fsmonitor', () => {
    expect(() => runTimewebSourceGit(['status', '--porcelain=v1'])).toThrow(
      'frozen_source_git_command',
    );
    expect(() => runTimewebSourceGit(['config', '--local', '--list'])).toThrow(
      'frozen_source_git_command',
    );
  });

  it('rejects later source, wrong tree, unbound protected bytes, and unsafe paths', () => {
    expect(() =>
      validateTimewebFrozenSourceObservation(
        { ...exactObservation, head: 'f'.repeat(40) },
        { sourceSha, sourceTree },
      ),
    ).toThrow('frozen_source_identity');
    expect(() =>
      validateTimewebFrozenSourceObservation(
        { ...exactObservation, tree: 'e'.repeat(40) },
        { sourceSha, sourceTree },
      ),
    ).toThrow('frozen_source_identity');
    expect(() =>
      validateTimewebFrozenSourceObservation(
        { ...exactObservation, protectedFilesMatchTree: false },
        { sourceSha, sourceTree },
      ),
    ).toThrow('frozen_source_path_security');
    expect(() =>
      validateTimewebFrozenSourceObservation(
        { ...exactObservation, gitMetadataSecure: false },
        { sourceSha, sourceTree },
      ),
    ).toThrow('frozen_source_path_security');
    expect(() =>
      validateTimewebFrozenSourceObservation(
        { ...exactObservation, protectedFilesSecure: false },
        { sourceSha, sourceTree },
      ),
    ).toThrow('frozen_source_path_security');
    expect(() =>
      validateTimewebFrozenSourceObservation(
        { ...exactObservation, topLevel: '/tmp/not-the-frozen-checkout' },
        { sourceSha, sourceTree },
      ),
    ).toThrow('frozen_source_identity');
  });
});
