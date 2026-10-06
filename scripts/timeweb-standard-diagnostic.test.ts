import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function scenario<T = unknown>(program: string): T {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { createHash } from 'node:crypto';
       import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
       import { join } from 'node:path';
       import { createStandardDeliveryDiagnostic, standardDeliveryGuardError, standardDeliveryFailure } from './scripts/timeweb-standard-diagnostic.js';
       const fixture = mkdtempSync(join(process.env.PHUB_STANDARD_DIAGNOSTIC_TEST_ROOT ?? process.cwd(), '.standard-diagnostic-test-'));
       const directory = join(fixture, 'attempts');
       const input = { sourceCiRunId: '37321861933', controllerSha: 'a'.repeat(40) };
       let diagnostic, path;
       const open = () => {
         diagnostic = createStandardDeliveryDiagnostic(directory, input);
         path = join(directory, readdirSync(directory).find(name => name.endsWith('.json')));
       };
       const read = () => JSON.parse(readFileSync(path, 'utf8'));
       const checksum = () => createHash('sha256').update(readFileSync(path)).digest('hex');
       const stop = error => { try { return diagnostic.stop(error); } catch { return 'unavailable'; } };
       try { ${program} } finally { rmSync(fixture, { recursive: true, force: true }); }`,
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as T;
}

describe('standard controller invocation diagnostics', () => {
  it('pins identity and returns a terminal pointer only after durable readback', () => {
    const stopped = scenario<{ pointer: { receiptSha256: string }; checksum: string }>(
      `open(); const started = read(); input.controllerSha = 'b'.repeat(40);
        diagnostic.stage('eligibility', {candidateSha: 'c'.repeat(40)});
        const pointer = stop(standardDeliveryGuardError('Standard release ineligible: fixture-private-detail'));
        console.log(JSON.stringify({started, receipt: read(), pointer, checksum: checksum(), mode: statSync(path).mode & 0o777}));`,
    );
    expect(stopped.pointer.receiptSha256).toBe(stopped.checksum);
    expect(stopped).toMatchObject({
      started: { status: 'STARTED', stage: 'entry' },
      receipt: {
        schema: 'PHUB_STANDARD_DELIVERY_DIAGNOSTIC_V1',
        status: 'STOPPED',
        sourceCiRunId: '37321861933',
        controllerSha: 'a'.repeat(40),
        candidateSha: 'c'.repeat(40),
        stage: 'eligibility',
        failure: { code: 'RANGE_INELIGIBLE' },
      },
      pointer: {
        diagnosticId: expect.stringMatching(/^37321861933-[a-f0-9]{32}$/) as unknown,
        receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown,
        status: 'STOPPED',
        failedStage: 'eligibility',
        failedCode: 'RANGE_INELIGIBLE',
        controllerSha: 'a'.repeat(40),
      },
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown,
      mode: 0o600,
    });
    const result = scenario<{ pointer: { receiptSha256: string }; checksum: string }>(
      `open(); const pointer = diagnostic.success(); console.log(JSON.stringify({pointer, checksum: checksum()}));`,
    );
    expect(result.pointer.receiptSha256).toBe(result.checksum);
  });

  it('never copies error text, stdout, stack, environment, or PII into a receipt or pointer', () => {
    const result = scenario<{ receipt: string; pointer: string; failure: unknown }>(
      `open(); diagnostic.stage('publication');
       const privateValue = 'synthetic-private-email@example.invalid +79990000000 token-fixture-private';
       const error = Object.assign(new Error(privateValue), {status: 17, signal: 'SIGTERM', stdout: privateValue, stderr: privateValue, args: [privateValue], env: {GH_TOKEN: privateValue}});
       const pointer = stop(error);
       console.log(JSON.stringify({receipt: readFileSync(path, 'utf8'), pointer: JSON.stringify(pointer), failure: standardDeliveryFailure(error)}));`,
    );
    expect(result.failure).toEqual({ code: 'COMMAND_FAILED', exitCode: 17, signal: 'SIGTERM' });
    expect(result.receipt + result.pointer).not.toMatch(
      /example\.invalid|79990000000|token-fixture-private|stdout|stderr|stack|GH_TOKEN/,
    );
    expect(
      scenario(
        `console.log(JSON.stringify([undefined, 'private', {message:'private', status:-1, signal:'PRIVATE'}].map(standardDeliveryFailure)));`,
      ),
    ).toEqual([
      { code: 'UNCLASSIFIED_FAILURE' },
      { code: 'UNCLASSIFIED_FAILURE' },
      { code: 'COMMAND_FAILED' },
    ]);
  });

  it.each(['sourceCiRunId', 'controllerSha', 'context', 'context-type', 'zero-sha'])(
    'rejects invalid %s without modifying pinned identity',
    (invalid) => {
      expect(
        scenario(`const invalid = ${JSON.stringify(invalid)}; let rejected = false;
          try {
            if (invalid === 'sourceCiRunId') input.sourceCiRunId = '123\\nprivate';
            if (invalid === 'controllerSha') input.controllerSha = 'private';
            if (invalid === 'zero-sha') input.controllerSha = '0'.repeat(40);
            open();
            if (invalid === 'context') diagnostic.stage('entry', {controllerSha:'b'.repeat(40)});
            if (invalid === 'context-type') diagnostic.stage('entry', {publicationRunId:123});
          } catch { rejected = true; }
          console.log(JSON.stringify({rejected}));`),
      ).toEqual({ rejected: true });
    },
  );

  it.each([
    'directory-symlink',
    'directory-mode',
    'file-symlink',
    'file-hardlink',
    'file-mode',
    'file-change',
    'temporary-conflict',
  ])('never claims readback or writes through unsafe %s', (unsafe) => {
    expect(
      scenario(`const unsafe = ${JSON.stringify(unsafe)}; let rejected = false;
          const foreign = join(fixture, 'foreign'); writeFileSync(foreign, 'foreign-preimage', {mode:0o600});
          try {
            if (unsafe === 'directory-symlink') symlinkSync(fixture, directory);
            if (unsafe === 'directory-mode') mkdirSync(directory, {mode:0o755});
            open();
            if (unsafe === 'file-symlink') { rmSync(path); symlinkSync(foreign, path); }
            if (unsafe === 'file-hardlink') { rmSync(path); linkSync(foreign, path); }
            if (unsafe === 'file-mode') chmodSync(path, 0o644);
            if (unsafe === 'file-change') writeFileSync(path, '{}');
            if (unsafe === 'temporary-conflict') writeFileSync(path + '.new', 'foreign-preimage', {mode:0o600});
            diagnostic.stage('preflight');
            diagnostic.success();
          } catch { rejected = true; }
          console.log(JSON.stringify({rejected, foreign:readFileSync(foreign, 'utf8'), pointer: diagnostic ? stop(new Error('private')) : 'unavailable'}));`),
    ).toEqual({ rejected: true, foreign: 'foreign-preimage', pointer: 'unavailable' });
  });

  it.each([
    'preflight',
    'pull',
    'artifact-smoke',
    'activate',
    'initial-readiness',
    'observe',
    'attest-backend',
    'rollback',
    'rollout-journal',
    'canonical-success-persist',
    'stage-persist',
    'initial-persist',
  ])('captures %s on the actual wired controller callbacks without extra recovery', (failure) => {
    const result = scenario<{
      calls: string[];
      receipt: { failureHistory?: { stage: string }[]; status: string } | null;
      pointer: { failedStage?: string; status?: string } | string;
    }>(`const vm = (await import('node:vm')).default;
      const { runWebTransition } = await import('./scripts/timeweb-standard-policy.js');
      const failure = ${JSON.stringify(failure)}, calls = []; let failed = false;
      if (failure === 'initial-persist') {
        mkdirSync(directory, {mode:0o755});
        try { open(); } catch { diagnostic = undefined; }
      } else { open(); diagnostic.stage('artifact'); }
      const source = readFileSync('scripts/run-timeweb-standard-delivery.js', 'utf8');
      const start = source.indexOf('await runWebTransition({');
      const transition = source.slice(start, source.indexOf('\\n  } finally {', start));
      const support = source.slice(source.indexOf('const diagnosticStage = '), source.indexOf('const fail = '));
      if (!transition.includes('finished = true;') || !support.includes('diagnosticBoundary')) throw new Error('Unrecognized controller transition');
      const effect = name => {
        calls.push(name); const stage = diagnostic ? read().stage : name;
        const primary = failure === 'rollback' ? 'activate' : failure;
        if ((!failed && stage === primary) || (failure === 'rollback' && stage === 'rollback')) {
          failed = true; throw standardDeliveryGuardError('Web runtime identity mismatch');
        }
        if (failure === 'stage-persist' && stage === 'preflight') chmodSync(path, 0o644);
      };
      const sha = 'c'.repeat(40), web = {image:'previous', releaseId:'previous'};
      const context = {
        runWebTransition, diagnostic,
        assertBackend: () => effect('backend'), git: () => sha, sha,
        compose: (_overlay, operation) => {effect(operation); return JSON.stringify({services:{web:{image:'candidate'}}});}, overlay:'overlay',
        probe: async () => {effect('probe'); return 1;}, docker: () => effect('smoke'), candidateRef:'candidate',
        writeDurable: (_path, bytes) => {const status = JSON.parse(bytes).status; effect('journal:' + status); if(failure === 'canonical-success-persist' && status === 'success') chmodSync(path, 0o644);},
        candidate:{directory:fixture, checksum:'checksum', artifactDigest:'digest'},
        config:{owner:'fixture'}, ciRunId:input.sourceCiRunId, runId:'123', api:{}, realtime:{}, worker:{}, baselineId:'baseline', sha256:()=>'checksum', baselineBytes:'bytes',
        web, id:'candidate-id', previousWebId:'previous-id', rollback:'rollback',
        waitWeb:async()=>effect('wait'), inspect:()=>({restarts:0}), fail:message=>{throw standardDeliveryGuardError(message);},
        attestWeb:()=>effect('attest'), delay:async()=>{},
        calls, process:{stdout:{write:line=>{calls.push('SUCCESS'); pointer = line.slice(line.indexOf(' diagnostic=') + 12).trim(); if(pointer !== 'unavailable') pointer = JSON.parse(pointer);}}},
      };
      let pointer;
      try {
        await vm.runInNewContext('(async()=>{let activatedWeb; let finished=false; ' + support + ' try {' + transition + '} finally { calls.push(finished ? "lock-released" : "lock-retained"); }})()', context);
      } catch(error) {pointer = stop(error);}
      console.log(JSON.stringify({calls, receipt: diagnostic ? read() : null, pointer}));`);
    if (['canonical-success-persist', 'stage-persist', 'initial-persist'].includes(failure)) {
      expect(result.calls).toContain('journal:success');
      expect(result.calls).not.toContain('journal:rolled-back');
      expect(result.calls).not.toContain('journal:rollback-failed');
      expect(result.pointer).toBe('unavailable');
      expect(result.calls).toContain('SUCCESS');
      expect(result.calls).toContain('lock-released');
      if (failure === 'initial-persist') expect(result.receipt).toBeNull();
      else expect(result.receipt?.status).toBe('STARTED');
    } else {
      const primary = failure === 'rollback' ? 'activate' : failure;
      expect(result.pointer).toMatchObject({ failedStage: primary, status: 'STOPPED' });
      expect(result.receipt?.failureHistory?.[0]?.stage).toBe(primary);
      expect(result.calls).toContain('lock-retained');
      expect(result.calls).not.toContain('journal:success');
      if (failure === 'rollback') {
        expect(result.receipt?.failureHistory?.map((item) => item.stage)).toEqual([
          'activate',
          'rollback',
        ]);
        expect(result.calls).toContain('journal:rollback-failed');
      } else if (['activate', 'initial-readiness', 'observe', 'attest-backend'].includes(failure)) {
        expect(result.calls).toContain('journal:rolled-back');
      } else {
        expect(result.calls).not.toContain('up');
      }
    }
  });

  it('preserves trust ordering, locks, and the separate manual route', () => {
    const source = readFileSync('scripts/run-timeweb-standard-delivery.js', 'utf8');
    const main = source.slice(source.indexOf('async function main(ciRunId)'));
    const initialize = main.indexOf('diagnostic = createStandardDeliveryDiagnostic(');
    for (const guard of [
      'secure(SOURCE);',
      'secure(`${SOURCE}/.git`);',
      'secure(`${SOURCE}/${path}`);',
    ]) {
      expect(main.indexOf(guard)).toBeGreaterThan(-1);
      expect(main.indexOf(guard)).toBeLessThan(initialize);
    }
    const identity = main.indexOf("const controllerSha = git(['rev-parse', 'HEAD']);");
    expect(identity).toBeLessThan(initialize);
    expect(identity).toBeGreaterThan(main.indexOf('secure(`${SOURCE}/${path}`);'));
    const complete = main.indexOf(
      'if (diagnostic) pointer = JSON.stringify(diagnostic.success());',
    );
    expect(complete).toBeGreaterThan(main.indexOf('await runWebTransition({'));
    expect(main.indexOf('finished = true;')).toBeLessThan(complete);
    expect(main).toContain('if (finished) rmSync(lock, { recursive: true });');
    expect(main).toContain("let pointer = 'unavailable';");
    expect(main).toContain('if (diagnostic) pointer = JSON.stringify(diagnostic.stop(error));');
    expect(main).toContain('runManualApiWebUpgrade(');
  });
});
