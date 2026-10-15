import { createHash } from 'node:crypto';
import { ledger as rows } from './timeweb-api-worker.fixture.js';
import { describe, expect, it } from 'vitest';
import { parseStrictJson } from './strict-json.js';
import {
  API_WORKER_MIGRATION_BRIDGE as b,
  readApiWorkerMigrationCapsule,
  runMigrationAdapter,
  validateMigrationProofBundle,
  type MigrationEffects,
} from './timeweb-api-worker-migration.js';

const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const clone = <T>(v: T): T => structuredClone(v);
const encoded = (v: unknown) => Buffer.from(JSON.stringify(v) + '\n');
function operation() {
  return {
    schema: 'PHUB_TIMEWEB_API_WORKER_MIGRATION_OPERATION_V1',
    target: { hostname: 'lk2.padlhub.su', serverId: 8886471, projectId: 262717 },
    controllerSha: 'a'.repeat(40),
    controllerTree: 'd'.repeat(40),
    controllerSourceCiRunId: '38170498441',
    candidateSha: b.candidateSha,
    candidateTree: b.candidateTree,
    sourceCiRunId: b.sourceCiRunId,
    publicationRunId: b.publicationRunId,
    artifactId: b.artifactId,
    artifactDigest: b.artifactDigest,
    manifestSha256: b.manifestSha256,
    migratorImage: b.migratorImage,
    expectedApi: {
      id: '1'.repeat(64),
      image: `ghcr.io/z6v6e6r/phub-api@${b.apiDigest}`,
      imageId: b.apiDigest,
      releaseId: b.apiRelease,
      revision: b.apiSource,
      restarts: 0,
      startedAt: '2026-10-05T14:35:52.357218294Z',
    },
    expectedWorker: {
      id: '2'.repeat(64),
      image: `ghcr.io/z6v6e6r/phub-worker@${b.workerDigest}`,
      imageId: b.workerDigest,
      releaseId: null,
      revision: b.workerSource,
      restarts: 0,
      startedAt: '2026-09-29T17:04:36.692609075Z',
    },
    expectedSecretSetReleaseId: 'c43e9dc8da3eb19a1684ed28e989aafacdb5d8bf-36629104876-1', // gitleaks:allow public Git/OCI release identity
    expectedSecretSetFiles: Object.fromEntries(
      ['.release-identity.json', 'api.env', 'migrator.env', 'realtime.env', 'worker.env'].map(
        (v) => [v, 'c'.repeat(64)],
      ),
    ),
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
    confirmation:
      'MIGRATE_0096_0097_11954FFD6D7B_FROM_0D6078BE7A50_NO_API_WORKER_SECRET_OR_FCM_CHANGE',
  };
}
const target = { systemIdentifier: '1234567890123456789', databaseName: 'phub' };
function role(kind: string) {
  return {
    schema: 'PHUB_TIMEWEB_MIGRATION_ROLE_READBACK_V1',
    kind,
    wireRoleName: kind === 'runtime' ? 'phub_runtime' : 'phub_migrator',
    currentRoleName: kind === 'runtime' ? 'phub_runtime' : 'phub_migrator',
    sessionRoleName: kind === 'runtime' ? 'phub_runtime' : 'phub_migrator',
    roleOverride: 'none',
    ...target,
    recovery: false,
    readOnly: 'on',
    superuser: false,
    createRole: false,
    createDatabase: false,
    replication: false,
    bypassRls: false,
    uuidExecute: true,
    privilegedMembership: false,
    delegableRoles: 0,
    canCreateDatabaseObjects: false,
    controllableBusinessSchemas: 0,
    controllableBusinessRelations: 0,
    dangerousBusinessRelationPrivileges: 0,
    publicUsage: true,
    publicCreate: kind !== 'runtime',
    profileUsage: true,
    identityUsage: true,
    profileCreate: kind !== 'runtime',
    identityCreate: kind !== 'runtime',
    runtimeRoleName: kind === 'runtime' ? null : 'phub_runtime',
    capabilities:
      kind === 'runtime'
        ? null
        : {
            plpgsqlUsage: true,
            uuidExecute: true,
            globalNonOwnerTableDefaultGrants: 0,
            ledgerOwner: true,
            ledgerSelect: true,
            ledgerInsert: true,
            tenantsReferences: true,
            usersReferences: true,
            sessionsReferences: true,
            sessionsTrigger: true,
            runtimeProfileUsage: true,
            runtimeIdentityUsage: true,
            runtimeCanAssumeMigrator: false,
          },
    defaultAcls:
      kind === 'runtime'
        ? []
        : ['identity', 'profile'].map((schema) => ({
            schema,
            runtimeDmlCount: 4,
            unsafeRuntimeGrants: 0,
            publicGrants: 0,
            unexpectedGrantees: 0,
          })),
  };
}

function fixture() {
  const op = operation(),
    bytes = encoded(op),
    events: string[] = [];
  const pg = {
    id: b.postgresId,
    image: b.postgresImage,
    imageId: 'sha256:' + '3'.repeat(64),
    releaseId: null,
    revision: null,
    restarts: 0,
    startedAt: '2026-08-28T16:49:17.916395698Z',
  };
  const runtime = {
    api: {
      identity: clone(op.expectedApi),
      status: 'running',
      health: 'healthy',
      fingerprint: '4'.repeat(64),
    },
    worker: {
      identity: clone(op.expectedWorker),
      status: 'running',
      health: 'healthy',
      fingerprint: '5'.repeat(64),
    },
    postgres: pg,
    controllerConfigSha256: '6'.repeat(64),
    excluded: [{ identity: pg, status: 'running', health: 'healthy', fingerprint: '7'.repeat(64) }],
  };
  const secrets = {
    releaseId: op.expectedSecretSetReleaseId,
    device: 1,
    inode: 2,
    files: clone(op.expectedSecretSetFiles),
  };
  type Container = { Id: string; State: { Status: string; ExitCode: number } };
  const containers = new Map<string, Container>(),
    kinds = new Map<string, string>();
  let ledger = clone(rows.slice(0, 99)),
    capsule: Buffer | null = null,
    receipt: Record<string, unknown> | null = null;
  let roleProof: Buffer | null = null,
    success: Buffer | null = null,
    lock = false,
    claimed = false;
  let failure = '',
    afterEffect = '',
    clock = Date.now(),
    invalidRole = false,
    foreign = false,
    releaseFailure = false;
  const effect = (name: string) => {
    events.push(name);
    if (failure === name) throw Error('lost ACK');
  };
  const f: MigrationEffects = {
    receiptPath: '/synthetic/migration-receipt.json',
    time: () => clock,
    assertUnused: () => {
      if (capsule || lock || containers.size) throw Error('existing');
    },
    assertSource: () => effect('source'),
    authority: () => effect('authority'),
    snapshot: () => clone(runtime),
    secrets: () => clone(secrets),
    ledger: () => clone(ledger),
    backup: () => ({
      path: `/opt/phub/timeweb-beta/backups/${op.controllerSha}-${op.controllerSourceCiRunId}-1-web/database-backup-receipt.json`,
      sha256: '8'.repeat(64),
    }),
    image: () => `sha256:${'9'.repeat(64)}`,
    target: () => clone(target),
    prepare: (value) => {
      effect('prepare');
      capsule = Buffer.from(value);
    },
    preparation: () => {
      if (!capsule) throw Error('missing');
      return capsule;
    },
    loadPlan: () => effect('loadPlan'),
    claim: () => {
      effect('claim');
      lock = true;
      claimed = true;
    },
    assertOwned: () => {
      if (claimed && !lock && receipt?.status !== 'RECONCILED') throw Error('lock lost');
    },
    writeReceipt: (value) => {
      receipt = clone(value as Record<string, unknown>);
      effect(`journal:${String(receipt.status)}`);
    },
    receipt: () => clone(receipt),
    create: (kind) => {
      effect(`create:${kind}`);
      const id = String(containers.size + 10).padStart(64, '0');
      containers.set(kind, { Id: id, State: { Status: 'created', ExitCode: 0 } });
      kinds.set(id, kind);
      if (afterEffect === `create:${kind}`) throw Error('lost ACK');
      return id;
    },
    start: (id, kind) => {
      effect(`start:${kind}`);
      const row = containers.get(kind);
      if (!row || row.Id !== id) throw Error('foreign');
      row.State.Status = 'exited';
      if (kind === 'migration') ledger = clone(rows);
      if (afterEffect === `start:${kind}`) throw Error('lost ACK');
    },
    wait: (_id, kind) => effect(`wait:${kind}`),
    logs: (id) => {
      const value = role(kinds.get(id) ?? 'runtime');
      if (invalidRole) value.databaseName = 'wrong_db';
      return value;
    },
    lookup: (kind) => {
      if (foreign) throw Error('foreign');
      return clone(containers.get(kind) ?? null);
    },
    writeRoleProof: (value) => {
      effect('roleProof');
      roleProof = Buffer.from(value);
    },
    readRoleProof: () => {
      if (!roleProof) throw Error('missing role');
      return roleProof;
    },
    attestRoleContainers: () => {
      for (const kind of ['runtime', 'migrator'])
        if (containers.get(kind)?.State.Status !== 'exited') throw Error('probe drift');
    },
    attestStoppedProbes: () => {
      for (const kind of ['runtime', 'migrator'])
        if (containers.get(kind)?.State.Status === 'running') throw Error('probe running');
    },
    successProof: () => success,
    writeSuccess: (value) => {
      effect('success');
      success = Buffer.from(value);
    },
    release: () => {
      effect('release');
      if (releaseFailure) {
        releaseFailure = false;
        throw Error('cleanup crash');
      }
      lock = false;
    },
  };
  return {
    op,
    bytes,
    f,
    events,
    runtime,
    secrets,
    containers,
    setFault: (value: string) => {
      failure = value;
    },
    setAfterEffect: (value: string) => {
      afterEffect = value;
    },
    clearFault: () => {
      failure = '';
      afterEffect = '';
    },
    setLedger: (count: number) => {
      ledger = clone(rows.slice(0, count));
    },
    setClock: (value: number) => {
      clock = value;
    },
    invalidRole: () => {
      invalidRole = true;
    },
    foreign: () => {
      foreign = true;
    },
    breakRelease: () => {
      releaseFailure = true;
    },
    lock: () => lock,
    receipt: () => clone(receipt),
    bundle: () => {
      if (!capsule || !roleProof || !success || !receipt) throw Error('incomplete');
      const p = readApiWorkerMigrationCapsule(capsule);
      return {
        preparation: capsule,
        plan: p.planBytes,
        role: roleProof,
        success,
        receipt: encoded(receipt),
      };
    },
  };
}

describe('migration-only actual adapter boundary', () => {
  it('seals preparation before shared ownership, proves roles before DDL and retains locks until explicit reconciliation', async () => {
    const x = fixture();
    expect(await runMigrationAdapter('deploy', x.bytes, x.f)).toMatchObject({ status: 'SUCCESS' });
    expect(x.lock()).toBe(true);
    expect(x.events.indexOf('prepare')).toBeLessThan(x.events.indexOf('claim'));
    expect(x.events.indexOf('roleProof')).toBeLessThan(x.events.indexOf('start:migration'));
    expect(x.events.indexOf('journal:CREATE_INTENT')).toBeLessThan(
      x.events.indexOf('create:migration'),
    );
    expect(x.events.indexOf('journal:START_INTENT')).toBeLessThan(
      x.events.indexOf('start:migration'),
    );
    await runMigrationAdapter('reconcile', x.bytes, x.f);
    expect(x.lock()).toBe(false);
    expect(x.receipt()?.status).toBe('RECONCILED');
    expect(x.events.filter((v) => v === 'start:migration')).toHaveLength(1);
  });
  it('reconciles a capsule orphan before ownership without any container action', async () => {
    const x = fixture();
    x.setFault('claim');
    await expect(runMigrationAdapter('deploy', x.bytes, x.f)).rejects.toThrow();
    x.clearFault();
    await runMigrationAdapter('reconcile', x.bytes, x.f);
    expect(x.receipt()?.reconciledStatus).toBe('ABORTED');
    expect(x.containers.size).toBe(0);
  });
  it('never repeats DDL after a lost start acknowledgement; derives success from exact exited-zero and post-101', async () => {
    const x = fixture();
    x.setAfterEffect('start:migration');
    await expect(runMigrationAdapter('deploy', x.bytes, x.f)).rejects.toThrow('lost ACK');
    expect(x.receipt()?.status).toBe('START_INTENT');
    expect(x.lock()).toBe(true);
    x.clearFault();
    await runMigrationAdapter('reconcile', x.bytes, x.f);
    expect(x.receipt()?.reconciledStatus).toBe('SUCCESS');
    expect(x.events.filter((v) => v === 'start:migration')).toHaveLength(1);
  });
  it('finds a retained never-started main container after lost create ACK and aborts against pre-99', async () => {
    const x = fixture();
    x.setAfterEffect('create:migration');
    await expect(runMigrationAdapter('deploy', x.bytes, x.f)).rejects.toThrow();
    x.clearFault();
    await runMigrationAdapter('reconcile', x.bytes, x.f);
    expect(x.receipt()?.reconciledStatus).toBe('ABORTED');
    expect(x.containers.get('migration')?.State.Status).toBe('created');
    expect(x.events).not.toContain('start:migration');
  });
  it.each(['running', 'missing', 'nonzero', 'partial', 'foreign'])(
    'preserves locks and proof for uncertain %s result',
    async (kind) => {
      const x = fixture();
      x.setAfterEffect('start:migration');
      await expect(runMigrationAdapter('deploy', x.bytes, x.f)).rejects.toThrow();
      x.clearFault();
      const row = x.containers.get('migration');
      if (!row) throw Error();
      if (kind === 'running') row.State.Status = 'running';
      if (kind === 'missing') x.containers.delete('migration');
      if (kind === 'nonzero') row.State.ExitCode = 1;
      if (kind === 'partial') x.setLedger(100);
      if (kind === 'foreign') x.foreign();
      await expect(runMigrationAdapter('reconcile', x.bytes, x.f)).rejects.toThrow();
      expect(x.lock()).toBe(true);
      expect(x.events.filter((v) => v === 'start:migration')).toHaveLength(1);
    },
  );
  it.each(['api', 'worker', 'secret', 'postgres'])(
    'blocks start when %s preimage drifts after create',
    async (kind) => {
      const x = fixture(),
        create = x.f.create.bind(x.f);
      x.f.create = async (...args) => {
        const id = await create(...args);
        if (args[0] === 'migration') {
          if (kind === 'api') x.runtime.api.identity.id = 'f'.repeat(64);
          if (kind === 'worker') x.runtime.worker.identity.restarts = 1;
          if (kind === 'secret') x.secrets.inode++;
          if (kind === 'postgres') x.runtime.excluded[0]!.fingerprint = 'e'.repeat(64);
        }
        return id;
      };
      await expect(runMigrationAdapter('deploy', x.bytes, x.f)).rejects.toThrow('RUNTIME_DRIFT');
      expect(x.events).not.toContain('start:migration');
      expect(x.lock()).toBe(true);
    },
  );
  it('rejects wrong role target before the mutating container exists', async () => {
    const x = fixture();
    x.invalidRole();
    await expect(runMigrationAdapter('deploy', x.bytes, x.f)).rejects.toThrow('ROLE_PROOF_UNKNOWN');
    expect(x.containers.has('migration')).toBe(false);
    expect(x.lock()).toBe(true);
  });
  it('reconciles an expired frozen operation and resumes interrupted terminal lock release', async () => {
    const x = fixture();
    await runMigrationAdapter('deploy', x.bytes, x.f);
    x.setClock(Date.parse(x.op.expiresAt) + 1000);
    x.breakRelease();
    await expect(runMigrationAdapter('reconcile', x.bytes, x.f)).rejects.toThrow('cleanup crash');
    const before = x.receipt();
    await runMigrationAdapter('reconcile', x.bytes, x.f);
    expect(x.receipt()).toEqual(before);
    expect(x.lock()).toBe(false);
  });
  it('uses the real shared proof validator and rejects modified operation, roles, receipt IDs and tuple hashes', async () => {
    const x = fixture();
    await runMigrationAdapter('deploy', x.bytes, x.f);
    await runMigrationAdapter('reconcile', x.bytes, x.f);
    const bundle = x.bundle();
    const expected = {
      controllerSha: x.op.controllerSha,
      controllerTree: x.op.controllerTree,
      controllerSourceCiRunId: x.op.controllerSourceCiRunId,
      candidateReleaseId: `${b.candidateSha}-${b.publicationRunId}-1`,
      migrationPlanSha256: hash(bundle.plan),
      migrationSuccessSha256: hash(bundle.success),
    };
    expect(validateMigrationProofBundle(bundle, expected)).toHaveProperty('plan');
    const mutable = parseStrictJson<Record<string, unknown>>(bundle.receipt);
    expect(() =>
      validateMigrationProofBundle(
        { ...bundle, receipt: encoded({ ...mutable, containerId: 'f'.repeat(64) }) },
        expected,
      ),
    ).toThrow();
    expect(() =>
      validateMigrationProofBundle(bundle, { ...expected, controllerTree: 'f'.repeat(40) }),
    ).toThrow();
    const roleValue = parseStrictJson<Record<string, unknown>>(bundle.role);
    expect(() =>
      validateMigrationProofBundle(
        {
          ...bundle,
          role: encoded({ ...roleValue, target: { ...target, databaseName: 'other' } }),
        },
        expected,
      ),
    ).toThrow();
    expect(() =>
      validateMigrationProofBundle(
        {
          ...bundle,
          preparation: encoded({
            schema: 'PHUB_TIMEWEB_API_WORKER_MIGRATION_CAPSULE_V1',
            operation: encoded({ ...x.op, candidateSha: 'f'.repeat(40) }).toString('base64'),
            plan: bundle.plan.toString('base64'),
          }),
        },
        expected,
      ),
    ).toThrow();
  });
});

it('rechecks current cluster identity before immutable success', async () => {
  const x = fixture(),
    start = x.f.start.bind(x.f);
  x.f.start = async (...args) => {
    await start(...args);
    if (args[1] === 'migration') x.f.target = () => ({ ...target, systemIdentifier: '987654321' });
  };
  await expect(runMigrationAdapter('deploy', x.bytes, x.f)).rejects.toThrow('ROLE_TARGET_DRIFT');
  expect(x.lock()).toBe(true);
});
it('checks expiry again after role attestation immediately before DDL', async () => {
  const x = fixture();
  x.f.attestRoleContainers = () => {
    x.setClock(Date.parse(x.op.expiresAt) + 1);
  };
  await expect(runMigrationAdapter('deploy', x.bytes, x.f)).rejects.toThrow('EXPIRED');
  expect(x.events).not.toContain('start:migration');
});
