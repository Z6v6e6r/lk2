import { describe, expect, it } from 'vitest';
import { r1ApiWorker119Fixture } from './timeweb-r1-api-worker119.fixture.js';
import {
  validateR1ApiWorker119Operation,
  validateR1ApiWorker119Manifest,
  validateR1ApiWorker119Ledger,
} from './timeweb-r1-api-worker119-profile.js';
import { R1_TAIL } from './r1-tail-migration-profile.js';
describe('fixed R1 API/Worker119 operation admission', () => {
  it('binds the exact retained pair and unchanged Web/Realtime with one candidate source', () => {
    const op = r1ApiWorker119Fixture();
    expect(validateR1ApiWorker119Operation(op, Date.parse(op.expiresAt) - 1800000)).toBe(op);
  });
  it.each([
    'source',
    'tree',
    'ci',
    'api',
    'worker',
    'web',
    'realtime',
    'postgres',
    'secret',
    'fcm',
    'backup',
    'tail',
    'file',
    'expiry',
    'confirmation',
  ])('refuses %s substitution before any effect', (key) => {
    const op = r1ApiWorker119Fixture();
    if (key === 'source') op.candidateSha = 'f'.repeat(40);
    if (key === 'tree') op.candidateTree = 'f'.repeat(40);
    if (key === 'ci') op.sourceCiRunId = '999';
    if (key === 'api') op.expectedApi.imageId = 'sha256:' + 'f'.repeat(64);
    if (key === 'worker') op.expectedWorker.revision = 'f'.repeat(40);
    if (key === 'web') op.expectedWeb.revision = 'f'.repeat(40);
    if (key === 'realtime') op.expectedRealtime.revision = 'f'.repeat(40);
    if (key === 'postgres') op.expectedPostgres.id = 'f'.repeat(64);
    if (key === 'secret') delete op.candidateSecretHashes['api.env'];
    if (key === 'fcm') op.expectedFcmSource = '/tmp/foreign.json';
    if (key === 'backup') op.completedTail.backup.path = '/tmp/foreign.json';
    if (key === 'tail') op.completedTail.controllerSha = 'f'.repeat(40);
    if (key === 'file') delete op.completedTail.files['cleanup.json'];
    if (key === 'expiry') op.expiresAt = '2026-11-03T00:10:00.000Z';
    if (key === 'confirmation') op.confirmation = 'ENABLE_EVERYTHING';
    expect(() =>
      validateR1ApiWorker119Operation(op, Date.parse('2026-11-03T00:30:00.000Z')),
    ).toThrow();
  });
  it('accepts only the exact119 SQL inventory', () => {
    const rows = structuredClone(R1_TAIL.inventory);
    expect(() => validateR1ApiWorker119Ledger(rows, rows)).not.toThrow();
    expect(() => validateR1ApiWorker119Ledger(rows.slice(0, 118), rows)).toThrow();
    rows[0]!.checksum = 'f'.repeat(64);
    expect(() => validateR1ApiWorker119Ledger(rows, rows)).toThrow();
  });
  it('binds all consumed candidate images; no mix of source revisions', () => {
    const op = r1ApiWorker119Fixture();
    const manifest = {
      schemaVersion: 'PHUB_TIMEWEB_RELEASE_MANIFEST_V2',
      gitCommit: op.candidateSha,
      gitTree: op.candidateTree,
      images: [
        ['api', op.apiImage],
        ['worker', op.workerImage],
        ['migrator', op.publishedMigratorImage],
      ].map(([component, image]) => ({
        component,
        digest: image!.split('@')[1],
        revision: op.candidateSha,
      })),
    };
    expect(validateR1ApiWorker119Manifest(op, manifest)).toBe(manifest);
    manifest.images[1]!.revision = 'f'.repeat(40);
    expect(() => validateR1ApiWorker119Manifest(op, manifest)).toThrow();
  });
  it('does not accept caller-selected commands or grant SQL', () => {
    expect(() =>
      validateR1ApiWorker119Operation({
        ...r1ApiWorker119Fixture(),
        sql: 'grant all on all tables to public',
      }),
    ).toThrow();
  });
});
