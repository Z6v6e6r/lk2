import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const source = readFileSync('.github/workflows/mobile-android.yaml', 'utf8');
interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string | boolean>;
  'continue-on-error'?: boolean;
}
interface Job {
  if?: string;
  environment?: unknown;
  env?: Record<string, string>;
  steps: Step[];
}
const workflow = parse(source) as {
  permissions: Record<string, string>;
  on: { pull_request: { paths: string[] } };
  jobs: Record<string, Job>;
};
const job = workflow.jobs['unsigned-native']!;
const commands = job.steps.map((step: { run?: string }) => step.run ?? '').join('\n');
const gradle = readFileSync('apps/mobile/android/app/build.gradle', 'utf8');
const verify = job.steps.find(
  (step: { name?: string }) =>
    step.name === 'Require complete native test reports and an unsigned application',
)?.run as string;
const reportCheck = verify.match(/python3 - <<'PYTEST'\n([\s\S]*?)\nPYTEST/)?.[1];
const classes = [
  'ru.padlhub.app.AndroidGameJoinSessionTest',
  'ru.padlhub.app.AndroidTournamentChatSessionTest',
  'ru.padlhub.app.AndroidTournamentSessionTest',
  'ru.padlhub.app.AndroidTrainingRegistrationSessionTest',
  'ru.padlhub.app.AndroidSelfLeaveSessionTest',
  'ru.padlhub.app.AndroidYandexLoginCallbackUrlTest',
  'com.getcapacitor.myapp.ExampleUnitTest',
];

describe('Android native CI boundary', () => {
  it('checks exact PR source without credentials, target environment or activation', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(job.environment).toBeUndefined();
    expect(job.env).toEqual({
      VITE_PHUB_API_BASE_URL: '',
      VITE_PHUB_TENANT_KEY: '',
      PADLHUB_IOS_PUSH_ENABLED: 'false',
    });
    expect(job.steps[0]?.with?.ref).toContain('github.event.pull_request.head.sha');
    expect(job.steps[0]?.with?.['persist-credentials']).toBe(false);
    expect(source).not.toMatch(
      /secrets\.|environment:|pull_request_target|workflow_run|fastlane|keytool|signingConfigs|bundleRelease|assembleDebug/,
    );
    expect(workflow.on.pull_request.paths).toEqual(
      expect.arrayContaining([
        'apps/mobile/**',
        'apps/web/**',
        'packages/api-sdk/**',
        'package-lock.json',
        'scripts/android-native-build.test.ts',
      ]),
    );
    for (const step of job.steps) if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
  });

  it('builds actual unsigned native source and executes real JVM assertions without masking Android stubs', () => {
    expect(commands).toContain('npm run contracts:generate');
    expect(commands).toContain('npm exec -w @phub/mobile -- cap sync android');
    expect(commands).toContain(':app:testDebugUnitTest :app:assembleRelease');
    expect(gradle).toContain('testImplementation "org.json:json:20240303"');
    expect(gradle).not.toMatch(/returnDefaultValues|ignoreFailures|signingConfig|signingConfigs/);
    expect(commands).toContain('app-release-unsigned.apk');
    expect(commands).toContain('Missing META-INF/MANIFEST.MF');
    expect(commands).toContain('sha256sum');
    expect(commands).not.toMatch(/adb |connectedAndroidTest|installRelease|publish|curl |wget /);
    expect(
      job.steps.some((step: { 'continue-on-error'?: boolean }) => step['continue-on-error']),
    ).toBe(false);
  });

  it('refuses signed-release claims and retains only unsigned build and test evidence', () => {
    const gate = workflow.jobs['signed-release-gate']!;
    expect(gate.if).toContain("inputs.operation == 'signed-release'");
    expect(gate.if).toContain("github.event_name == 'push'");
    expect(gate.steps[0]?.run).toContain('ANDROID_SIGNED_RELEASE_NOT_IMPLEMENTED');
    expect(gate.steps[0]?.run).toContain('exit 1');
    const artifact = job.steps.find((step: { uses?: string }) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    );
    expect((artifact?.with?.path as string).trim().split('\n')).toHaveLength(3);
    expect(artifact?.with?.path).not.toMatch(/keystore|google-services|\.env|\*\*|gradle\//);
    expect(artifact?.with?.['if-no-files-found']).toBe('error');
  });

  it.each([
    'valid',
    'missing',
    'skipped',
    'failure',
    'empty',
    'malformed',
    'count-mismatch',
    'case-failure',
  ])('executes the actual report guard against %s results', (variant) => {
    expect(reportCheck).toBeDefined();
    const own = mkdtempSync(join(tmpdir(), 'r1-android-report-'));
    try {
      const directory = join(own, 'apps/mobile/android/app/build/test-results/testDebugUnitTest');
      mkdirSync(directory, { recursive: true });
      for (const [index, name] of classes.entries()) {
        if (variant === 'missing' && index === 0) continue;
        const count = variant === 'empty' ? 0 : [7, 6, 5, 5, 3, 3, 1][index];
        writeFileSync(
          join(directory, `TEST-${name}.xml`),
          variant === 'malformed'
            ? '<invalid>'
            : `<testsuite name="${name}" tests="${count}" failures="${variant === 'failure' && index === 0 ? 1 : 0}" errors="0" skipped="${variant === 'skipped' && index === 0 ? 1 : 0}">${Array.from({ length: variant === 'count-mismatch' ? 0 : (count ?? 0) }, (_, n) => `<testcase name="case${n}">${variant === 'case-failure' ? '<failure/>' : ''}</testcase>`).join('')}</testsuite>`,
        );
      }
      const result = spawnSync('python3', ['-'], {
        input: reportCheck,
        encoding: 'utf8',
        cwd: own,
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status === 0).toBe(variant === 'valid');
      if (variant === 'valid')
        expect(result.stdout).toContain('30 passed, zero failures/errors/skips');
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });
});
