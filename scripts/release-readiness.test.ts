import { describe, expect, it } from 'vitest';

import { evaluateReleaseReadiness } from './release-readiness.js';

const sha40 = (char: string): string => char.repeat(40);
const sha256 = (char: string): string => `sha256:${char.repeat(64)}`;
const at = (hours: number): string =>
  new Date(Date.UTC(2026, 9, 25, 8, 0, 0) + hours * 3_600_000).toISOString();

function fixture() {
  return {
    source: {
      sha: sha40('a'),
      mainSha: sha40('a'),
      ci: { runId: '40087508274', attempt: 1, conclusion: 'success' },
    },
    publication: {
      runId: '40091652483',
      attempt: 1,
      conclusion: 'success',
      sourceSha: sha40('a'),
      manifestSha256: 'b'.repeat(64),
      artifactDigest: sha256('c'),
    },
    capacity: {
      databaseBytes: 11_000_000_000,
      requiredDiskBytes: 30_000_000_000,
      freeDiskBytes: 42_000_000_000,
      profile: 'beta' as const,
    },
    ledger: { current: 102, target: 105 },
    approval: {
      approvedRequestSha256: 'd'.repeat(64),
      currentRequestSha256: 'd'.repeat(64),
      approvedAt: at(0),
      expiresAt: at(2),
      now: at(1),
    },
    locks: { activeOperations: 0, activeLease: false },
    rollback: { previousApiDigest: sha256('e'), previousWebDigest: sha256('f') },
  };
}

describe('release readiness report', () => {
  it('reports GO when every category is satisfied', () => {
    const report = evaluateReleaseReadiness(fixture());
    expect(report.status).toBe('GO');
    expect(report.categories.map((entry) => entry.category)).toEqual([
      'SOURCE',
      'PUBLICATION',
      'CAPACITY',
      'LEDGER',
      'APPROVAL',
      'LOCKS',
      'ROLLBACK',
    ]);
    expect(report.categories.every((entry) => entry.status === 'GO')).toBe(true);
  });

  it('reports a capacity provisioning blocker with the shortfall and action', () => {
    const input = fixture();
    const report = evaluateReleaseReadiness({
      ...input,
      capacity: {
        ...input.capacity,
        requiredDiskBytes: 47_453_667_687,
        freeDiskBytes: 42_928_771_072,
      },
    });
    const capacity = report.categories.find((entry) => entry.category === 'CAPACITY');
    expect(report.status).toBe('NO_GO');
    expect(capacity).toMatchObject({
      status: 'NO_GO',
      code: 'CAPACITY_PROVISIONING_REQUIRED',
    });
    expect(capacity?.detail).toContain('action=resize-or-cleanup');
    expect(report.capacity.shortfallBytes).toBeGreaterThan(0);
  });

  it('reports main drift as a source blocker', () => {
    const input = fixture();
    const report = evaluateReleaseReadiness({
      ...input,
      source: { ...input.source, mainSha: sha40('b') },
    });
    expect(report.status).toBe('NO_GO');
    expect(report.categories.find((entry) => entry.category === 'SOURCE')).toMatchObject({
      status: 'NO_GO',
      code: 'SOURCE_NOT_CURRENT_MAIN_CI',
    });
  });

  it('reports a changed approval input as an approval blocker', () => {
    const input = fixture();
    const report = evaluateReleaseReadiness({
      ...input,
      approval: { ...input.approval, currentRequestSha256: '9'.repeat(64) },
    });
    expect(report.status).toBe('NO_GO');
    expect(report.categories.find((entry) => entry.category === 'APPROVAL')).toMatchObject({
      status: 'NO_GO',
      code: 'INPUTS_CHANGED',
    });
  });

  it('treats missing lock or rollback evidence as NO_GO, never an implicit pass', () => {
    const input = fixture();
    const { locks, ...withoutLocks } = input;
    void locks;
    expect(
      evaluateReleaseReadiness(withoutLocks).categories.find((entry) => entry.category === 'LOCKS'),
    ).toMatchObject({ status: 'NO_GO', code: 'LOCK_EVIDENCE_MISSING' });
    const { rollback, ...withoutRollback } = input;
    void rollback;
    expect(
      evaluateReleaseReadiness(withoutRollback).categories.find(
        (entry) => entry.category === 'ROLLBACK',
      ),
    ).toMatchObject({ status: 'NO_GO', code: 'ROLLBACK_INPUTS_MISSING' });
  });
});
