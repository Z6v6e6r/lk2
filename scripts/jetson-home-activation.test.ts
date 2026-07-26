import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('Jetson live Home activation boundary', () => {
  it('takes a final readiness sample after the bounded wait and before rollback diagnostics', async () => {
    const source = await readFile(
      new URL('../deploy/jetson/activate-live-home.sh', import.meta.url),
      'utf8',
    );
    const projectionLoop = source.indexOf('while test "$attempt" -lt 24; do');
    const loopEnd = source.indexOf('\ndone\n', projectionLoop);
    const finalSample = source.indexOf('Live Home projection final readiness:');
    const rollbackDiagnostics = source.indexOf('Live Home component readiness:');

    expect(projectionLoop).toBeGreaterThan(0);
    expect(loopEnd).toBeGreaterThan(projectionLoop);
    expect(finalSample).toBeGreaterThan(loopEnd);
    expect(rollbackDiagnostics).toBeGreaterThan(finalSample);

    const boundary = source.slice(loopEnd, rollbackDiagnostics);
    expect(boundary).toContain('active_delegations="$(sql "$active_delegations_sql")"');
    expect(boundary).toContain('ready_delegations="$(sql "$ready_delegations_sql")"');
    expect(boundary).toContain('projection_ready=1');
  });
});
