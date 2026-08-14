import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, chmod, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  calculateManifestIdempotencyDigest,
  calculatePreservationRollupDigest,
  calculateStableMappingDigest,
  COMMUNITIES_LEGACY_REQUIRED_COLLECTIONS,
} from './communities-legacy-preservation-support.js';
import { runCommunitiesLegacyPreservationVerification as runCli } from './verify-communities-legacy-preservation.js';

const directories: string[] = [];
const h = (character: string) => character.repeat(64);
const execFile = promisify(execFileCallback);

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      const { rm } = await import('node:fs/promises');
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

function fixture() {
  const writerReport = {
    schemaVersion: 'communities-node-red-writer-inventory-report-v1' as const,
    outcome: 'NODE_RED_WRITER_INVENTORY_COMPLETE' as const,
    authorizesMutation: false as const,
    total: 1,
    inventoryDigest: h('2'),
    sourceFlowSha256: h('7'),
    functionAllowlistSha256: h('8'),
    unknown: 0,
    unknownByReason: {
      UNSUPPORTED_OPERATION: 0,
      OUT_OF_CONTRACT_COLLECTION: 0,
      MISSING_INGRESS: 0,
      UNAPPROVED_INGRESS: 0,
      ROUTE_CONTRACT_MISMATCH: 0,
      UNKNOWN_SINK_TYPE: 0,
      DIRECT_DRIVER_CODE: 0,
      UNREVIEWED_FUNCTION: 0,
      FUNCTION_ALLOWLIST_EXTRA: 0,
    },
    duplicateHandlers: 0,
    blockers: [],
  };
  const writerReportSha256 = createHash('sha256')
    .update(JSON.stringify(writerReport))
    .digest('hex');
  const aggregate = {
    tenantKey: 'local-padel',
    communityKeyHmac: h('0'),
    padlHubCommunityId: '00000000-0000-4000-8000-000000000001',
    communityDigest: h('b'),
    lifecycle: 'ACTIVE' as const,
    activeOwners: 1,
    membershipRoles: { owner: 1, admin: 0, moderator: 0, member: 0 },
    membershipStatuses: { pending: 0, active: 1, left: 0, removed: 0, banned: 0 },
    memberships: { total: 1, digest: h('c') },
    ratingFacts: 1,
    ratingSnapshots: 1,
    ratingDigest: h('d'),
    content: { posts: 1, comments: 1, reactions: 1, mediaReferences: 0, digest: h('e') },
    chat: { conversations: 1, messages: 1, readCursors: 1, digest: h('f') },
    invites: { active: 0, historical: 1, digest: h('1') },
  };
  const mapping = {
    sourceTenantIdHmac: h('6'),
    externalSystem: 'LK_LEGACY' as const,
    entityType: 'community' as const,
    inputRows: 1,
    assignmentsDigest: '',
  };
  mapping.assignmentsDigest = calculateStableMappingDigest('local-padel', mapping, [aggregate]);
  const accepted: Record<(typeof COMMUNITIES_LEGACY_REQUIRED_COLLECTIONS)[number], number> = {
    lk_communities: 1,
    lk_community_events: 0,
    lk_community_feed: 1,
    lk_community_feed_comments: 1,
    lk_community_feed_reactions: 1,
    lk_community_chat_messages: 1,
    lk_community_rankings: 0,
    community_rating_facts: 1,
    community_rating_player_aggregates: 0,
    community_rating_snapshots: 1,
  };
  const unsigned = {
    schemaVersion: 'communities-preservation-inventory-v1' as const,
    tenantKey: 'local-padel',
    sourceRelease: 'legacy-release-v1',
    capturedAt: '2026-08-09T00:00:00.000Z',
    sourceCheckpointDigest: h('a'),
    snapshotConsistent: true as const,
    mapping,
    writeRoutes: {
      outcome: 'NODE_RED_WRITER_INVENTORY_COMPLETE' as const,
      reportSha256: writerReportSha256,
      sourceFlowSha256: h('7'),
      functionAllowlistSha256: h('8'),
      total: 1,
      inventoryDigest: h('2'),
      unknown: 0,
      duplicateHandlers: 0,
    },
    collections: COMMUNITIES_LEGACY_REQUIRED_COLLECTIONS.map((name) => ({
      name,
      scanned: accepted[name],
      accepted: accepted[name],
      quarantined: 0,
      acceptedDigest: h('4'),
      quarantineDigest: h('5'),
    })),
    communities: {
      total: 1,
      digest: calculatePreservationRollupDigest([aggregate], (item) => item.communityDigest),
      duplicateExternalIds: 0,
      invalidExternalIds: 0,
      missingStableMappings: 0,
    },
    memberships: {
      total: 1,
      digest: calculatePreservationRollupDigest([aggregate], (item) => item.memberships.digest),
      unresolvedIdentities: 0,
      ambiguousIdentities: 0,
      orphaned: 0,
      ownerInvariantViolations: 0,
    },
    ratingResults: {
      facts: 1,
      snapshots: 1,
      digest: calculatePreservationRollupDigest([aggregate], (item) => item.ratingDigest),
      orphanedCommunityRefs: 0,
      orphanedMemberRefs: 0,
      unknownSemantics: 0,
    },
    content: {
      posts: 1,
      comments: 1,
      reactions: 1,
      mediaReferences: 0,
      digest: calculatePreservationRollupDigest([aggregate], (item) => item.content.digest),
      orphanedRefs: 0,
      unknownSemantics: 0,
    },
    chat: {
      conversations: 1,
      messages: 1,
      readCursors: 1,
      digest: calculatePreservationRollupDigest([aggregate], (item) => item.chat.digest),
      orphanedRefs: 0,
      unknownSemantics: 0,
    },
    invites: {
      active: 0,
      historical: 1,
      digest: calculatePreservationRollupDigest([aggregate], (item) => item.invites.digest),
      orphanedRefs: 0,
      unknownSemantics: 0,
    },
    aggregates: [aggregate],
  };
  return {
    manifest: { ...unsigned, idempotencyDigest: calculateManifestIdempotencyDigest(unsigned) },
    writerReport,
    baseline: {
      schemaVersion: 'communities-legacy-mapping-baseline-v1',
      tenantKey: 'local-padel',
      sourceTenantIdHmac: h('6'),
      externalSystem: 'LK_LEGACY',
      entityType: 'community',
      inputRows: 1,
      assignmentsDigest: mapping.assignmentsDigest,
    },
  };
}

async function files() {
  const directory = await mkdtemp(join(tmpdir(), 'communities-cli-'));
  directories.push(directory);
  const { manifest, baseline, writerReport } = fixture();
  const manifestPath = join(directory, 'manifest.json');
  const baselinePath = join(directory, 'baseline.json');
  const writerReportPath = join(directory, 'writer-report.json');
  await Promise.all([
    writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 }),
    writeFile(baselinePath, JSON.stringify(baseline), { mode: 0o600 }),
    writeFile(writerReportPath, JSON.stringify(writerReport), { mode: 0o600 }),
  ]);
  await Promise.all([
    chmod(manifestPath, 0o600),
    chmod(baselinePath, 0o600),
    chmod(writerReportPath, 0o600),
  ]);
  return {
    manifestPath,
    baselinePath,
    writerReportPath,
    baselinePin: createHash('sha256').update(JSON.stringify(baseline)).digest('hex'),
    writerReportPin: createHash('sha256').update(JSON.stringify(writerReport)).digest('hex'),
  };
}

async function runCommunitiesLegacyPreservationVerification(
  arguments_: readonly string[],
  requiredBaselineSha256: string | undefined,
  requiredWriterReportSha256?: string,
) {
  const manifestIndex = arguments_.indexOf('--manifest');
  const manifestPath = manifestIndex >= 0 ? arguments_[manifestIndex + 1] : undefined;
  if (!manifestPath?.startsWith('/'))
    return runCli(arguments_, requiredBaselineSha256, requiredWriterReportSha256);
  const writerReportPath = join(dirname(manifestPath), 'writer-report.json');
  let writerReportPin = requiredWriterReportSha256;
  if (!writerReportPin) {
    try {
      const { readFile } = await import('node:fs/promises');
      writerReportPin = createHash('sha256')
        .update(await readFile(writerReportPath))
        .digest('hex');
    } catch {
      writerReportPin = undefined;
    }
  }
  const expandedArguments = arguments_.includes('--writer-report')
    ? arguments_
    : [...arguments_, '--writer-report', writerReportPath];
  return runCli(expandedArguments, requiredBaselineSha256, writerReportPin);
}

describe('verify Communities legacy preservation CLI', () => {
  it('emits only a valid redacted report for a valid private pair', async () => {
    const pair = await files();
    const result = await runCommunitiesLegacyPreservationVerification(
      ['--manifest', pair.manifestPath, '--baseline', pair.baselinePath],
      pair.baselinePin,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: 'INVENTORY_STRUCTURALLY_CONSISTENT',
    });
    expect(result.stdout).not.toContain(pair.manifestPath);
    expect(result.stdout).not.toContain('sourceTenantIdHmac');
  });

  it('requires an independently pinned exact exit-0 writer report matching the manifest', async () => {
    const pair = await files();
    const arguments_ = [
      '--manifest',
      pair.manifestPath,
      '--baseline',
      pair.baselinePath,
      '--writer-report',
      pair.writerReportPath,
    ];
    expect((await runCli(arguments_, pair.baselinePin, undefined)).exitCode).toBe(2);
    expect((await runCli(arguments_, pair.baselinePin, 'f'.repeat(64))).exitCode).toBe(2);

    const changed = fixture().writerReport;
    changed.inventoryDigest = h('3');
    const changedBytes = JSON.stringify(changed);
    await writeFile(pair.writerReportPath, changedBytes, { mode: 0o600 });
    const changedPin = createHash('sha256').update(changedBytes).digest('hex');
    expect((await runCli(arguments_, pair.baselinePin, changedPin)).exitCode).toBe(2);

    const inconsistent = fixture().writerReport;
    inconsistent.unknownByReason.UNSUPPORTED_OPERATION = 1;
    const inconsistentBytes = JSON.stringify(inconsistent);
    await writeFile(pair.writerReportPath, inconsistentBytes, { mode: 0o600 });
    const inconsistentPin = createHash('sha256').update(inconsistentBytes).digest('hex');
    const inconsistentManifest = fixture().manifest;
    inconsistentManifest.writeRoutes.reportSha256 = inconsistentPin;
    const { idempotencyDigest, ...inconsistentUnsigned } = inconsistentManifest;
    void idempotencyDigest;
    inconsistentManifest.idempotencyDigest =
      calculateManifestIdempotencyDigest(inconsistentUnsigned);
    await writeFile(pair.manifestPath, JSON.stringify(inconsistentManifest), { mode: 0o600 });
    expect((await runCli(arguments_, pair.baselinePin, inconsistentPin)).exitCode).toBe(2);
  });

  it('returns a report and exit 1 for a structural blocker', async () => {
    const pair = await files();
    const value = fixture().manifest;
    value.collections[0]!.quarantined = 1;
    value.collections[0]!.accepted = 0;
    await writeFile(pair.manifestPath, JSON.stringify(value), { mode: 0o600 });
    const result = await runCommunitiesLegacyPreservationVerification(
      ['--manifest', pair.manifestPath, '--baseline', pair.baselinePath],
      pair.baselinePin,
    );
    const output = JSON.parse(result.stdout) as { blockers: string[] };
    expect(result.exitCode).toBe(1);
    expect(output.blockers).toContain('SOURCE_COLLECTION_QUARANTINE_PENDING');
  });

  it('rejects a recomputed candidate baseline when its independent raw-file pin remains unchanged', async () => {
    const pair = await files();
    const candidate = fixture();
    candidate.manifest.aggregates[0]!.padlHubCommunityId = '00000000-0000-4000-8000-000000000099';
    candidate.manifest.mapping.assignmentsDigest = calculateStableMappingDigest(
      candidate.manifest.tenantKey,
      candidate.manifest.mapping,
      candidate.manifest.aggregates,
    );
    const { idempotencyDigest, ...unsigned } = candidate.manifest;
    void idempotencyDigest;
    candidate.manifest.idempotencyDigest = calculateManifestIdempotencyDigest(unsigned);
    candidate.baseline.assignmentsDigest = candidate.manifest.mapping.assignmentsDigest;
    await Promise.all([
      writeFile(pair.manifestPath, JSON.stringify(candidate.manifest), { mode: 0o600 }),
      writeFile(pair.baselinePath, JSON.stringify(candidate.baseline), { mode: 0o600 }),
    ]);
    const result = await runCommunitiesLegacyPreservationVerification(
      ['--manifest', pair.manifestPath, '--baseline', pair.baselinePath],
      pair.baselinePin,
    );
    expect(result).toMatchObject({
      exitCode: 2,
      stdout: '',
      stderr: 'COMMUNITIES_LEGACY_PRESERVATION_INVALID_INPUT\n',
    });
  });

  it('rejects arguments and missing or invalid pins without leaking paths', async () => {
    const pair = await files();
    const cases: readonly (readonly string[])[] = [
      [],
      ['--wat', pair.manifestPath],
      [
        '--manifest',
        pair.manifestPath,
        '--manifest',
        pair.manifestPath,
        '--baseline',
        pair.baselinePath,
      ],
      ['--manifest', 'relative.json', '--baseline', pair.baselinePath],
    ];
    for (const arguments_ of cases) {
      const result = await runCommunitiesLegacyPreservationVerification(
        arguments_,
        pair.baselinePin,
      );
      expect(result).toMatchObject({
        exitCode: 2,
        stdout: '',
        stderr: 'COMMUNITIES_LEGACY_PRESERVATION_INVALID_INPUT\n',
      });
      expect(result.stderr).not.toContain(pair.manifestPath);
    }
    for (const pin of [undefined, 'invalid', h('A')]) {
      const result = await runCommunitiesLegacyPreservationVerification(
        ['--manifest', pair.manifestPath, '--baseline', pair.baselinePath],
        pin,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
    }
  });

  it.each([
    ['manifest symlink', 'manifest'],
    ['baseline symlink', 'baseline'],
    ['writer report symlink', 'writerReport'],
    ['manifest non-private mode', 'manifest'],
    ['baseline non-private mode', 'baseline'],
    ['writer report non-private mode', 'writerReport'],
  ] as const)('rejects %s independently', async (_label, target) => {
    const pair = await files();
    const path =
      target === 'manifest'
        ? pair.manifestPath
        : target === 'baseline'
          ? pair.baselinePath
          : pair.writerReportPath;
    if (_label.includes('symlink')) {
      const link = join(dirname(path), `${target}-link.json`);
      await symlink(path, link);
      if (target === 'manifest') pair.manifestPath = link;
      else if (target === 'baseline') pair.baselinePath = link;
      else pair.writerReportPath = link;
    } else {
      await chmod(path, 0o644);
    }
    const result = await runCommunitiesLegacyPreservationVerification(
      [
        '--manifest',
        pair.manifestPath,
        '--baseline',
        pair.baselinePath,
        '--writer-report',
        pair.writerReportPath,
      ],
      pair.baselinePin,
      pair.writerReportPin,
    );
    expect(result).toMatchObject({
      exitCode: 2,
      stdout: '',
      stderr: 'COMMUNITIES_LEGACY_PRESERVATION_INVALID_INPUT\n',
    });
  });

  it('rejects malformed JSON and well-formed schema-invalid manifest and baseline separately', async () => {
    const pair = await files();
    const arguments_ = ['--manifest', pair.manifestPath, '--baseline', pair.baselinePath];
    await writeFile(pair.manifestPath, '{', { mode: 0o600 });
    expect(
      (await runCommunitiesLegacyPreservationVerification(arguments_, pair.baselinePin)).exitCode,
    ).toBe(2);
    await writeFile(pair.manifestPath, JSON.stringify({}), { mode: 0o600 });
    expect(
      (await runCommunitiesLegacyPreservationVerification(arguments_, pair.baselinePin)).exitCode,
    ).toBe(2);
    await writeFile(pair.manifestPath, JSON.stringify(fixture().manifest), { mode: 0o600 });
    await writeFile(pair.baselinePath, JSON.stringify({}), { mode: 0o600 });
    const changedPin = createHash('sha256').update(JSON.stringify({})).digest('hex');
    expect(
      (await runCommunitiesLegacyPreservationVerification(arguments_, changedPin)).exitCode,
    ).toBe(2);
  });

  it.each([
    ['manifest', 32 * 1024 * 1024 + 1],
    ['baseline', 64 * 1024 + 1],
    ['writerReport', 1024 * 1024 + 1],
  ] as const)('rejects %s files beyond their size bound', async (target, size) => {
    const pair = await files();
    const path =
      target === 'manifest'
        ? pair.manifestPath
        : target === 'baseline'
          ? pair.baselinePath
          : pair.writerReportPath;
    await truncate(path, size);
    const result = await runCommunitiesLegacyPreservationVerification(
      ['--manifest', pair.manifestPath, '--baseline', pair.baselinePath],
      pair.baselinePin,
    );
    expect(result.exitCode).toBe(2);
  });

  it('rejects a private FIFO promptly before opening it', async () => {
    const pair = await files();
    const fifoPath = join(dirname(pair.manifestPath), 'manifest.fifo');
    await execFile('mkfifo', ['-m', '600', fifoPath]);
    const result = await Promise.race([
      runCommunitiesLegacyPreservationVerification(
        ['--manifest', fifoPath, '--baseline', pair.baselinePath],
        pair.baselinePin,
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('FIFO_STALL')), 1000)),
    ]);
    expect(result).toMatchObject({
      exitCode: 2,
      stdout: '',
      stderr: 'COMMUNITIES_LEGACY_PRESERVATION_INVALID_INPUT\n',
    });
  });

  it('has a path-safe entrypoint that exits 2 without a baseline pin', async () => {
    try {
      await execFile(
        process.execPath,
        ['--import', 'tsx', 'scripts/verify-communities-legacy-preservation.ts'],
        {
          cwd: process.cwd(),
          env: { ...process.env, COMMUNITIES_LEGACY_BASELINE_SHA256_REQUIRED: '' },
        },
      );
      throw new Error('expected verifier failure');
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      expect(failure.code).toBe(2);
      expect(failure.stdout).toBe('');
      expect(failure.stderr).toBe('COMMUNITIES_LEGACY_PRESERVATION_INVALID_INPUT\n');
    }
  });

  it('rejects malformed flags, relative paths, symlinks, modes, and invalid documents without leaks', async () => {
    const pair = await files();
    await symlink(
      pair.manifestPath,
      join((await import('node:path')).dirname(pair.manifestPath), 'link.json'),
    );
    await chmod(pair.manifestPath, 0o644);
    const cases = [
      [],
      ['--wat', pair.manifestPath],
      [
        '--manifest',
        pair.manifestPath,
        '--manifest',
        pair.manifestPath,
        '--baseline',
        pair.baselinePath,
      ],
      ['--manifest', 'relative.json', '--baseline', pair.baselinePath],
      [
        '--manifest',
        join((await import('node:path')).dirname(pair.manifestPath), 'link.json'),
        '--baseline',
        pair.baselinePath,
      ],
      ['--manifest', pair.manifestPath, '--baseline', pair.baselinePath],
    ];
    for (const arguments_ of cases) {
      const result = await runCommunitiesLegacyPreservationVerification(
        arguments_,
        pair.baselinePin,
      );
      expect(result).toMatchObject({
        exitCode: 2,
        stdout: '',
        stderr: 'COMMUNITIES_LEGACY_PRESERVATION_INVALID_INPUT\n',
      });
      expect(result.stderr).not.toContain(pair.manifestPath);
    }
  });

  it('rejects invalid JSON/schema and bounded-size violations', async () => {
    const pair = await files();
    await writeFile(pair.manifestPath, '{');
    let result = await runCommunitiesLegacyPreservationVerification(
      ['--manifest', pair.manifestPath, '--baseline', pair.baselinePath],
      pair.baselinePin,
    );
    expect(result.stderr).toBe('COMMUNITIES_LEGACY_PRESERVATION_INVALID_INPUT\n');
    await writeFile(pair.manifestPath, JSON.stringify(fixture().manifest), { mode: 0o600 });
    await truncate(pair.baselinePath, 64 * 1024 + 1);
    result = await runCommunitiesLegacyPreservationVerification(
      ['--manifest', pair.manifestPath, '--baseline', pair.baselinePath],
      pair.baselinePin,
    );
    expect(result.stderr).toBe('COMMUNITIES_LEGACY_PRESERVATION_INVALID_INPUT\n');
  });
});
