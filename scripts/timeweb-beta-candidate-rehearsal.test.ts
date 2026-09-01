import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { parseTimewebBetaCandidateArguments } from './test-timeweb-beta-candidate.js';

const root = resolve(import.meta.dirname, '..');

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('Timeweb beta candidate rehearsal wiring', () => {
  const composeSource = read('deploy/timeweb/compose.rehearsal.yaml');
  const compose = parse(composeSource) as {
    name: string;
    services: Record<
      string,
      {
        profiles?: string[];
        ports?: string[];
        restart?: string;
        volumes?: string[];
        labels?: Record<string, string>;
      }
    >;
    volumes: Record<string, unknown>;
    networks?: Record<string, unknown>;
  };

  it('uses a unique local project, project-scoped volumes, and a random loopback port', () => {
    expect(compose.name).toContain('TIMEWEB_REHEARSAL_PROJECT');
    expect(Object.keys(compose.volumes).sort()).toEqual([
      'postgres_data',
      'rabbitmq_data',
      'redis_data',
    ]);
    expect(compose.networks).toBeUndefined();
    expect(compose.services.proxy?.ports).toEqual(['127.0.0.1::8080']);
    expect(composeSource).not.toMatch(/(?:0\.0\.0\.0|host_ip|external:\s*true)/u);
  });

  it('keeps Worker and Migrator profile-gated and all services restartable or one-shot', () => {
    expect(compose.services.worker?.profiles).toEqual(['background']);
    expect(compose.services.migrator?.profiles).toEqual(['migration']);
    expect(compose.services.migrator?.restart).toBe('no');
    for (const service of [
      'postgres',
      'redis',
      'rabbitmq',
      'api',
      'realtime',
      'worker',
      'web',
      'proxy',
    ]) {
      expect(compose.services[service]?.restart).toBe('unless-stopped');
    }
  });

  it('pins candidate identity on every application service', () => {
    for (const service of ['api', 'realtime', 'worker', 'web', 'migrator', 'proxy']) {
      const source = JSON.stringify(compose.services[service]);
      expect(source).toContain('TIMEWEB_REHEARSAL_SOURCE_SHA');
      expect(source).toContain('TIMEWEB_REHEARSAL_SOURCE_TREE');
      expect(source).toContain('TIMEWEB_REHEARSAL_RELEASE_ID');
    }
  });

  it('exposes one project-native command and documents its safety and rollback boundaries', () => {
    const packageJson = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['test:timeweb-beta-candidate']).toBe(
      'node --import tsx scripts/test-timeweb-beta-candidate.ts',
    );
    const runbook = read('docs/runbooks/timeweb-beta-candidate-rehearsal.md');
    expect(runbook).toContain('random loopback port');
    expect(runbook).toContain('Database migration is forward-only');
    expect(runbook).toContain('PROVIDER_WRITES=0');
    expect(runbook).toContain('distinct verified previous candidate');
  });

  it('rejects a full run without exact current and previous publication evidence', () => {
    const candidateArguments = [
      '--manifest-dir',
      '/tmp/candidate',
      '--expected-source-sha',
      '1'.repeat(40),
      '--expected-source-tree',
      '2'.repeat(40),
      '--expected-publication-run-id',
      '123',
      '--expected-manifest-checksum',
      '3'.repeat(64),
    ];
    expect(() => parseTimewebBetaCandidateArguments([])).toThrow(
      'full rehearsal requires an exact verified candidate manifest',
    );
    expect(() => parseTimewebBetaCandidateArguments(candidateArguments)).toThrow(
      'full rehearsal requires a distinct verified previous candidate manifest',
    );
    expect(() => parseTimewebBetaCandidateArguments(['--contract-only'])).not.toThrow();
  });

  it('fails closed on remote Docker contexts, network writes, and incomplete evidence', () => {
    const candidateHarness = read('scripts/test-timeweb-beta-candidate.ts');
    const browserHarness = read('scripts/timeweb-beta-browser-smoke.ts');
    expect(candidateHarness).toContain("endpoint.startsWith('unix://')");
    expect(candidateHarness).toContain("key.startsWith('DOCKER_')");
    expect(candidateHarness).toContain('--expected-publication-run-id');
    expect(candidateHarness).toContain('--expected-manifest-checksum');
    expect(candidateHarness).toContain(
      'full rehearsal requires a distinct verified previous candidate manifest',
    );
    expect(browserHarness).toContain("client.command('Fetch.enable'");
    expect(browserHarness).toContain("client.command('Network.enable'");
    expect(browserHarness).toContain("errorReason: 'BlockedByClient'");
  });

  it('uses bounded HTTP readiness retries around start, restart, and rollback', () => {
    const candidateHarness = read('scripts/test-timeweb-beta-candidate.ts');
    expect(candidateHarness).toContain("await waitFor('rehearsal HTTP readiness'");
    expect(candidateHarness.match(/await waitForHttp\(/gu)).toHaveLength(3);
    expect(candidateHarness).not.toContain('await verifyHttp(');
    expect(candidateHarness).toContain(
      'const restartedBaseUrl = proxyBaseUrl(compose, environment)',
    );
  });
});
