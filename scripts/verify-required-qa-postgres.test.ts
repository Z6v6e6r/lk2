import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const verifier = 'scripts/verify-required-qa-postgres.py';
const code = `
import runpy, sys, xml.etree.ElementTree as ET
module = runpy.run_path('${verifier}')
root = ET.Element('testsuites')
for filename, (group, titles) in module['SUITES'].items():
    suite = ET.SubElement(root, 'testsuite', name=filename, tests=str(len(titles)), failures='0', errors='0', skipped='0')
    for title in titles:
        ET.SubElement(suite, 'testcase', classname=filename, name=group + ' > ' + title, time='0.001')
suite = root[0]
case = suite[0]
mutation = sys.argv[1]
if mutation == 'missing-suite': root.remove(suite)
if mutation == 'duplicate-suite': root.append(suite)
if mutation == 'missing-case': suite.remove(case)
if mutation == 'duplicate-case': suite[-1].set('name', case.get('name'))
if mutation == 'renamed-case': case.set('name', 'unrelated test')
if mutation == 'wrong-class': case.set('classname', 'unrelated.test.ts')
if mutation in ('skipped', 'failure', 'error'): ET.SubElement(case, mutation)
if mutation == 'summary-skipped': suite.set('skipped', '1')
if mutation == 'summary-errors': suite.set('errors', '1')
if mutation == 'summary-failures': suite.set('failures', '1')
if mutation == 'summary-count': suite.set('tests', '2')
if mutation == 'missing-duration': case.attrib.pop('time')
module['verify'](root)
print('VERIFIED_EIGHT_PASSED_ZERO_SKIPPED')
`;

describe('mandatory QA PostgreSQL report admission', () => {
  it('admits exactly the three capacity and five monthly-purchase confirmations', () => {
    const result = spawnSync('python3', ['-c', code, 'valid'], { encoding: 'utf8', timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('VERIFIED_EIGHT_PASSED_ZERO_SKIPPED');
  });

  it.each([
    'missing-suite',
    'duplicate-suite',
    'missing-case',
    'duplicate-case',
    'renamed-case',
    'wrong-class',
    'skipped',
    'failure',
    'error',
    'summary-skipped',
    'summary-errors',
    'summary-failures',
    'summary-count',
    'missing-duration',
  ])('refuses %s instead of a green skipped or incomplete report', (mutation) => {
    const result = spawnSync('python3', ['-c', code, mutation], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('VERIFIED_EIGHT_PASSED_ZERO_SKIPPED');
  });

  it('fails closed on a missing JUnit report', () => {
    const result = spawnSync('python3', [verifier, 'nonexistent-qa-junit.xml'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('REQUIRED_QA_POSTGRES_FAIL');
  });

  it('keeps required database URLs scoped to the test step, not the other fixture owner', () => {
    const workflow = readFileSync('.github/workflows/pull-request.yaml', 'utf8');
    const testStep = workflow.split('- name: Unit and integration tests')[1]?.split('- name:')[0];
    expect(testStep).toContain("CI_REQUIRE_QA_POSTGRES: '1'");
    expect(testStep).toContain('GAME_CAPACITY_RACE_TEST_DATABASE_URL: ${{ env.DATABASE_URL }}');
    expect(testStep).toContain(
      'SUBSCRIPTION_ACTIVATION_TEST_DATABASE_URL: ${{ env.DATABASE_URL }}',
    );
    expect(workflow).toContain(
      'run: python3 scripts/verify-required-qa-postgres.py .ci-artifacts/test-and-coverage/junit.xml',
    );
  });
});
