import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('does not require or start an absent Realtime, but still rejects unhealthy running Realtime', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import {inspectOptionalRealtime} from './scripts/run-timeweb-standard-delivery.js';
    assert.equal(inspectOptionalRealtime(()=>'',()=>{throw Error('must not inspect absent service')}),null);
    const running={id:'container',image:'immutable',restarts:0};
    assert.equal(inspectOptionalRealtime(()=>'id',()=>running),running);
    assert.throws(()=>inspectOptionalRealtime(()=>'id',()=>{throw Error('unhealthy')}),/unhealthy/);
  `,
    ],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
});

it('accepts a running worker only as the declared baseline image and fails closed on drift', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import {inspectOptionalWorker, workerBaselineIsConsistent} from './scripts/run-timeweb-standard-delivery.js';
    const digest='sha256:'+'a'.repeat(64);
    const values={PHUB_WORKER_ENABLED:'true',WORKER_IMAGE_DIGEST:digest};
    const worker={id:'container',image:'ghcr.io/z6v6e6r/phub-worker@'+digest,restarts:0};
    assert.equal(inspectOptionalWorker(()=>'',()=>{throw Error('must not inspect absent service')}),null);
    assert.equal(inspectOptionalWorker(()=>'id',()=>worker),worker);
    assert.equal(workerBaselineIsConsistent(values,worker),true);
    // Either baseline shape is accepted; only a running worker with a foreign image is drift.
    assert.equal(workerBaselineIsConsistent(values,null),true);
    assert.equal(workerBaselineIsConsistent({...values,PHUB_WORKER_ENABLED:'false'},worker),true);
    assert.equal(workerBaselineIsConsistent({...values,WORKER_IMAGE_DIGEST:'sha256:'+'b'.repeat(64)},worker),false);
    assert.equal(workerBaselineIsConsistent({PHUB_WORKER_ENABLED:'true'},null),true);
  `,
    ],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
});
