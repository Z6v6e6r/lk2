import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const agents = readFileSync('AGENTS.md', 'utf8');
const template = readFileSync('.github/PULL_REQUEST_TEMPLATE.md', 'utf8');
const runbook = readFileSync('docs/runbooks/delivery-batches.md', 'utf8');

describe('delivery ownership policy', () => {
  it('separates repository task concurrency from in-task read-only agents', () => {
    expect(agents).toContain('Up to four independent task branches');
    expect(agents).toContain('two read-only subagents inside one complex task');
    expect(agents).toContain('Only one active platform/release task');
  });

  it('does not make ordinary main drift or Draft lifecycle a security boundary', () => {
    expect(agents).toContain('Ordinary `main` drift does not require every task branch');
    expect(agents).toContain('Draft to Ready is a lifecycle transition, not a security boundary');
    expect(agents).toContain('does not make one merge owner responsible');
  });

  it('keeps task, integration, release and deploy ownership distinct', () => {
    for (const role of ['task owner', 'integration owner', 'release owner', 'deploy owner']) {
      expect(agents.toLowerCase()).toContain(role);
    }
    expect(runbook).toContain('`integration/**`');
    expect(runbook).toContain('push: false');
    expect(runbook).toContain('never rebuilds on Timeweb');
    expect(runbook).toContain('current `main`, exact');
    expect(runbook).toContain('batch head, merge-base');
    expect(runbook).toContain('Drift stops that merge boundary');
    expect(runbook).not.toContain('workflow_dispatch');
  });

  it('keeps the PR template outcome-focused', () => {
    for (const heading of [
      'Outcome',
      'Scope',
      'Risk boundary',
      'Changed surfaces / ownership',
      'Checks',
      'Dependencies / integration order',
      'Rollback or recovery',
      'Live actions',
    ]) {
      expect(template).toContain(`## ${heading}`);
    }
    expect(template).not.toContain('Boundary checklist');
    expect(template).not.toContain('tree ledger');
  });
});
