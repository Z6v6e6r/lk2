import { readFile } from 'node:fs/promises';

import corpusFixture from './communities-role-split-negative-corpus.fixture.json';
import {
  assertRoleSplitNegativeCorpus,
  type RoleSplitNegativeCorpus,
} from './communities-role-split-negative-harness.test-helper.js';
import { beforeAll, describe, expect, it } from 'vitest';

const ceremonySource = new URL(
  '../deploy/jetson/run-communities-role-split-restore-marker-ceremony.sh',
  import.meta.url,
);
const cleanupSource = new URL(
  '../deploy/jetson/cleanup-communities-role-split-restore-marker-clone.sh',
  import.meta.url,
);

let ceremony = '';
let cleanup = '';

function corpus(): RoleSplitNegativeCorpus {
  assertRoleSplitNegativeCorpus(corpusFixture);
  return corpusFixture;
}

function ordered(source: string, snippets: readonly string[]): void {
  let cursor = -1;
  for (const snippet of snippets) {
    const next = source.indexOf(snippet, cursor + 1);
    expect(next, `missing or out-of-order snippet: ${snippet}`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

beforeAll(async () => {
  [ceremony, cleanup] = await Promise.all([
    readFile(ceremonySource, 'utf8'),
    readFile(cleanupSource, 'utf8'),
  ]);
});

describe('current role-split V2 adversarial source contract', () => {
  it('binds every corpus failure to an actual V2 stable error', () => {
    for (const scenario of corpus().cases) {
      if (scenario.expected.stableError === null) continue;
      const prefix =
        scenario.integration === 'CEREMONY'
          ? 'COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CEREMONY_'
          : 'COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CLEANUP_';
      const source = scenario.integration === 'CEREMONY' ? ceremony : cleanup;
      expect(scenario.expected.stableError.startsWith(prefix)).toBe(true);
      expect(source).toContain(`fail ${scenario.expected.stableError.slice(prefix.length)}`);
    }
  });

  it('keeps CREATE as create-once then receipt reconciliation, never restore, marker or adoption', () => {
    const createBranch = ceremony.slice(
      ceremony.lastIndexOf('if test "$phase" = CREATE; then'),
      ceremony.indexOf('printf \'%s\' "$receipt_basename"'),
    );
    ordered(createBranch, [
      'createdb -U "$POSTGRES_USER" --template=template0 --owner="$1" "$2"',
      'atomic_state "CREATION_RECONCILIATION_REQUIRED|$expected_request_sha"',
      'fail CREATION_RECEIPT_REQUIRED',
    ]);
    expect(createBranch).toContain('fail CREATEDB_RECONCILIATION_REQUIRED');
    expect(createBranch).not.toMatch(
      /pg_restore|COMMENT ON DATABASE|adopt|dropdb|ALTER DATABASE/iu,
    );
    expect(ceremony.indexOf('fail CREATION_RECEIPT_REQUIRED')).toBeLessThan(
      ceremony.indexOf('\'pg_restore -U "$POSTGRES_USER" --exit-on-error'),
    );
  });

  it('validates RESUME receipt custody, binding, OID and owner before restore', () => {
    ordered(ceremony, [
      'assert_file "$receipt" 0 "$current_gid" 440 RECEIPT_CUSTODY_INVALID',
      'fail RECEIPT_BINDING_INVALID',
      'where d.oid=$clone_oid::oid',
      'fail CLONE_IDENTITY_MISMATCH',
      '\'pg_restore -U "$POSTGRES_USER" --exit-on-error',
    ]);
    expect(ceremony).toContain('test "$clone_oid" != "$source_database_oid"');
    expect(ceremony).toContain(
      '"$restore_database|$clone_owner|$clone_owner_oid|$expected_request_sha"',
    );
  });

  it('fails nonroot-readable env, writable app root, runtime drift and container mismatch closed', () => {
    expect(ceremony).toContain('test -r "$artifact" || fail APP_ARTIFACT_CUSTODY_INVALID');
    expect(ceremony).toContain(
      'case "$app_root_mode" in ?[2367]?|??[2367]) fail APP_ROOT_CUSTODY_INVALID',
    );
    expect(ceremony).toContain(
      '"communities-role-split-marker-runtime-${run_id}-${run_attempt}.txt"',
    );
    expect(ceremony).toContain('fail RUNTIME_BINDING_INVALID');
    expect(ceremony).toContain(
      '$postgres_container_id|$postgres_image_id|$compose_project|postgres',
    );
    expect(ceremony).toContain('fail CONTAINER_IDENTITY_INVALID');
  });

  it('owns timeout child mode and scrubs caller Docker/Compose routing variables', () => {
    for (const source of [ceremony, cleanup]) {
      expect(source).toContain('PATH=/usr/sbin:/usr/bin:/sbin:/bin');
      expect(source).toContain('exec "$timeout_path" --signal=TERM --kill-after=15s');
      expect(source).toContain('/usr/bin/env -i PATH="$PATH" SSH_ORIGINAL_COMMAND=');
      expect(source).toContain('unset DOCKER_HOST DOCKER_CONTEXT COMPOSE_FILE');
    }
    expect(ceremony).toContain('__PHUB_COMMUNITIES_MARKER_BOUNDED_CHILD_V1');
    expect(cleanup).toContain('__PHUB_COMMUNITIES_MARKER_CLEANUP_BOUNDED_CHILD_V1');
    const forcedCommandGrammar = ceremony.slice(
      ceremony.indexOf('original_command=${SSH_ORIGINAL_COMMAND:-}'),
      ceremony.indexOf('request_root='),
    );
    expect(forcedCommandGrammar).toContain('RUN_COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CEREMONY_V2');
    expect(forcedCommandGrammar).not.toContain('__PHUB_COMMUNITIES_MARKER_BOUNDED_CHILD_V1');
  });

  it('persists MARKER_PENDING before COMMENT and retains ambiguous/nonzero outcomes', () => {
    ordered(ceremony, [
      'atomic_state "MARKER_PENDING|$expected_request_sha|$clone_oid|$marker_value_sha"',
      'cleanup_forbidden=true',
      'COMMENT ON DATABASE',
      'fail MARKER_ACTION_AMBIGUOUS',
      'fail MARKER_READBACK_MISMATCH',
      'atomic_state "MARKED|$expected_request_sha|$clone_oid|$marker_value_sha"',
    ]);
    expect(ceremony).not.toContain('dropdb');
  });

  it('records pre-marker and explicit cleanup as quarantine without DROP, ALTER or rename', () => {
    expect(ceremony).toContain(
      'QUARANTINE_PENDING_RECONCILIATION_REQUIRED|$expected_request_sha|$clone_oid|$clone_owner|$clone_owner_oid|NO_COMMENT',
    );
    expect(cleanup).toContain(
      'QUARANTINE_PENDING_RECONCILIATION_REQUIRED|$marker_request_sha|$clone_oid|$clone_owner|$clone_owner_oid|$marker_value_sha|$expected_cleanup_request_sha',
    );
    expect(cleanup).toContain('status=QUARANTINE_PENDING_RECONCILIATION_REQUIRED');
    expect(`${ceremony}\n${cleanup}`).not.toMatch(
      /\bdropdb\b|\b(?:ALTER|DROP)\s+DATABASE\b|\brename(?:db)?\b/iu,
    );
  });

  it('caps and discards child diagnostics without a public or state-tree diagnostic artifact', () => {
    for (const source of [ceremony, cleanup]) {
      expect(source).toContain('2>/dev/null |');
      expect(source).toContain('head -c 65537');
      expect(source).toContain('rm -f "$command_status"');
      expect(source).not.toContain('SECRET_SENTINEL');
      expect(source).not.toMatch(/diagnostic[^_A-Z]/u);
    }
  });

  it('retains replay and partial-failure states as non-destructive reconciliation', () => {
    expect(ceremony).toContain('test -z "$unresolved" || fail UNRESOLVED_STATE');
    expect(ceremony).toContain('fail RESTORE_FAILED');
    expect(ceremony).toContain('fail MARKER_READBACK_MISMATCH');
    for (const scenario of corpus().cases.filter(({ attack }) =>
      ['REPLAY_CONFLICT', 'PARTIAL_FAILURE_BEFORE_MARKER', 'PARTIAL_FAILURE_AFTER_MARKER'].includes(
        attack,
      ),
    )) {
      expect(scenario.expected.clone).toBe('RETAINED');
      expect(scenario.expected.operations).toMatchObject({ drop: 0, alter: 0, rename: 0 });
    }
  });
});
