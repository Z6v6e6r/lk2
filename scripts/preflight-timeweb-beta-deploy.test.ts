import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { API_WORKER_MIGRATION_BRIDGE as bridge } from './timeweb-api-worker-migration.js';
import {
  POST_LEDGER,
  PRE_LEDGER,
  SECRET_FILES,
  canonicalLedgerDigest,
  evaluateCapacity,
  expectedLedger,
  formatHuman,
  parseArgs,
  parseEnv,
  runPreflight,
  summarize,
  type PreflightDeps,
  type PreflightOptions,
} from './preflight-timeweb-beta-deploy.js';

const GIB = 1024 ** 3;
const HEAD = 'a'.repeat(40);
const RELEASE = `${bridge.candidateSha}-${bridge.publicationRunId}-1`;

const fixture = JSON.parse(
  readFileSync(join('scripts/fixtures/timeweb-api-worker-ledger-8158ac44.json'), 'utf8'),
) as { ledger: { filename: string; checksum: string }[] };
const ledgerRows = fixture.ledger.map((row) => [row.filename, row.checksum] as [string, string]);
const ledgerJson = JSON.stringify(ledgerRows);

function envBytes(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

interface Scenario {
  readonly ledgerJson?: string;
  readonly missingImage?: string;
  readonly dirty?: string;
  readonly controller?: string;
  readonly restoreContainer?: string;
  readonly activeLock?: boolean;
  readonly observability?: boolean;
  readonly databaseBytes?: number;
  readonly secretFiles?: readonly string[];
}

function happyFileSet(): Map<string, string> {
  const root = '/tmp/preflight';
  const files = new Map<string, string>();
  files.set('/proc/meminfo', 'MemAvailable: 8388608 kB\n');
  files.set(`${root}-config.json`, JSON.stringify({ controllerSha: HEAD }));
  files.set(
    `${root}-src/scripts/timeweb-api-worker-migration.js`,
    "MIGRATOR_IMAGE = 'ghcr.io/z6v6e6r/phub-migrator@sha256:e3d23565c928baa331e409d27dac48ac6f9821ea2288e3c45bc72c3694af79aa';\n",
  );
  for (const name of SECRET_FILES) files.set(`${root}-env/${name}`, 'X=1\n');
  files.set(
    `${root}-env/.release-identity.json`,
    JSON.stringify({
      schema: 'PHUB_TIMEWEB_SECRET_SET_V1',
      releaseId: 'c43e9dc8da3eb19a1684ed28e989aafacdb5d8bf-36629104876-1', // gitleaks:allow
    }),
  );
  files.set(`${root}-env/api.env`, `${envBytes({ FCM_ENABLED: 'false' })}\n`);
  files.set(`${root}-env/worker.env`, `${envBytes({ FCM_ENABLED: 'false' })}\n`);
  for (const name of SECRET_FILES) files.set(`${root}-cand/${name}`, 'X=1\n');
  files.set(
    `${root}-cand/.release-identity.json`,
    JSON.stringify({ schema: 'PHUB_TIMEWEB_SECRET_SET_V1', releaseId: RELEASE }),
  );
  const fcm = envBytes({
    FCM_ENABLED: 'true',
    FCM_PROJECT_ID: 'padlhub',
    FCM_APP_ID: 'ru.padlhub.app',
    FCM_ENVIRONMENT: 'SANDBOX',
    FCM_CREDENTIAL_FILE: '/run/phub/fcm-service-account.json',
  });
  files.set(`${root}-cand/api.env`, fcm);
  files.set(`${root}-cand/worker.env`, fcm);
  return files;
}

function fakeDeps(scenario: Scenario = {}): PreflightDeps {
  const files = happyFileSet();
  return {
    exec: (command, args) => {
      const key = [command, ...args].join(' ');
      if (command.endsWith('git') && args.includes('rev-parse') && key.endsWith('HEAD'))
        return HEAD;
      if (command.endsWith('git') && key.endsWith('HEAD^{tree}')) return 'b'.repeat(40);
      if (command.endsWith('git') && args.includes('status')) return scenario.dirty ?? '';
      if (command.endsWith('docker') && args[0] === 'image') {
        const reference = args[args.length - 1] ?? '';
        if (scenario.missingImage && reference.includes(scenario.missingImage))
          throw new Error('missing');
        return `sha256:${'c'.repeat(64)}|${JSON.stringify({ 'org.opencontainers.image.revision': bridge.candidateSha })}`;
      }
      if (command.endsWith('docker') && args[0] === 'ps' && args.includes('--filter')) {
        return scenario.restoreContainer ?? '';
      }
      if (command.endsWith('docker') && args[0] === 'ps') return 'id-1\nid-2\n';
      if (command.endsWith('docker') && args[0] === 'exec') {
        const query = args[args.length - 1] ?? '';
        if (query.includes('schema_migrations')) return scenario.ledgerJson ?? ledgerJson;
        if (query.includes('pg_database_size')) return String(scenario.databaseBytes ?? 1024 ** 2);
        if (query.includes('pg_roles'))
          return 'phub_migrator|f|f|f|t|f|f\nphub_runtime|f|f|f|t|f|f';
      }
      throw new Error(`unexpected command: ${key}`);
    },
    exists: (path) =>
      scenario.activeLock === true && path.endsWith('/standard/active')
        ? true
        : scenario.observability === true &&
            (path.endsWith('timeweb-monitor-readback.json') ||
              path.endsWith('alert-test-readback.json'))
          ? true
          : files.has(path),
    read: (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`unreadable ${path}`);
      return value;
    },
    readBytes: (path) => Buffer.from(files.get(path) ?? '', 'utf8'),
    readdir: (path) => {
      if (path.endsWith('-env')) return [...(scenario.secretFiles ?? SECRET_FILES)];
      if (path.endsWith('-cand')) return [...SECRET_FILES];
      if (path.endsWith('/backups')) return [];
      throw new Error(`unexpected readdir ${path}`);
    },
    stat: (path) =>
      ({
        mode: 0o100600,
        uid: 0,
        gid: 0,
        size: files.get(path)?.length ?? 1,
        isFile: () => true,
      }) as never,
    statvfs: () => ({ bavail: 45 * GIB, frsize: 1 }) as never,
  };
}

function options(): PreflightOptions {
  const root = '/tmp/preflight';
  return {
    profile: 'beta',
    phase: 'rollout',
    root,
    sourceDir: `${root}-src`,
    configPath: `${root}-config.json`,
    envDir: `${root}-env`,
    candidateDir: `${root}-cand`,
    expectedCurrentSecretSetReleaseId: 'c43e9dc8da3eb19a1684ed28e989aafacdb5d8bf-36629104876-1', // gitleaks:allow
    pgContainer: 'pg',
  };
}

describe('preflight primitives', () => {
  it('derives the 102-row post ledger digest from the frozen fixture', () => {
    expect(ledgerRows).toHaveLength(102);
    expect(canonicalLedgerDigest(ledgerRows)).toBe(POST_LEDGER);
    expect(expectedLedger('pre-migration')).toBe(PRE_LEDGER);
    expect(expectedLedger('post-migration')).toBe(POST_LEDGER);
    expect(expectedLedger('rollout')).toBe(POST_LEDGER);
  });

  it('parses env files and picks a restore mode from real capacities', () => {
    expect(parseEnv('A=1\nB=x=y\n# c\n').get('B')).toBe('x=y');
    const small = evaluateCapacity(1 * GIB, 8 * GIB, 45 * GIB);
    expect(small.model).toBe('namespace');
    const large = evaluateCapacity(9.5 * GIB, 8.9 * GIB, 45 * GIB);
    expect(large.model).toBe('disk');
    const impossible = evaluateCapacity(9.5 * GIB, 8.9 * GIB, 20 * GIB);
    expect(impossible.model).toBe('none');
  });

  it('summarizes blockers and formats a report', () => {
    const checks = [
      { category: 'a', id: 'ok', status: 'GO' as const, detail: '' },
      { category: 'a', id: 'warn', status: 'WARN' as const, detail: '' },
    ];
    expect(summarize(checks)).toMatchObject({ status: 'GO', blockers: 0, warnings: 1 });
    expect(formatHuman(checks, 'beta', 'rollout')).toContain('RESULT GO');
  });

  it('parses the automated command line', () => {
    expect(parseArgs(['--profile=beta', '--phase=rollout', '--json'])).toMatchObject({
      profile: 'beta',
      phase: 'rollout',
    });
    expect(() => parseArgs(['--profile=staging'])).toThrow();
  });
});

describe('preflight checks', () => {
  it('returns GO for a prepared beta rollout with recorded-only evidence gaps', () => {
    const checks = runPreflight(options(), fakeDeps());
    const summary = summarize(checks);
    expect(summary.blockers, JSON.stringify(checks.filter((c) => c.status === 'BLOCKER'))).toBe(0);
    expect(checks.find((c) => c.id === 'ledger')?.status).toBe('GO');
    expect(checks.find((c) => c.id === 'restore-mode')?.status).toBe('GO');
    expect(checks.find((c) => c.id === 'candidate-set')?.status).toBe('GO');
  });

  it('blocks on ledger drift, missing images, dirty source and active locks', () => {
    const checks = runPreflight(
      options(),
      fakeDeps({
        ledgerJson: JSON.stringify(ledgerRows.slice(0, 101)),
        missingImage: 'phub-api',
        dirty: ' M apps/api/src/main.ts',
        activeLock: true,
        restoreContainer: 'phub-timeweb-restore-x',
      }),
    );
    const blockers = checks.filter((c) => c.status === 'BLOCKER').map((c) => c.id);
    expect(blockers).toEqual(
      expect.arrayContaining(['ledger', 'api', 'checkout', 'owned-state', 'restore-containers']),
    );
    expect(summarize(checks).status).toBe('NO_GO');
  });

  it('blocks an impossible restore capacity on a large database', () => {
    const deps = fakeDeps({ databaseBytes: Math.round(9.5 * GIB) });
    deps.statvfs = () => ({ bavail: 20 * GIB, frsize: 1 }) as never;
    const checks = runPreflight(options(), deps);
    expect(checks.find((c) => c.id === 'restore-mode')?.status).toBe('BLOCKER');
  });
});
