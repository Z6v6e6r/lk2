#!/usr/bin/env node
/**
 * Read-only fitness check for a Timeweb beta deployment (ADR 0025, step 2).
 *
 * The preflight never mutates the host, the database, secrets, images or locks. It reports the
 * complete go/no-go gap list so a broken prerequisite is found in minutes instead of during a
 * multi-hour operation. See docs/runbooks/timeweb-beta-deploy-preflight.md.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  statfsSync,
  type Stats,
  type StatsFs,
} from 'node:fs';
import { arch, hostname, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { API_WORKER_MIGRATION_BRIDGE as bridge } from './timeweb-api-worker-migration.js';
import { evaluateCapacity } from './timeweb-restore-capacity.js';

export const PRE_LEDGER = '025c5ee129bd583131192439d991f0dbbba4fbd19c31c1215bca5adcee9ce17c'; // gitleaks:allow
export const POST_LEDGER = 'b9bfd91a3985de51b323d9955325b5edabc22b42cfc350bddebe811ca42c2f85'; // gitleaks:allow
export const SECRET_FILES = [
  '.release-identity.json',
  'api.env',
  'migrator.env',
  'realtime.env',
  'worker.env',
] as const;
export const FCM_KEYS = [
  'FCM_ENABLED',
  'FCM_PROJECT_ID',
  'FCM_APP_ID',
  'FCM_ENVIRONMENT',
  'FCM_CREDENTIAL_FILE',
] as const;

export type Profile = 'beta' | 'production';
export { evaluateCapacity };

export type Phase = 'pre-migration' | 'post-migration' | 'rollout';
export type CheckStatus = 'GO' | 'WARN' | 'BLOCKER' | 'EVIDENCE';

export interface Check {
  readonly id: string;
  readonly category: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface PreflightOptions {
  readonly profile: Profile;
  readonly phase: Phase;
  readonly root: string;
  readonly sourceDir: string;
  readonly configPath: string;
  readonly envDir: string;
  readonly candidateDir?: string;
  readonly candidateReleaseId?: string;
  readonly expectedCurrentSecretSetReleaseId?: string;
  readonly pgContainer: string;
  readonly ciRunId?: string;
  readonly githubToken?: string;
}

export interface PreflightDeps {
  exec(command: string, args: readonly string[]): string;
  exists(path: string): boolean;
  read(path: string): string;
  readBytes(path: string): Buffer;
  readdir(path: string): string[];
  stat(path: string): Stats;
  statvfs(path: string): StatsFs;
}

export const defaultDeps: PreflightDeps = {
  exec: (command, args) =>
    execFileSync(command, [...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }).trim(),
  exists: (path) => existsSync(path),
  read: (path) => readFileSync(path, 'utf8'),
  readBytes: (path) => readFileSync(path),
  readdir: (path) => readdirSync(path).sort(),
  stat: (path) => statSync(path),
  statvfs: (path) => statfsSync(path),
};

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function parseEnv(bytes: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of bytes.split('\n')) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    values.set(line.slice(0, index), line.slice(index + 1));
  }
  return values;
}

export function canonicalLedgerDigest(rows: readonly (readonly [string, string])[]): string {
  return digest(`${JSON.stringify(rows)}\n`);
}

export function expectedLedger(phase: Phase): string {
  return phase === 'pre-migration' ? PRE_LEDGER : POST_LEDGER;
}

function check(category: string, id: string, status: CheckStatus, detail: string): Check {
  return { category, id, status, detail };
}

function inspectContainerImage(deps: PreflightDeps, reference: string): string {
  const raw = deps.exec('/usr/bin/docker', [
    'image',
    'inspect',
    '--format',
    '{{.Id}}|{{json .Config.Labels}}',
    reference,
  ]);
  return raw;
}

function sql(deps: PreflightDeps, pgContainer: string, query: string): string {
  return deps.exec('/usr/bin/docker', [
    'exec',
    pgContainer,
    'psql',
    '-X',
    '--no-password',
    '--username=phub_beta',
    '--dbname=phub_beta',
    '--no-psqlrc',
    '--tuples-only',
    '--no-align',
    '--command',
    query,
  ]);
}

function sourceChecks(options: PreflightOptions, deps: PreflightDeps): Check[] {
  const checks: Check[] = [];
  checks.push(
    check(
      'host',
      'platform',
      platform() === 'linux' && arch() === 'x64' ? 'GO' : 'WARN',
      `${platform()}/${arch()} on ${hostname()} (target host is expected to be linux/x64)`,
    ),
  );
  try {
    const head = deps.exec('/usr/bin/git', ['-C', options.sourceDir, 'rev-parse', 'HEAD']);
    const tree = deps.exec('/usr/bin/git', ['-C', options.sourceDir, 'rev-parse', 'HEAD^{tree}']);
    const dirty = deps.exec('/usr/bin/git', [
      '-C',
      options.sourceDir,
      'status',
      '--porcelain',
      '--untracked-files=all',
    ]);
    checks.push(
      check(
        'source',
        'checkout',
        dirty === '' ? 'GO' : 'BLOCKER',
        dirty === ''
          ? `HEAD=${head}`
          : `dirty checkout: ${dirty.split('\n').slice(0, 3).join('; ')}`,
      ),
    );
    const config = JSON.parse(deps.read(options.configPath)) as { controllerSha?: string };
    checks.push(
      check(
        'source',
        'controller',
        config.controllerSha === head ? 'GO' : 'BLOCKER',
        `config=${config.controllerSha ?? 'missing'} HEAD=${head} tree=${tree}`,
      ),
    );
  } catch (error) {
    checks.push(
      check('source', 'checkout', 'BLOCKER', `source read failed: ${(error as Error).message}`),
    );
  }
  return checks;
}

function imageChecks(options: PreflightOptions, deps: PreflightDeps): Check[] {
  const checks: Check[] = [];
  const references = [
    ['api', `ghcr.io/z6v6e6r/phub-api@${bridge.candidateApiDigest}`],
    ['worker', `ghcr.io/z6v6e6r/phub-worker@${bridge.candidateWorkerDigest}`],
  ] as const;
  for (const [service, reference] of references) {
    try {
      const raw = inspectContainerImage(deps, reference);
      const [id, labels] = raw.split('|');
      const revision = (JSON.parse(labels ?? '{}') as Record<string, string>)[
        'org.opencontainers.image.revision'
      ];
      const ok = id?.startsWith('sha256:') === true && revision === bridge.candidateSha;
      checks.push(
        check('images', service, ok ? 'GO' : 'BLOCKER', `${reference} id=${id} rev=${revision}`),
      );
    } catch {
      checks.push(check('images', service, 'BLOCKER', `${reference} is not present locally`));
    }
  }
  try {
    const migrator = bridge.migratorImage;
    const raw = inspectContainerImage(deps, migrator);
    checks.push(
      check('images', 'migrator', raw.startsWith('sha256:') ? 'GO' : 'BLOCKER', migrator),
    );
  } catch (error) {
    checks.push(check('images', 'migrator', 'BLOCKER', (error as Error).message));
  }
  return checks;
}

function databaseChecks(
  options: PreflightOptions,
  deps: PreflightDeps,
): { checks: Check[]; databaseBytes: number } {
  const checks: Check[] = [];
  let databaseBytes = 0;
  try {
    const raw = sql(
      deps,
      options.pgContainer,
      "select coalesce(json_agg(json_build_array(filename, checksum) order by filename), '[]'::json)::text from public.schema_migrations",
    );
    const rows = JSON.parse(raw) as [string, string][];
    const actual = canonicalLedgerDigest(rows);
    const expected = expectedLedger(options.phase);
    checks.push(
      check(
        'database',
        'ledger',
        rows.length > 0 && actual === expected ? 'GO' : 'BLOCKER',
        `${rows.length} migrations digest=${actual.slice(0, 12)}… expected=${expected.slice(0, 12)}…`,
      ),
    );
    const size = sql(deps, options.pgContainer, 'select pg_database_size(current_database())');
    databaseBytes = Number(size);
    checks.push(
      check(
        'database',
        'size',
        Number.isSafeInteger(databaseBytes) && databaseBytes > 0 ? 'GO' : 'BLOCKER',
        `pg_database_size=${databaseBytes}`,
      ),
    );
    const roleRows = sql(
      deps,
      options.pgContainer,
      "select rolname,rolsuper,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls from pg_roles where rolname in ('phub_runtime','phub_migrator') order by rolname",
    )
      .split('\n')
      .filter(Boolean);
    const roles = new Map(
      roleRows.map((line) => {
        const [name, ...flags] = line.split('|');
        return [name, flags] as const;
      }),
    );
    for (const role of ['phub_migrator', 'phub_runtime']) {
      const flags = roles.get(role);
      const dangerous =
        flags === undefined || [0, 1, 2, 4, 5].some((index) => flags[index] === 't');
      checks.push(
        check(
          'database',
          `role-${role}`,
          flags && !dangerous ? 'GO' : 'BLOCKER',
          flags ? `${role} flags=${flags.join(',')}` : `${role} is missing`,
        ),
      );
    }
  } catch (error) {
    checks.push(check('database', 'query', 'BLOCKER', (error as Error).message));
  }
  return { checks, databaseBytes };
}

function capacityChecks(
  options: PreflightOptions,
  deps: PreflightDeps,
  databaseBytes: number,
): Check[] {
  if (databaseBytes <= 0) return [];
  try {
    const meminfo = deps.read('/proc/meminfo');
    const match = /^MemAvailable:\s+([0-9]+) kB$/mu.exec(meminfo);
    if (!match) throw new Error('MemAvailable is missing from /proc/meminfo');
    const availableMemory = Number(match[1]) * 1024;
    const stats = deps.statvfs(options.root);
    const freeDisk = stats.bavail * stats.frsize;
    const verdict = evaluateCapacity(databaseBytes, availableMemory, freeDisk);
    return [
      check(
        'capacity',
        'restore-mode',
        verdict.model === 'none' ? 'BLOCKER' : 'GO',
        `${verdict.detail}${verdict.model === 'disk' ? ' (disk/LUKS restore)' : ''}`,
      ),
    ];
  } catch (error) {
    return [check('capacity', 'restore-mode', 'BLOCKER', (error as Error).message)];
  }
}

function secretChecks(options: PreflightOptions, deps: PreflightDeps): Check[] {
  const checks: Check[] = [];
  try {
    const names = deps.readdir(options.envDir);
    const missing = SECRET_FILES.filter((name) => !names.includes(name));
    const extra = names.filter(
      (name) => !SECRET_FILES.includes(name as (typeof SECRET_FILES)[number]),
    );
    checks.push(
      check(
        'secrets',
        'installed-set',
        missing.length === 0 && extra.length === 0 ? 'GO' : 'BLOCKER',
        missing.length || extra.length
          ? `missing=${missing.join(',')} extra=${extra.join(',')}`
          : `${SECRET_FILES.length} files`,
      ),
    );
    for (const name of SECRET_FILES) {
      const path = join(options.envDir, name);
      const info = deps.stat(path);
      const mode = info.mode & 0o777;
      checks.push(
        check(
          'secrets',
          `mode-${name}`,
          mode === 0o600 && info.uid === 0 ? 'GO' : 'BLOCKER',
          `mode=${mode.toString(8)} uid=${info.uid} size=${info.size}`,
        ),
      );
    }
    const identity = JSON.parse(deps.read(join(options.envDir, '.release-identity.json'))) as {
      releaseId?: string;
    };
    checks.push(
      check(
        'secrets',
        'release-id',
        options.expectedCurrentSecretSetReleaseId === undefined ||
          identity.releaseId === options.expectedCurrentSecretSetReleaseId
          ? 'GO'
          : 'BLOCKER',
        `installed=${identity.releaseId ?? 'missing'} expected=${options.expectedCurrentSecretSetReleaseId ?? 'any'}`,
      ),
    );
    const api = parseEnv(deps.read(join(options.envDir, 'api.env')));
    const worker = parseEnv(deps.read(join(options.envDir, 'worker.env')));
    checks.push(
      check(
        'secrets',
        'fcm-installed',
        api.get('FCM_ENABLED') !== 'true' && worker.get('FCM_ENABLED') !== 'true' ? 'GO' : 'WARN',
        `installed FCM_ENABLED api=${api.get('FCM_ENABLED') ?? 'false'} worker=${worker.get('FCM_ENABLED') ?? 'false'}`,
      ),
    );
    if (options.candidateDir) {
      try {
        const candidateNames = deps.readdir(options.candidateDir);
        const candidateMissing = SECRET_FILES.filter((name) => !candidateNames.includes(name));
        const candidateApi = parseEnv(deps.read(join(options.candidateDir, 'api.env')));
        const candidateWorker = parseEnv(deps.read(join(options.candidateDir, 'worker.env')));
        const fcmOk =
          candidateApi.get('FCM_ENABLED') === 'true' &&
          candidateWorker.get('FCM_ENABLED') === 'true' &&
          FCM_KEYS.every((key) => candidateApi.has(key) && candidateWorker.has(key));
        const candidateIdentity = JSON.parse(
          deps.read(join(options.candidateDir, '.release-identity.json')),
        ) as { releaseId?: string };
        checks.push(
          check(
            'secrets',
            'candidate-set',
            candidateMissing.length === 0 && fcmOk ? 'GO' : 'BLOCKER',
            candidateMissing.length
              ? `missing=${candidateMissing.join(',')}`
              : `releaseId=${candidateIdentity.releaseId ?? 'missing'} fcm=${fcmOk}`,
          ),
        );
      } catch (error) {
        checks.push(check('secrets', 'candidate-set', 'BLOCKER', (error as Error).message));
      }
    }
    const credential = '/etc/phub/timeweb-beta-fcm/fcm-service-account.json';
    if (deps.exists(credential)) {
      const info = deps.stat(credential);
      checks.push(
        check(
          'secrets',
          'fcm-credential',
          info.isFile() && info.size > 0 ? 'EVIDENCE' : 'BLOCKER',
          `metadata only: mode=${(info.mode & 0o777).toString(8)} uid=${info.uid} size=${info.size}`,
        ),
      );
    } else {
      checks.push(
        check(
          'secrets',
          'fcm-credential',
          options.profile === 'production' ? 'BLOCKER' : 'WARN',
          `${credential} is missing`,
        ),
      );
    }
  } catch (error) {
    checks.push(check('secrets', 'installed-set', 'BLOCKER', (error as Error).message));
  }
  return checks;
}

function lockChecks(options: PreflightOptions, deps: PreflightDeps, releaseId: string): Check[] {
  const checks: Check[] = [];
  const backups = join(options.root, 'backups');
  const paths = [
    join(options.root, 'standard', 'active'),
    '/etc/phub/.timeweb-beta.provision.lock',
    join(backups, `${releaseId}-api-worker`),
    join(backups, `${releaseId}-migration`),
  ];
  const present = paths.filter((path) => deps.exists(path));
  if (deps.exists(backups)) {
    for (const name of deps.readdir(backups)) {
      if (name.startsWith('.disk-restore-')) present.push(join(backups, name));
    }
  }
  checks.push(
    check(
      'locks',
      'owned-state',
      present.length === 0 ? 'GO' : 'BLOCKER',
      present.length === 0 ? 'no active/provision/transaction pointers' : present.join(', '),
    ),
  );
  try {
    const restore = deps.exec('/usr/bin/docker', [
      'ps',
      '-a',
      '--format',
      '{{.Names}}',
      '--filter',
      'name=phub-timeweb-restore',
    ]);
    checks.push(
      check(
        'locks',
        'restore-containers',
        restore === '' ? 'GO' : 'BLOCKER',
        restore === '' ? 'none' : restore.split('\n').join(', '),
      ),
    );
  } catch (error) {
    checks.push(check('locks', 'restore-containers', 'BLOCKER', (error as Error).message));
  }
  return checks;
}

function evidenceChecks(options: PreflightOptions, deps: PreflightDeps): Check[] {
  const checks: Check[] = [];
  const observability = join(options.root, 'observability');
  for (const name of ['timeweb-monitor-readback.json', 'alert-test-readback.json']) {
    const path = join(observability, name);
    checks.push(
      check(
        'evidence',
        name,
        deps.exists(path) ? 'EVIDENCE' : options.profile === 'production' ? 'BLOCKER' : 'WARN',
        deps.exists(path) ? `${path} present (recorded evidence)` : `${path} is missing`,
      ),
    );
  }
  try {
    const ids = deps
      .exec('/usr/bin/docker', ['ps', '-aq', '--no-trunc'])
      .split('\n')
      .filter(Boolean)
      .sort();
    checks.push(
      check(
        'evidence',
        'container-boundary',
        'EVIDENCE',
        `${ids.length} containers boundary=${digest(JSON.stringify(ids)).slice(0, 16)}…`,
      ),
    );
  } catch (error) {
    checks.push(check('evidence', 'container-boundary', 'WARN', (error as Error).message));
  }
  checks.push(
    check(
      'evidence',
      'source-ci',
      options.ciRunId === undefined ? 'WARN' : 'EVIDENCE',
      options.ciRunId === undefined
        ? 'pass --ci-run-id and GITHUB_TOKEN to verify the controller main-push CI'
        : `run ${options.ciRunId}`,
    ),
  );
  return checks;
}

export function summarize(checks: readonly Check[]): {
  status: 'GO' | 'NO_GO';
  blockers: number;
  warnings: number;
} {
  const blockers = checks.filter((value) => value.status === 'BLOCKER').length;
  const warnings = checks.filter((value) => value.status === 'WARN').length;
  return { status: blockers === 0 ? 'GO' : 'NO_GO', blockers, warnings };
}

export function formatHuman(checks: readonly Check[], profile: Profile, phase: Phase): string {
  const lines = [`Preflight profile=${profile} phase=${phase}`];
  for (const value of checks) {
    lines.push(`[${value.status}] ${value.category}/${value.id} — ${value.detail}`);
  }
  const summary = summarize(checks);
  lines.push(`RESULT ${summary.status}: blockers=${summary.blockers} warnings=${summary.warnings}`);
  return `${lines.join('\n')}\n`;
}

export function parseArgs(argv: readonly string[]): PreflightOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') {
      values.set('json', '1');
      continue;
    }
    if (!token?.startsWith('--')) throw new Error(`Invalid argument ${token ?? '<missing>'}`);
    const separator = token.indexOf('=');
    if (separator > 2) {
      values.set(token.slice(2, separator), token.slice(separator + 1));
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Invalid argument ${token}`);
    }
    values.set(token.slice(2), value);
    index += 1;
  }
  const profile = (values.get('profile') ?? 'beta') as Profile;
  const phase = (values.get('phase') ?? 'rollout') as Phase;
  if (profile !== 'beta' && profile !== 'production')
    throw new Error('--profile must be beta or production');
  if (!['pre-migration', 'post-migration', 'rollout'].includes(phase))
    throw new Error('--phase must be pre-migration, post-migration or rollout');
  const root = resolve(values.get('root') ?? '/opt/phub/timeweb-beta');
  const candidateDir = values.get('candidate-dir');
  const candidateReleaseId = values.get('candidate-release-id');
  const expectedCurrentSecretSetReleaseId = values.get('expected-current-secret-set');
  const ciRunId = values.get('ci-run-id');
  const githubToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return {
    profile,
    phase,
    root,
    sourceDir: resolve(values.get('source') ?? join(root, 'standard/source')),
    configPath: resolve(values.get('config') ?? '/etc/phub/timeweb-beta-standard-delivery.json'),
    envDir: resolve(values.get('env-dir') ?? '/etc/phub/timeweb-beta'),
    pgContainer: values.get('pg-container') ?? 'phub-timeweb-beta-dependencies-postgres-1',
    ...(candidateDir === undefined ? {} : { candidateDir }),
    ...(candidateReleaseId === undefined ? {} : { candidateReleaseId }),
    ...(expectedCurrentSecretSetReleaseId === undefined
      ? {}
      : { expectedCurrentSecretSetReleaseId }),
    ...(ciRunId === undefined ? {} : { ciRunId }),
    ...(githubToken === undefined ? {} : { githubToken }),
  };
}

export function runPreflight(
  options: PreflightOptions,
  deps: PreflightDeps = defaultDeps,
): Check[] {
  const checks: Check[] = [];
  const releaseId =
    options.candidateReleaseId ?? `${bridge.candidateSha}-${bridge.publicationRunId}-1`;
  checks.push(
    check(
      'artifact',
      'candidate',
      'EVIDENCE',
      `sha=${bridge.candidateSha} tree=${bridge.candidateTree} release=${releaseId} publication=${bridge.publicationRunId}`,
    ),
  );
  checks.push(...sourceChecks(options, deps));
  checks.push(...imageChecks(options, deps));
  const database = databaseChecks(options, deps);
  checks.push(...database.checks);
  checks.push(...capacityChecks(options, deps, database.databaseBytes));
  checks.push(...secretChecks(options, deps));
  checks.push(...lockChecks(options, deps, releaseId));
  checks.push(...evidenceChecks(options, deps));
  if (options.ciRunId !== undefined && options.githubToken !== undefined) {
    const verifier = pathToFileURL(join(options.sourceDir, 'scripts/verify-source-ci.js')).href;
    const program =
      `import {readSourceCi} from ${JSON.stringify(verifier)};` +
      `await readSourceCi(${JSON.stringify(options.ciRunId)},` +
      `${JSON.stringify(bridge.candidateSha)},process.env.GITHUB_TOKEN);`;
    const result = spawnSync('/usr/bin/node', ['--input-type=module', '-e', program], {
      encoding: 'utf8',
      timeout: 45000,
      env: { ...process.env, GITHUB_TOKEN: options.githubToken },
    });
    checks.push(
      check(
        'evidence',
        'source-ci',
        result.status === 0 ? 'GO' : 'BLOCKER',
        result.status === 0
          ? `run ${options.ciRunId} verified`
          : `CI verification failed: ${(result.stderr ?? '').trim().slice(0, 200)}`,
      ),
    );
  }
  return checks;
}

function main(argv: readonly string[]): number {
  if (argv.includes('--help')) {
    process.stdout.write(
      'Usage: preflight-timeweb-beta-deploy --profile=beta|production [--phase=pre-migration|post-migration|rollout] [--json] [--ci-run-id=ID]\n',
    );
    return 0;
  }
  const options = parseArgs(argv);
  const checks = runPreflight(options);
  const summary = summarize(checks);
  if (argv.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify({ profile: options.profile, phase: options.phase, summary, checks }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(formatHuman(checks, options.profile, options.phase));
  }
  return summary.status === 'GO' ? 0 : 1;
}

if (process.argv[1]?.endsWith('preflight-timeweb-beta-deploy.ts')) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`PREFLIGHT_ERROR ${(error as Error).message}\n`);
    process.exitCode = 2;
  }
}
