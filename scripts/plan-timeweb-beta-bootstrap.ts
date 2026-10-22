#!/usr/bin/env node
/**
 * Read-only beta bootstrap readiness plan (ADR 0025 step 6).
 *
 * Says whether the host is ready to run the simplified beta path: least-privilege database roles,
 * installed/candidate secret sets, FCM credential custody, monitoring evidence and the restore
 * capacity mode. It never creates a role, writes a secret or changes a file: applying the plan stays
 * an explicitly authorized operation because roles and secrets are a security boundary.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statfsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { SECRET_FILES, parseEnv, type PreflightDeps } from './preflight-timeweb-beta-deploy.js';
import {
  evaluateCapacity,
  restoreSchema,
  type CapacityVerdict,
  type RestorePhase,
} from './timeweb-restore-capacity.js';

export type BootstrapStatus = 'READY' | 'ACTION' | 'BLOCKER';

export interface BootstrapCheck {
  readonly id: string;
  readonly status: BootstrapStatus;
  readonly detail: string;
  readonly remediation?: string;
}

export interface RoleFacts {
  readonly exists: boolean;
  readonly superUser: boolean;
  readonly createRole: boolean;
  readonly createDatabase: boolean;
  readonly replication: boolean;
  readonly bypassRls: boolean;
  readonly databaseCreate: boolean;
  readonly schemaCreate: boolean;
  readonly uncoveredTables: number;
  readonly totalTables: number;
}

export interface BootstrapFacts {
  readonly runtime: RoleFacts | null;
  readonly migrator: RoleFacts | null;
  readonly secretFiles: readonly string[];
  readonly secretModes: Readonly<Record<string, number>>;
  readonly installedReleaseId: string | null;
  readonly candidate: 'absent' | 'ready' | 'invalid';
  readonly candidateDetail: string;
  readonly fcmCredential: boolean;
  readonly monitorReadback: boolean;
  readonly alertReadback: boolean;
  readonly capacity: CapacityVerdict;
  readonly phase: RestorePhase;
}

export interface BootstrapPlan {
  readonly checks: readonly BootstrapCheck[];
  readonly summary: {
    readonly status: 'READY' | 'NOT_READY';
    readonly blockers: number;
    readonly actions: number;
    readonly restoreSchema: string | null;
  };
}

const ROLE_FLAGS: ReadonlyArray<readonly [keyof RoleFacts, string]> = [
  ['superUser', 'SUPERUSER'],
  ['createRole', 'CREATEROLE'],
  ['createDatabase', 'CREATEDB'],
  ['replication', 'REPLICATION'],
  ['bypassRls', 'BYPASSRLS'],
];

export function evaluateBootstrap(facts: BootstrapFacts): BootstrapPlan {
  const checks: BootstrapCheck[] = [];
  for (const name of ['runtime', 'migrator'] as const) {
    const role = facts[name];
    if (!role?.exists) {
      checks.push({
        id: `role-${name}`,
        status: 'BLOCKER',
        detail: `role phub_${name === 'runtime' ? 'runtime' : 'migrator'} is missing`,
        remediation: `create the least-privilege phub_${name} role and grant only the operations the canonical role validator proves`,
      });
      continue;
    }
    const forbidden = ROLE_FLAGS.filter(([key]) => role[key] === true).map(([, label]) => label);
    checks.push({
      id: `role-${name}`,
      status: forbidden.length === 0 ? 'READY' : 'BLOCKER',
      detail:
        forbidden.length === 0
          ? `${name} role present without service/admin flags`
          : `forbidden privileges: ${forbidden.join(', ')}`,
      ...(forbidden.length === 0
        ? {}
        : { remediation: `revoke ${forbidden.join(', ')} from phub_${name}` }),
    });
    if (name === 'migrator') {
      checks.push({
        id: 'role-migrator-db-create',
        status: role.databaseCreate ? 'READY' : 'BLOCKER',
        detail: `database CREATE=${role.databaseCreate} schema CREATE=${role.schemaCreate}`,
        ...(role.databaseCreate
          ? {}
          : {
              remediation:
                'grant CREATE ON DATABASE to phub_migrator (0098 create schema requires it)',
            }),
      });
    } else {
      const covered = role.totalTables - role.uncoveredTables;
      checks.push({
        id: 'role-runtime-dml',
        status: role.uncoveredTables === 0 ? 'READY' : 'ACTION',
        detail: `${covered}/${role.totalTables} business tables covered by runtime privileges`,
        ...(role.uncoveredTables === 0
          ? {}
          : {
              remediation:
                'grant SELECT, INSERT, UPDATE, DELETE and sequence usage to phub_runtime for the uncovered tables',
            }),
      });
    }
  }

  const missing = SECRET_FILES.filter((name) => !facts.secretFiles.includes(name));
  checks.push({
    id: 'secrets-installed',
    status: missing.length === 0 && facts.installedReleaseId ? 'READY' : 'BLOCKER',
    detail:
      missing.length === 0
        ? `installed set releaseId=${facts.installedReleaseId ?? 'missing'}`
        : `missing=${missing.join(',')}`,
    ...(missing.length === 0 && facts.installedReleaseId
      ? {}
      : {
          remediation: 'install the canonical five-file secret set with its .release-identity.json',
        }),
  });
  const badMode = SECRET_FILES.filter((name) => (facts.secretModes[name] ?? 0) !== 0o600);
  checks.push({
    id: 'secrets-mode',
    status: badMode.length === 0 ? 'READY' : 'BLOCKER',
    detail: badMode.length === 0 ? 'all secret files are 0600' : `not 0600: ${badMode.join(',')}`,
    ...(badMode.length === 0 ? {} : { remediation: 'chmod 600 the listed secret files' }),
  });
  checks.push({
    id: 'secrets-candidate',
    status:
      facts.candidate === 'ready' ? 'READY' : facts.candidate === 'absent' ? 'ACTION' : 'BLOCKER',
    detail: facts.candidateDetail,
    ...(facts.candidate === 'ready'
      ? {}
      : {
          remediation:
            'render the candidate secret set from the canonical files and set the FCM delta explicitly',
        }),
  });
  checks.push({
    id: 'fcm-credential',
    status: facts.fcmCredential ? 'READY' : 'ACTION',
    detail: facts.fcmCredential ? 'root-only FCM credential present' : 'FCM credential is missing',
    ...(facts.fcmCredential
      ? {}
      : { remediation: 'install the service-account JSON at the canonical 0600 path' }),
  });
  for (const [id, present] of [
    ['monitor-readback', facts.monitorReadback],
    ['alert-readback', facts.alertReadback],
  ] as const) {
    checks.push({
      id,
      status: present ? 'READY' : 'ACTION',
      detail: present
        ? 'present; recorded evidence'
        : 'missing; beta records monitoring as evidence',
      ...(present
        ? {}
        : {
            remediation: 'export the approved provider readbacks into the observability directory',
          }),
    });
  }
  checks.push({
    id: 'restore-capacity',
    status: facts.capacity.model === 'none' ? 'BLOCKER' : 'READY',
    detail: facts.capacity.detail,
    ...(facts.capacity.model === 'none'
      ? {
          remediation:
            'grow the restore target or archive audit/outbox data before the next backup',
        }
      : {}),
  });

  const blockers = checks.filter((value) => value.status === 'BLOCKER').length;
  const actions = checks.filter((value) => value.status === 'ACTION').length;
  return {
    checks,
    summary: {
      status: blockers === 0 ? 'READY' : 'NOT_READY',
      blockers,
      actions,
      restoreSchema:
        facts.capacity.model === 'none' ? null : restoreSchema(facts.phase, facts.capacity.model),
    },
  };
}

export interface BootstrapOptions {
  readonly root: string;
  readonly envDir: string;
  readonly candidateDir?: string;
  readonly phase: RestorePhase;
  readonly pgContainer: string;
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

function roleFacts(
  deps: PreflightDeps,
  pgContainer: string,
  name: string,
  runtime: boolean,
): RoleFacts | null {
  const rows = sql(
    deps,
    pgContainer,
    `select rolname,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls from pg_roles where rolname='${name}'`,
  )
    .split('\n')
    .filter(Boolean);
  const row = rows.length === 1 ? rows[0] : undefined;
  if (row === undefined) return null;
  const columns = row.split('|');
  const exists = true;
  const databaseCreate =
    Number(
      sql(
        deps,
        pgContainer,
        `select has_database_privilege('${name}', current_database(), 'CREATE')::int`,
      ),
    ) === 1;
  const schemaCreate =
    Number(
      sql(deps, pgContainer, `select has_schema_privilege('${name}', 'public', 'CREATE')::int`),
    ) === 1;
  let uncoveredTables = 0;
  let totalTables = 0;
  if (runtime) {
    totalTables = Number(
      sql(
        deps,
        pgContainer,
        "select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema')",
      ),
    );
    uncoveredTables = Number(
      sql(
        deps,
        pgContainer,
        "select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema') and not has_table_privilege('phub_runtime', format('%I.%I',schemaname,tablename), 'SELECT')",
      ),
    );
  }
  return {
    exists,
    superUser: columns[1] === 't',
    createRole: columns[2] === 't',
    createDatabase: columns[3] === 't',
    replication: columns[4] === 't',
    bypassRls: columns[5] === 't',
    databaseCreate,
    schemaCreate,
    uncoveredTables,
    totalTables,
  };
}

export function probeBootstrap(options: BootstrapOptions, deps: PreflightDeps): BootstrapFacts {
  const names = deps.readdir(options.envDir);
  const secretModes: Record<string, number> = {};
  for (const name of SECRET_FILES)
    secretModes[name] = deps.stat(join(options.envDir, name)).mode & 0o777;
  const identity = JSON.parse(deps.read(join(options.envDir, '.release-identity.json'))) as {
    releaseId?: string;
  };
  let candidate: BootstrapFacts['candidate'] = 'absent';
  let candidateDetail = 'no --candidate-dir provided';
  if (options.candidateDir) {
    try {
      const candidateNames = deps.readdir(options.candidateDir);
      const candidateMissing = SECRET_FILES.filter((name) => !candidateNames.includes(name));
      const api = parseEnv(deps.read(join(options.candidateDir, 'api.env')));
      const worker = parseEnv(deps.read(join(options.candidateDir, 'worker.env')));
      const fcm =
        api.get('FCM_ENABLED') === 'true' &&
        worker.get('FCM_ENABLED') === 'true' &&
        ['FCM_PROJECT_ID', 'FCM_APP_ID', 'FCM_ENVIRONMENT', 'FCM_CREDENTIAL_FILE'].every(
          (key) => api.has(key) && worker.has(key),
        );
      candidate = candidateMissing.length === 0 && fcm ? 'ready' : 'invalid';
      candidateDetail =
        candidateMissing.length === 0
          ? `candidate set present fcm=${fcm}`
          : `missing=${candidateMissing.join(',')}`;
    } catch (error) {
      candidate = 'invalid';
      candidateDetail = (error as Error).message;
    }
  }
  const databaseBytes = Number(
    sql(deps, options.pgContainer, 'select pg_database_size(current_database())'),
  );
  const memory = /^MemAvailable:\s+([0-9]+) kB$/mu.exec(deps.read('/proc/meminfo'))?.[1];
  if (!memory) throw new Error('MemAvailable is missing from /proc/meminfo');
  const stats = deps.statvfs(options.root);
  const capacity = evaluateCapacity(
    databaseBytes,
    Number(memory) * 1024,
    stats.bavail * stats.bsize,
  );
  const fcmPath = '/etc/phub/timeweb-beta-fcm/fcm-service-account.json';
  return {
    runtime: roleFacts(deps, options.pgContainer, 'phub_runtime', true),
    migrator: roleFacts(deps, options.pgContainer, 'phub_migrator', false),
    secretFiles: names,
    secretModes,
    installedReleaseId: identity.releaseId ?? null,
    candidate,
    candidateDetail,
    fcmCredential: deps.exists(fcmPath) && deps.stat(fcmPath).isFile(),
    monitorReadback: deps.exists(join(options.root, 'observability/timeweb-monitor-readback.json')),
    alertReadback: deps.exists(join(options.root, 'observability/alert-test-readback.json')),
    capacity,
    phase: options.phase,
  };
}

function human(plan: BootstrapPlan): string {
  const lines = ['Beta bootstrap plan (read-only)'];
  for (const value of plan.checks) {
    lines.push(`[${value.status}] ${value.id} — ${value.detail}`);
    if (value.remediation) lines.push(`    fix: ${value.remediation}`);
  }
  lines.push(
    `RESULT ${plan.summary.status}: blockers=${plan.summary.blockers} actions=${plan.summary.actions} restoreSchema=${plan.summary.restoreSchema ?? 'none'}`,
  );
  return `${lines.join('\n')}\n`;
}

function main(argv: readonly string[]): number {
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
    if (value === undefined) throw new Error(`Invalid argument ${token}`);
    values.set(token.slice(2), value);
    index += 1;
  }
  const root = resolve(values.get('root') ?? '/opt/phub/timeweb-beta');
  const phase = (values.get('phase') ?? 'post101') as RestorePhase;
  if (!['pre99', 'post101'].includes(phase)) throw new Error('--phase must be pre99 or post101');
  const candidateDir = values.get('candidate-dir');
  const options: BootstrapOptions = {
    root,
    envDir: resolve(values.get('env-dir') ?? '/etc/phub/timeweb-beta'),
    phase,
    pgContainer: values.get('pg-container') ?? 'phub-timeweb-beta-dependencies-postgres-1',
    ...(candidateDir === undefined ? {} : { candidateDir: resolve(candidateDir) }),
  };
  const deps: PreflightDeps = {
    exec: (command, args) =>
      String(
        execFileSync(command, [...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }),
      ).trim(),
    exists: (path) => existsSync(path),
    read: (path) => readFileSync(path, 'utf8'),
    readBytes: (path) => readFileSync(path),
    readdir: (path) => readdirSync(path).sort(),
    stat: (path) => statSync(path),
    statvfs: (path) => statfsSync(path),
  };
  const plan = evaluateBootstrap(probeBootstrap(options, deps));
  process.stdout.write(
    argv.includes('--json') ? `${JSON.stringify(plan, null, 2)}\n` : human(plan),
  );
  return plan.summary.status === 'READY' ? 0 : 1;
}

if (process.argv[1]?.endsWith('plan-timeweb-beta-bootstrap.ts')) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`BOOTSTRAP_PLAN_ERROR ${(error as Error).message}\n`);
    process.exitCode = 2;
  }
}
