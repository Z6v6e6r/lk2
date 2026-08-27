import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertExactTimewebFrozenSource,
  validateTimewebFrozenSourceObservation,
} from './verify-timeweb-frozen-source.js';

const repositoryRoot = resolve(import.meta.dirname, '..');
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
const exactObservation = {
  repositoryRoot,
  repositoryRootSecure: true,
  protectedFilesSecure: true,
  gitDirectorySecure: true,
  topLevel: repositoryRoot,
  head: sourceSha,
  tree: sourceTree,
  status: '',
};

describe('Timeweb frozen source authority', () => {
  it('accepts only the exact clean current Git source', () => {
    expect(
      assertExactTimewebFrozenSource({
        expectedSourceSha: sourceSha,
        expectedSourceTree: sourceTree,
      }),
    ).toMatchObject({ sourceSha, sourceTree });
  });

  it('rejects later source, wrong tree, dirty/untracked state, and unsafe paths', () => {
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
        { ...exactObservation, status: ' M deploy/timeweb/compose.beta.yaml' },
        { sourceSha, sourceTree },
      ),
    ).toThrow('frozen_source_dirty');
    expect(() =>
      validateTimewebFrozenSourceObservation(
        { ...exactObservation, status: '?? scripts/untracked-controller.js' },
        { sourceSha, sourceTree },
      ),
    ).toThrow('frozen_source_dirty');
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
