import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

interface WorkflowStep {
  readonly id?: string;
  readonly run?: string;
}

interface WorkflowDocument {
  readonly jobs: Readonly<Record<string, { readonly steps: readonly WorkflowStep[] }>>;
}

const workflow = YAML.parse(
  readFileSync(
    fileURLToPath(new URL('../.github/workflows/deploy-staging.yaml', import.meta.url)),
    'utf8',
  ),
) as WorkflowDocument;
function requireValidationScript(value: string | undefined): string {
  if (!value) throw new Error('staging request validation script is missing');
  return value;
}

const validationScript = requireValidationScript(
  workflow.jobs['validate-request']?.steps.find((step) => step.id === 'request')?.run,
);

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const validFoundationEnvironment: Readonly<Record<string, string>> = {
  DEPLOY_CONFIRMATION: 'DEPLOY_STAGING',
  DEPLOYMENT_PROFILE: 'CHAT_PUSH_FOUNDATION',
  FOUNDATION_MAINTENANCE_CONFIRMATION: 'APPLY_CHAT_PUSH_FOUNDATION_STAGING',
  FOUNDATION_EXPECTED_CANDIDATE_SHA: 'a'.repeat(40),
  FOUNDATION_EXPECTED_ACTIVE_RELEASE_SHA: 'b'.repeat(40),
  FOUNDATION_TENANT_KEYS: 'local-padel',
  FOUNDATION_NO_BOOKING_PRODUCER_CONFIRMATION: 'NO_BOOKING_PRODUCER_ACTIVE',
  FOUNDATION_ORIGINAL_RUN_ID: '',
  FOUNDATION_ORIGINAL_RUN_ATTEMPT: '',
  FOUNDATION_RUNTIME_ENV_REPAIR_CONFIRMATION: '',
  MESSAGING_PLAYER_A_ID: '',
  MESSAGING_PLAYER_B_ID: '',
  ROUTING_TENANT_KEY: '',
  ROUTING_ACTOR_ID: '',
  ROUTING_APPLY_CONFIRMATION: '',
  EXPECTED_ACTIVE_RELEASE: '',
  DIAGNOSE_HOME: 'false',
  DIAGNOSE_MEDIA: 'false',
  DIAGNOSTIC_PHONE_LAST4: '',
  ACCESS_TARGET_USER_ID: '',
  ACCESS_ROLES: '',
  ACCESS_PERMISSIONS: '',
  ACCESS_ACTOR_ID: '',
  ACCESS_APPLY_CONFIRMATION: '',
  RECOVER_UDISKS: 'false',
  REQUEST_REF: 'refs/heads/main',
  REQUEST_SHA: 'a'.repeat(40),
  WORKFLOW_SHA: 'a'.repeat(40),
  ACTOR: 'approved-operator',
  TRIGGERING_ACTOR: 'approved-operator',
  RUN_ATTEMPT: '1',
};

function executeValidation(overrides: Readonly<Record<string, string>> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'phub-foundation-request-'));
  temporaryDirectories.push(directory);
  const output = join(directory, 'github-output');
  writeFileSync(output, '');
  const result = spawnSync('/bin/bash', ['-c', validationScript], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ...validFoundationEnvironment,
      ...overrides,
      GITHUB_OUTPUT: output,
    },
  });
  return { ...result, output: readFileSync(output, 'utf8') };
}

describe('CHAT_PUSH_FOUNDATION request validation', () => {
  it('accepts only the isolated exact runtime-env metadata repair', () => {
    const result = executeValidation({
      DEPLOY_CONFIRMATION: '',
      FOUNDATION_MAINTENANCE_CONFIRMATION: '',
      FOUNDATION_EXPECTED_CANDIDATE_SHA: '',
      FOUNDATION_EXPECTED_ACTIVE_RELEASE_SHA: '',
      FOUNDATION_TENANT_KEYS: '',
      FOUNDATION_NO_BOOKING_PRODUCER_CONFIRMATION: '',
      FOUNDATION_RUNTIME_ENV_REPAIR_CONFIRMATION: 'REPAIR_STAGING_RUNTIME_ENV_PERMISSIONS',
    });

    expect(result.status).toBe(0);
    expect(result.output).toBe('mode=repair-runtime-env\n');
  });

  it.each([
    ['wrong confirmation', { FOUNDATION_RUNTIME_ENV_REPAIR_CONFIRMATION: 'REPAIR' }],
    [
      'deployment confirmation',
      {
        FOUNDATION_RUNTIME_ENV_REPAIR_CONFIRMATION: 'REPAIR_STAGING_RUNTIME_ENV_PERMISSIONS',
      },
    ],
    [
      'diagnostic input',
      {
        DEPLOY_CONFIRMATION: '',
        FOUNDATION_MAINTENANCE_CONFIRMATION: '',
        FOUNDATION_EXPECTED_CANDIDATE_SHA: '',
        FOUNDATION_EXPECTED_ACTIVE_RELEASE_SHA: '',
        FOUNDATION_TENANT_KEYS: '',
        FOUNDATION_NO_BOOKING_PRODUCER_CONFIRMATION: '',
        FOUNDATION_RUNTIME_ENV_REPAIR_CONFIRMATION: 'REPAIR_STAGING_RUNTIME_ENV_PERMISSIONS',
        DIAGNOSE_HOME: 'true',
      },
    ],
    [
      'non-main ref',
      {
        DEPLOY_CONFIRMATION: '',
        FOUNDATION_MAINTENANCE_CONFIRMATION: '',
        FOUNDATION_EXPECTED_CANDIDATE_SHA: '',
        FOUNDATION_EXPECTED_ACTIVE_RELEASE_SHA: '',
        FOUNDATION_TENANT_KEYS: '',
        FOUNDATION_NO_BOOKING_PRODUCER_CONFIRMATION: '',
        FOUNDATION_RUNTIME_ENV_REPAIR_CONFIRMATION: 'REPAIR_STAGING_RUNTIME_ENV_PERMISSIONS',
        REQUEST_REF: 'refs/heads/codex/unsafe',
      },
    ],
    [
      'rerun',
      {
        DEPLOY_CONFIRMATION: '',
        FOUNDATION_MAINTENANCE_CONFIRMATION: '',
        FOUNDATION_EXPECTED_CANDIDATE_SHA: '',
        FOUNDATION_EXPECTED_ACTIVE_RELEASE_SHA: '',
        FOUNDATION_TENANT_KEYS: '',
        FOUNDATION_NO_BOOKING_PRODUCER_CONFIRMATION: '',
        FOUNDATION_RUNTIME_ENV_REPAIR_CONFIRMATION: 'REPAIR_STAGING_RUNTIME_ENV_PERMISSIONS',
        RUN_ATTEMPT: '2',
      },
    ],
    [
      'different triggering actor',
      {
        DEPLOY_CONFIRMATION: '',
        FOUNDATION_MAINTENANCE_CONFIRMATION: '',
        FOUNDATION_EXPECTED_CANDIDATE_SHA: '',
        FOUNDATION_EXPECTED_ACTIVE_RELEASE_SHA: '',
        FOUNDATION_TENANT_KEYS: '',
        FOUNDATION_NO_BOOKING_PRODUCER_CONFIRMATION: '',
        FOUNDATION_RUNTIME_ENV_REPAIR_CONFIRMATION: 'REPAIR_STAGING_RUNTIME_ENV_PERMISSIONS',
        TRIGGERING_ACTOR: 'other-operator',
      },
    ],
    [
      'different workflow SHA',
      {
        DEPLOY_CONFIRMATION: '',
        FOUNDATION_MAINTENANCE_CONFIRMATION: '',
        FOUNDATION_EXPECTED_CANDIDATE_SHA: '',
        FOUNDATION_EXPECTED_ACTIVE_RELEASE_SHA: '',
        FOUNDATION_TENANT_KEYS: '',
        FOUNDATION_NO_BOOKING_PRODUCER_CONFIRMATION: '',
        FOUNDATION_RUNTIME_ENV_REPAIR_CONFIRMATION: 'REPAIR_STAGING_RUNTIME_ENV_PERMISSIONS',
        WORKFLOW_SHA: 'c'.repeat(40),
      },
    ],
    [
      'routing input',
      {
        DEPLOY_CONFIRMATION: '',
        FOUNDATION_MAINTENANCE_CONFIRMATION: '',
        FOUNDATION_EXPECTED_CANDIDATE_SHA: '',
        FOUNDATION_EXPECTED_ACTIVE_RELEASE_SHA: '',
        FOUNDATION_TENANT_KEYS: '',
        FOUNDATION_NO_BOOKING_PRODUCER_CONFIRMATION: '',
        FOUNDATION_RUNTIME_ENV_REPAIR_CONFIRMATION: 'REPAIR_STAGING_RUNTIME_ENV_PERMISSIONS',
        ROUTING_TENANT_KEY: 'local-padel',
      },
    ],
    [
      'user-access input',
      {
        DEPLOY_CONFIRMATION: '',
        FOUNDATION_MAINTENANCE_CONFIRMATION: '',
        FOUNDATION_EXPECTED_CANDIDATE_SHA: '',
        FOUNDATION_EXPECTED_ACTIVE_RELEASE_SHA: '',
        FOUNDATION_TENANT_KEYS: '',
        FOUNDATION_NO_BOOKING_PRODUCER_CONFIRMATION: '',
        FOUNDATION_RUNTIME_ENV_REPAIR_CONFIRMATION: 'REPAIR_STAGING_RUNTIME_ENV_PERMISSIONS',
        ACCESS_ROLES: 'admin',
      },
    ],
  ])('rejects runtime-env repair with %s', (_name, overrides) => {
    const result = executeValidation(overrides);

    expect(result.status).not.toBe(0);
    expect(result.output).toBe('');
  });

  it('accepts only the exact first-attempt main request', () => {
    const result = executeValidation();

    expect(result.status).toBe(0);
    expect(result.output).toBe('mode=deploy\n');
  });

  it('accepts only an exact recovery bound to the original first attempt', () => {
    const result = executeValidation({
      DEPLOYMENT_PROFILE: 'CHAT_PUSH_FOUNDATION_RECOVERY',
      FOUNDATION_MAINTENANCE_CONFIRMATION: 'RESUME_CHAT_PUSH_FOUNDATION_STAGING',
      FOUNDATION_ORIGINAL_RUN_ID: '31881248698',
      FOUNDATION_ORIGINAL_RUN_ATTEMPT: '1',
    });

    expect(result.status).toBe(0);
    expect(result.output).toBe('mode=deploy\n');
  });

  it('allows protected recovery of the exact original candidate after main advances', () => {
    const result = executeValidation({
      DEPLOYMENT_PROFILE: 'CHAT_PUSH_FOUNDATION_RECOVERY',
      FOUNDATION_MAINTENANCE_CONFIRMATION: 'RESUME_CHAT_PUSH_FOUNDATION_STAGING',
      FOUNDATION_ORIGINAL_RUN_ID: '31881248698',
      FOUNDATION_ORIGINAL_RUN_ATTEMPT: '1',
      REQUEST_SHA: 'c'.repeat(40),
      WORKFLOW_SHA: 'c'.repeat(40),
    });

    expect(result.status).toBe(0);
    expect(result.output).toBe('mode=deploy\n');
  });

  it.each([
    ['wrong ref', { REQUEST_REF: 'refs/heads/codex/unsafe' }],
    ['different workflow SHA', { WORKFLOW_SHA: 'c'.repeat(40) }],
    ['different candidate SHA', { FOUNDATION_EXPECTED_CANDIDATE_SHA: 'c'.repeat(40) }],
    ['rerun', { RUN_ATTEMPT: '2' }],
    ['different triggering actor', { TRIGGERING_ACTOR: 'other-operator' }],
    ['routing input', { ROUTING_TENANT_KEY: 'local-padel' }],
    ['diagnostic input', { DIAGNOSE_HOME: 'true' }],
    ['access input', { ACCESS_ROLES: 'admin' }],
    ['newline tenant injection', { FOUNDATION_TENANT_KEYS: 'local-padel\nNEXT=true' }],
    ['shell tenant injection', { FOUNDATION_TENANT_KEYS: 'local-padel;touch-x' }],
    [
      'active release metacharacters',
      { FOUNDATION_EXPECTED_ACTIVE_RELEASE_SHA: `${'b'.repeat(39)};` },
    ],
    ['missing producer attestation', { FOUNDATION_NO_BOOKING_PRODUCER_CONFIRMATION: '' }],
    ['recovery identity on initial release', { FOUNDATION_ORIGINAL_RUN_ID: '31881248698' }],
  ])('rejects %s', (_name, overrides) => {
    const result = executeValidation(overrides);

    expect(result.status).not.toBe(0);
    expect(result.output).toBe('');
  });

  it.each([
    [
      'wrong recovery confirmation',
      { FOUNDATION_MAINTENANCE_CONFIRMATION: 'APPLY_CHAT_PUSH_FOUNDATION_STAGING' },
    ],
    ['missing original run', { FOUNDATION_ORIGINAL_RUN_ID: '' }],
    ['rerun identity', { FOUNDATION_ORIGINAL_RUN_ATTEMPT: '2' }],
    ['run metacharacters', { FOUNDATION_ORIGINAL_RUN_ID: '123;touch-x' }],
  ])('rejects recovery with %s', (_name, overrides) => {
    const result = executeValidation({
      DEPLOYMENT_PROFILE: 'CHAT_PUSH_FOUNDATION_RECOVERY',
      FOUNDATION_MAINTENANCE_CONFIRMATION: 'RESUME_CHAT_PUSH_FOUNDATION_STAGING',
      FOUNDATION_ORIGINAL_RUN_ID: '31881248698',
      FOUNDATION_ORIGINAL_RUN_ATTEMPT: '1',
      ...overrides,
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toBe('');
  });

  it.each([
    ['diagnostics', { DIAGNOSE_HOME: 'true' }],
    ['user access', { ACCESS_ROLES: 'admin' }],
  ])('rejects foundation profile selection as %s even without foundation fields', (_name, mode) => {
    const result = executeValidation({
      FOUNDATION_MAINTENANCE_CONFIRMATION: '',
      FOUNDATION_EXPECTED_CANDIDATE_SHA: '',
      FOUNDATION_EXPECTED_ACTIVE_RELEASE_SHA: '',
      FOUNDATION_TENANT_KEYS: '',
      FOUNDATION_NO_BOOKING_PRODUCER_CONFIRMATION: '',
      ...mode,
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toBe('');
  });

  it('rejects media-only inputs on a user-access operation', () => {
    const result = executeValidation({
      DEPLOY_CONFIRMATION: '',
      FOUNDATION_MAINTENANCE_CONFIRMATION: '',
      FOUNDATION_EXPECTED_CANDIDATE_SHA: '',
      FOUNDATION_EXPECTED_ACTIVE_RELEASE_SHA: '',
      FOUNDATION_TENANT_KEYS: '',
      FOUNDATION_NO_BOOKING_PRODUCER_CONFIRMATION: '',
      ACCESS_TARGET_USER_ID: '11111111-1111-4111-8111-111111111111',
      ACCESS_ACTOR_ID: '22222222-2222-4222-8222-222222222222',
      ACCESS_ROLES: 'player',
      ACCESS_PERMISSIONS: 'profile.read',
      EXPECTED_ACTIVE_RELEASE: 'c'.repeat(40),
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toBe('');
  });

  it('rejects foundation inputs on MEDIA_BINARY_ONLY', () => {
    const result = executeValidation({
      DEPLOYMENT_PROFILE: 'MEDIA_BINARY_ONLY',
      EXPECTED_ACTIVE_RELEASE: 'c'.repeat(40),
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toBe('');
  });
});
