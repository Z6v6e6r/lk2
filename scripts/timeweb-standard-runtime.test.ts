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
