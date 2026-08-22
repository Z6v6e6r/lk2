import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_VERSION,
  advanceCommunitiesStagingRoleSplitMarkerCeremonyState,
  assertCommunitiesRoleSplitAcceptancePass,
  assertCommunitiesRoleSplitInputC,
  canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest,
  communitiesStagingRoleSplitLedgerSha256,
  communitiesStagingRoleSplitRestoreMarkerPayloadSha256,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  communitiesRoleSplitInputCArtifactSha256,
  communitiesRoleSplitInputCArtifactText,
  createCommunitiesStagingRoleSplitMarkerCeremonyCandidate,
  type CommunitiesRoleSplitAcceptanceEnvelope,
  type CommunitiesRoleSplitExpectedPins,
  type CommunitiesRoleSplitGrantDecision,
  type CommunitiesRoleSplitGrantObjectKind,
  type CommunitiesRoleSplitInputC,
  type CommunitiesRoleSplitObjectKind,
  type CommunitiesStagingRoleSplitLedgerEntry,
  type CommunitiesStagingRoleSplitRestoreMarkerEvidence,
  type CommunitiesStagingRoleSplitRestoreMarkerPayload,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
} from '@phub/database';
import { Client, type QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CommunitiesStagingRoleSplitCloneOnlyConnectionFactory,
  CommunitiesStagingRoleSplitPgMarkerWriter,
} from './communities-staging-role-split-canonical-pg-collaborators.js';
import {
  CommunitiesStagingRoleSplitMarkerCeremonyPgHost,
  type CommunitiesStagingRoleSplitMarkerCeremonyPgClient,
  type CommunitiesStagingRoleSplitMarkerCeremonyPgHostConfig,
} from './communities-staging-role-split-marker-ceremony-pg-host.js';
import {
  CommunitiesStagingRoleSplitMarkerCeremonyError,
  runCommunitiesStagingRoleSplitMarkerCeremony,
  type CommunitiesStagingRoleSplitMarkerCeremonyArtifacts,
  type CommunitiesStagingRoleSplitMarkerCeremonyHost,
  type CommunitiesStagingRoleSplitMarkerCeremonyLease,
} from './communities-staging-role-split-marker-ceremony.js';
import {
  COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CONFIRMATION,
  COMMUNITIES_STAGING_ROLE_SPLIT_MAPPING_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_ROLE_CATEGORIES,
  produceCommunitiesStagingRoleSplitInventory,
  type CommunitiesStagingRoleSplitInventoryClientFactory,
} from './communities-staging-role-split-inventory.js';
import { verifyCommunitiesStagingRoleSplitInventoryArtifact } from './communities-staging-role-split-inventory-artifact.js';

const ADMIN_DATABASE = 'phub_role_split_admin_verify';
const DISPOSABLE_CONTAINER_LABEL = 'communities-role-split-pg16-verification';
const SOURCE_DATABASE = 'phub_source_verify';
const CLONE_DATABASE = 'phub_restore_901_1';
const OWNER_ROLE = 'phub_owner_verify';
const READER_ROLE = 'phub_reader_verify';
const MARKER_WRITER_ROLE = 'phub_marker_owner_verify';
const ROLE_NAMES = {
  RESTORE_OWNER: OWNER_ROLE,
  RESTORE_EXECUTOR: 'phub_executor_verify',
  SHARED_OWNER: 'phub_shared_owner_verify',
  FUTURE_MIGRATOR: 'phub_migrator_verify',
  FUTURE_RUNTIME: 'phub_runtime_verify',
  INVENTORY_READER: READER_ROLE,
} as const;
const ledger: readonly CommunitiesStagingRoleSplitLedgerEntry[] = [
  { filename: '0001_initial.sql', checksum: 'a'.repeat(64) },
  { filename: '0002_acl_fixture.sql', checksum: 'b'.repeat(64) },
];

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function parseDisposableContainerId(value: string | undefined): string {
  if (value === undefined || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error('PG16_VERIFY_CONTAINER_ID_INVALID');
  return value;
}

function parseDisposableContainerName(value: string | undefined): string {
  if (value === undefined || !/^phub-communities-pg16-verify-[1-9][0-9]*$/u.test(value))
    throw new Error('PG16_VERIFY_CONTAINER_NAME_INVALID');
  return value;
}

type DisposableDockerCommandOptions = {
  readonly stdinFd?: number;
  readonly stdoutFd?: number;
  readonly maximumStdoutBytes?: number;
};

async function runDockerCliCommand(
  arguments_: readonly string[],
  options: DisposableDockerCommandOptions = {},
): Promise<Buffer> {
  if (arguments_.length === 0) throw new Error('PG16_VERIFY_DOCKER_COMMAND_INVALID');
  const maximumStdoutBytes = options.maximumStdoutBytes ?? 1024 * 1024;
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn('docker', [...arguments_], {
      stdio: [options.stdinFd ?? 'ignore', options.stdoutFd ?? 'pipe', 'pipe'],
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maximumStdoutBytes) {
        outputExceeded = true;
        child.kill('SIGKILL');
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) {
        outputExceeded = true;
        child.kill('SIGKILL');
      }
    });
    child.once('error', () => reject(new Error('PG16_VERIFY_DOCKER_COMMAND_FAILED')));
    child.once('close', (code, signal) => {
      if (outputExceeded) reject(new Error('PG16_VERIFY_DOCKER_COMMAND_OUTPUT_EXCEEDED'));
      else if (code !== 0 || signal !== null)
        reject(new Error('PG16_VERIFY_DOCKER_COMMAND_FAILED'));
      else resolve(Buffer.concat(stdout));
    });
  });
}

async function runDisposableDockerCommand(
  containerId: string,
  command: readonly string[],
  options: DisposableDockerCommandOptions = {},
): Promise<Buffer> {
  return await runDockerCliCommand(
    ['exec', ...(options.stdinFd === undefined ? [] : ['--interactive']), containerId, ...command],
    options,
  );
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseDisposablePg16Url(value: string): URL {
  const parsed = new URL(value);
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:')
    throw new Error('PG16_VERIFY_URL_PROTOCOL_INVALID');
  if (parsed.search || parsed.hash) throw new Error('PG16_VERIFY_URL_OPTIONS_FORBIDDEN');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))
    throw new Error('PG16_VERIFY_URL_NOT_LOOPBACK');
  if (!parsed.username) throw new Error('PG16_VERIFY_URL_ROLE_REQUIRED');
  if (decodeURIComponent(parsed.pathname.slice(1)) !== ADMIN_DATABASE)
    throw new Error('PG16_VERIFY_URL_DATABASE_NOT_DISPOSABLE');
  return parsed;
}

function databaseUrl(base: URL, database: string): string {
  const result = new URL(base);
  result.pathname = `/${database}`;
  return result.toString();
}

function roleDatabaseUrl(base: URL, role: string, database: string): string {
  const result = new URL(databaseUrl(base, database));
  result.username = role;
  return result.toString();
}

async function normalizePgTrgmExtensionSecurity(client: Client): Promise<void> {
  const functions = await client.query<{ identity: string }>(
    `SELECT routine.oid::regprocedure::text AS identity
       FROM pg_catalog.pg_proc routine
       JOIN pg_catalog.pg_depend dependency
         ON dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
        AND dependency.objid = routine.oid
        AND dependency.objsubid = 0
        AND dependency.deptype = 'e'
       JOIN pg_catalog.pg_extension extension
         ON extension.oid = dependency.refobjid
        AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
      WHERE extension.extname = 'pg_trgm'`,
  );
  for (const routine of functions.rows) {
    await client.query(
      `ALTER FUNCTION ${routine.identity} OWNER TO ${quoteIdentifier(OWNER_ROLE)}`,
    );
    await client.query(`REVOKE ALL ON FUNCTION ${routine.identity} FROM PUBLIC`);
  }
  const types = await client.query<{ schema_name: string; type_name: string }>(
    `SELECT namespace.nspname AS schema_name, object_type.typname AS type_name
       FROM pg_catalog.pg_type object_type
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = object_type.typnamespace
       JOIN pg_catalog.pg_depend dependency
         ON dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
        AND dependency.objid = object_type.oid
        AND dependency.objsubid = 0
        AND dependency.deptype = 'e'
       JOIN pg_catalog.pg_extension extension
         ON extension.oid = dependency.refobjid
        AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
      WHERE extension.extname = 'pg_trgm'`,
  );
  for (const type of types.rows) {
    await client.query(
      `ALTER TYPE ${quoteIdentifier(type.schema_name)}.${quoteIdentifier(type.type_name)} OWNER TO ${quoteIdentifier(OWNER_ROLE)}`,
    );
    await client.query(
      `REVOKE ALL ON TYPE ${quoteIdentifier(type.schema_name)}.${quoteIdentifier(type.type_name)} FROM PUBLIC`,
    );
  }
  const operators = await client.query<{ identity: string }>(
    `SELECT operator.oid::regoperator::text AS identity
       FROM pg_catalog.pg_operator operator
       JOIN pg_catalog.pg_depend dependency
         ON dependency.classid = 'pg_catalog.pg_operator'::pg_catalog.regclass
        AND dependency.objid = operator.oid
        AND dependency.objsubid = 0
        AND dependency.deptype = 'e'
       JOIN pg_catalog.pg_extension extension
         ON extension.oid = dependency.refobjid
        AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
      WHERE extension.extname = 'pg_trgm'`,
  );
  for (const operator of operators.rows)
    await client.query(
      `ALTER OPERATOR ${operator.identity} OWNER TO ${quoteIdentifier(OWNER_ROLE)}`,
    );
  const operatorClasses = await client.query<{
    schema_name: string;
    class_name: string;
    access_method: string;
  }>(
    `SELECT namespace.nspname AS schema_name, operator_class.opcname AS class_name, access_method.amname AS access_method
       FROM pg_catalog.pg_opclass operator_class
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = operator_class.opcnamespace
       JOIN pg_catalog.pg_am access_method ON access_method.oid = operator_class.opcmethod
       JOIN pg_catalog.pg_depend dependency
         ON dependency.classid = 'pg_catalog.pg_opclass'::pg_catalog.regclass
        AND dependency.objid = operator_class.oid
        AND dependency.objsubid = 0
        AND dependency.deptype = 'e'
       JOIN pg_catalog.pg_extension extension
         ON extension.oid = dependency.refobjid
        AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
      WHERE extension.extname = 'pg_trgm'`,
  );
  for (const operatorClass of operatorClasses.rows)
    await client.query(
      `ALTER OPERATOR CLASS ${quoteIdentifier(operatorClass.schema_name)}.${quoteIdentifier(operatorClass.class_name)} USING ${quoteIdentifier(operatorClass.access_method)} OWNER TO ${quoteIdentifier(OWNER_ROLE)}`,
    );
  const operatorFamilies = await client.query<{
    schema_name: string;
    family_name: string;
    access_method: string;
  }>(
    `SELECT namespace.nspname AS schema_name, operator_family.opfname AS family_name, access_method.amname AS access_method
       FROM pg_catalog.pg_opfamily operator_family
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = operator_family.opfnamespace
       JOIN pg_catalog.pg_am access_method ON access_method.oid = operator_family.opfmethod
       JOIN pg_catalog.pg_depend dependency
         ON dependency.classid = 'pg_catalog.pg_opfamily'::pg_catalog.regclass
        AND dependency.objid = operator_family.oid
        AND dependency.objsubid = 0
        AND dependency.deptype = 'e'
       JOIN pg_catalog.pg_extension extension
         ON extension.oid = dependency.refobjid
        AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
      WHERE extension.extname = 'pg_trgm'`,
  );
  for (const operatorFamily of operatorFamilies.rows)
    await client.query(
      `ALTER OPERATOR FAMILY ${quoteIdentifier(operatorFamily.schema_name)}.${quoteIdentifier(operatorFamily.family_name)} USING ${quoteIdentifier(operatorFamily.access_method)} OWNER TO ${quoteIdentifier(OWNER_ROLE)}`,
    );
}

function markerEvidenceText(
  payload: CommunitiesStagingRoleSplitRestoreMarkerPayload,
  marker: string,
): string {
  return `${[
    'schemaVersion=communities-role-split-clone-marker-evidence-v2',
    'status=MARKED',
    `requestSha256=${payload.requestSha256}`,
    `creationReceiptSha256=${payload.creationReceiptSha256}`,
    `markerPayloadSha256=${communitiesStagingRoleSplitRestoreMarkerPayloadSha256(payload)}`,
    `markerValueSha256=${sha(marker)}`,
    `backupSha256=${payload.backupSha256}`,
    `sourceLedgerSha256=${payload.sourceLedgerSha256}`,
    `sourceLedgerCount=${payload.sourceLedgerCount}`,
    `cloneDatabaseOid=${payload.cloneDatabaseOid}`,
    `cloneBindingSha256=${sha(`${payload.restoreDatabase}\0${payload.cloneDatabaseOid}`)}`,
    `sourceBindingSha256=${sha(`${payload.sourceDatabase}\0${payload.sourceDatabaseOid}\0${payload.systemIdentifier}`)}`,
    `restoreRunId=${payload.restoreRunId}`,
    `restoreRunAttempt=${payload.restoreRunAttempt}`,
    `restoreHelperSha256=${payload.restoreHelperSha256}`,
    `markerWriterSha256=${payload.markerWriterSha256}`,
    'binding.request=true',
    'binding.backup=true',
    'binding.archiveOwnershipAcl=true',
    'binding.sourceStable=true',
    'binding.restoredLedger=true',
    'binding.cloneIdentity=true',
    'binding.markerReadback=true',
    'authorizes.roleCreation=false',
    'authorizes.roleSplit=false',
    'authorizes.sharedDatabaseMutation=false',
    'authorizes.migration=false',
    'authorizes.deploy=false',
    'authorizes.import=false',
    'authorizes.activation=false',
  ].join('\n')}\n`;
}

const objectCategoryByKind = {
  database: 'databaseAcl',
  schema: 'schemas',
  relation: 'relations',
  sequence: 'sequences',
  function: 'functions',
  type: 'types',
  extension: 'extensions',
} as const;

function acceptanceEnvelope(
  snapshot: CommunitiesRoleSplitInputC,
): CommunitiesRoleSplitAcceptanceEnvelope {
  const ownershipPlan = (
    Object.keys(objectCategoryByKind) as CommunitiesRoleSplitObjectKind[]
  ).flatMap((objectKind) =>
    snapshot.normalized[objectCategoryByKind[objectKind]]
      .filter((record) => record.fieldKind === 'OWNER')
      .map((owner) => {
        if (
          !owner.semantic ||
          !('ownerCategory' in owner.semantic) ||
          owner.valueSha256 === null ||
          owner.provenanceSha256 === null
        )
          throw new Error('PG16_VERIFY_OWNER_SEMANTIC_MISSING');
        return {
          objectKind,
          objectKeySha256: owner.objectKeySha256,
          ownerFieldKeySha256: owner.fieldKeySha256,
          beforeOwnerCategory: owner.semantic.ownerCategory,
          targetOwnerCategory: 'PRESERVE_CURRENT' as const,
          beforeOwnerValueSha256: owner.valueSha256,
          afterOwnerValueSha256: owner.valueSha256,
          ownerEvidenceSha256: owner.provenanceSha256,
        };
      }),
  );
  const grantPlan: CommunitiesRoleSplitGrantDecision[] = (
    Object.keys(objectCategoryByKind).filter(
      (kind) => kind !== 'extension',
    ) as CommunitiesRoleSplitGrantObjectKind[]
  ).flatMap((objectKind) =>
    snapshot.normalized[objectCategoryByKind[objectKind]]
      .filter(
        (record) => record.fieldKind === 'ACL_EXPLICIT' || record.fieldKind === 'ACL_EFFECTIVE',
      )
      .map((record) => {
        if (record.valueSha256 === null || record.provenanceSha256 === null)
          throw new Error('PG16_VERIFY_ACL_SEMANTIC_MISSING');
        return {
          objectKind,
          objectKeySha256: record.objectKeySha256,
          fieldKeySha256: record.fieldKeySha256,
          action: 'PRESERVE' as const,
          beforeStateSha256: record.valueSha256,
          targetStateSha256: record.valueSha256,
          granteeCategory: 'FUTURE_RUNTIME' as const,
          granteeEvidenceSha256: null,
          grantorCategory: null,
          grantorEvidenceSha256: null,
          occurrenceSha256: null,
          privileges: [],
          grantOption: false as const,
          evidenceSha256: record.provenanceSha256,
        };
      }),
  );
  return {
    contractVersion: COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_VERSION,
    observedBefore: snapshot,
    observedAfter: snapshot,
    ownershipPlan,
    grantPlan,
    comparison: {
      sortVersion: snapshot.sortVersion,
      beforeManifestSha256: snapshot.manifestSha256,
      afterManifestSha256: snapshot.manifestSha256,
      changedCount: 0,
      addedCount: 0,
      removedCount: 0,
      forbiddenTransitionCodes: [],
    },
    decision: {
      status: 'PASS',
      blockerCodes: [],
      authorizesRoleCreation: false,
      authorizesRoleAlteration: false,
      authorizesAclMutation: false,
      authorizesMigration: false,
      authorizesDeploy: false,
      authorizesRuntimeActivation: false,
    },
  };
}

function acceptancePins(snapshot: CommunitiesRoleSplitInputC): CommunitiesRoleSplitExpectedPins {
  return {
    beforeArtifactSha256: communitiesRoleSplitInputCArtifactSha256(snapshot),
    afterArtifactSha256: communitiesRoleSplitInputCArtifactSha256(snapshot),
    beforeManifestSha256: snapshot.manifestSha256,
    afterManifestSha256: snapshot.manifestSha256,
    expectedMappingDigest: snapshot.provenance.mappingDigest,
    markerDigest: snapshot.provenance.markerDigest,
    markerEvidenceDigest: snapshot.provenance.markerEvidenceDigest,
    requestDigest: snapshot.provenance.requestDigest,
    creationReceiptSha256: snapshot.provenance.creationReceiptSha256,
    objectManifestDigest: snapshot.provenance.objectManifestDigest,
    ledgerDigest: snapshot.provenance.ledgerDigest,
  };
}

class LazyCountingPgClient implements CommunitiesStagingRoleSplitMarkerCeremonyPgClient {
  private client: Client | null = null;
  queryCount = 0;

  constructor(private readonly connectionString: string) {}

  async query<T extends object = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly T[] }> {
    this.queryCount += 1;
    if (this.client === null) {
      this.client = new Client({
        connectionString: this.connectionString,
        connectionTimeoutMillis: 5_000,
        query_timeout: 5_000,
        statement_timeout: 5_000,
      });
      await this.client.connect();
    }
    const result = await this.client.query<T>(sql, values ? [...values] : undefined);
    return { rows: result.rows };
  }

  async end(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client !== null) await client.end();
  }
}

type FailureMatrixHostOverrides = Partial<
  Pick<
    CommunitiesStagingRoleSplitMarkerCeremonyHost,
    'restoreClone' | 'verifyBindings' | 'writeMarker' | 'publishEvidence' | 'dropExactClone'
  >
>;

function withFailureMatrixOverrides(
  delegate: CommunitiesStagingRoleSplitMarkerCeremonyHost,
  overrides: FailureMatrixHostOverrides,
): CommunitiesStagingRoleSplitMarkerCeremonyHost {
  return {
    acquireLease: delegate.acquireLease.bind(delegate),
    releaseLease: delegate.releaseLease.bind(delegate),
    loadState: delegate.loadState.bind(delegate),
    createCandidate: delegate.createCandidate.bind(delegate),
    advanceState: delegate.advanceState.bind(delegate),
    saveVerified: delegate.saveVerified.bind(delegate),
    loadVerifiedArtifacts: delegate.loadVerifiedArtifacts.bind(delegate),
    observeClone: delegate.observeClone.bind(delegate),
    observeMarkerPresence: delegate.observeMarkerPresence.bind(delegate),
    observeMarker: delegate.observeMarker.bind(delegate),
    observeEvidence: delegate.observeEvidence.bind(delegate),
    createClone: delegate.createClone.bind(delegate),
    restoreClone: overrides.restoreClone ?? delegate.restoreClone.bind(delegate),
    verifyBindings: overrides.verifyBindings ?? delegate.verifyBindings.bind(delegate),
    writeMarker: overrides.writeMarker ?? delegate.writeMarker.bind(delegate),
    publishEvidence: overrides.publishEvidence ?? delegate.publishEvidence.bind(delegate),
    dropExactClone: overrides.dropExactClone ?? delegate.dropExactClone.bind(delegate),
    clearState: delegate.clearState.bind(delegate),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number')
    return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('PG16_VERIFY_CANONICAL_VALUE_INVALID');
}

async function writeExactMarkerInCatalogTransaction(
  admin: Client,
  request: CommunitiesStagingRoleSplitRestoreMarkerRequest,
  cloneDatabaseOid: string,
  marker: string,
): Promise<void> {
  await admin.query('BEGIN');
  try {
    await admin.query('LOCK TABLE pg_catalog.pg_database IN ACCESS EXCLUSIVE MODE');
    const binding = await admin.query<{ oid: string; owner: string; owner_oid: string }>(
      'SELECT database.oid::text AS oid, owner.rolname AS owner, database.datdba::text AS owner_oid FROM pg_catalog.pg_database database JOIN pg_catalog.pg_roles owner ON owner.oid = database.datdba WHERE database.datname = $1',
      [request.restoreDatabase],
    );
    expect(binding.rows).toEqual([
      {
        oid: cloneDatabaseOid,
        owner: request.expectedCloneDatabaseOwner,
        owner_oid: request.expectedCloneDatabaseOwnerOid,
      },
    ]);
    await admin.query(
      `COMMENT ON DATABASE ${quoteIdentifier(request.restoreDatabase)} IS ${quoteLiteral(marker)}`,
    );
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

interface Pg16Fixture {
  readonly admin: Client;
  readonly adminUrl: URL;
  readonly adminHost: LazyCountingPgClient;
  readonly sourceHost: LazyCountingPgClient;
  readonly cloneHost: LazyCountingPgClient;
  readonly directory: string;
  readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
  readonly requestSha256: string;
  readonly roleMappingText: string;
  readonly config: CommunitiesStagingRoleSplitMarkerCeremonyPgHostConfig;
}

const configuredUrl = process.env.PHUB_COMMUNITIES_MARKER_PG16_VERIFY_URL;
const parsedConfiguredUrl =
  configuredUrl === undefined ? null : parseDisposablePg16Url(configuredUrl);
const configuredContainerId =
  configuredUrl === undefined
    ? null
    : parseDisposableContainerId(process.env.PHUB_COMMUNITIES_MARKER_PG16_VERIFY_CONTAINER_ID);
const configuredContainerName =
  configuredUrl === undefined
    ? null
    : parseDisposableContainerName(process.env.PHUB_COMMUNITIES_MARKER_PG16_VERIFY_CONTAINER_NAME);

describe('PG16 marker host integration guard', () => {
  it('accepts only the exact loopback disposable admin database', () => {
    expect(() =>
      parseDisposablePg16Url('postgresql://postgres@127.0.0.1:55443/phub_role_split_admin_verify'),
    ).not.toThrow();
    expect(() =>
      parseDisposablePg16Url('postgresql://postgres@database.example/phub_role_split_admin_verify'),
    ).toThrow('PG16_VERIFY_URL_NOT_LOOPBACK');
    expect(() => parseDisposablePg16Url('postgresql://postgres@127.0.0.1:55443/postgres')).toThrow(
      'PG16_VERIFY_URL_DATABASE_NOT_DISPOSABLE',
    );
    expect(() =>
      parseDisposablePg16Url(
        'postgresql://postgres@127.0.0.1:55443/phub_role_split_admin_verify?host=elsewhere',
      ),
    ).toThrow('PG16_VERIFY_URL_OPTIONS_FORBIDDEN');
  });

  it('accepts only a full lowercase disposable container id', () => {
    expect(parseDisposableContainerId('a'.repeat(64))).toBe('a'.repeat(64));
    expect(() => parseDisposableContainerId(undefined)).toThrow('PG16_VERIFY_CONTAINER_ID_INVALID');
    expect(() => parseDisposableContainerId('a'.repeat(63))).toThrow(
      'PG16_VERIFY_CONTAINER_ID_INVALID',
    );
    expect(() => parseDisposableContainerId('A'.repeat(64))).toThrow(
      'PG16_VERIFY_CONTAINER_ID_INVALID',
    );
  });

  it('accepts only the dedicated disposable container name pattern', () => {
    expect(parseDisposableContainerName('phub-communities-pg16-verify-123')).toBe(
      'phub-communities-pg16-verify-123',
    );
    expect(() => parseDisposableContainerName(undefined)).toThrow(
      'PG16_VERIFY_CONTAINER_NAME_INVALID',
    );
    expect(() => parseDisposableContainerName('postgres')).toThrow(
      'PG16_VERIFY_CONTAINER_NAME_INVALID',
    );
  });
});

describe
  .skipIf(parsedConfiguredUrl === null)
  .sequential('PG16 marker host disposable-clone verification', () => {
    let fixture: Pg16Fixture;
    let verifiedArtifacts: Awaited<
      ReturnType<CommunitiesStagingRoleSplitMarkerCeremonyPgHost['verifyBindings']>
    >;
    const cleanupClients: { end(): Promise<void> }[] = [];
    let cleanupDirectory: string | null = null;

    async function createFailureScenario(runId: string): Promise<{
      readonly host: CommunitiesStagingRoleSplitMarkerCeremonyPgHost;
      readonly cloneHost: LazyCountingPgClient;
      readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
      readonly requestSha256: string;
      readonly stateDirectory: string;
    }> {
      const restoreRunAttempt = '1';
      const restoreDatabase = `phub_restore_${runId}_${restoreRunAttempt}`;
      const stateDirectory = join(fixture.directory, `failure-${runId}-${restoreRunAttempt}`);
      await mkdir(stateDirectory, { mode: 0o700 });
      const request = {
        ...fixture.request,
        restoreDatabase,
        restoreRunId: runId,
        restoreRunAttempt,
      } satisfies CommunitiesStagingRoleSplitRestoreMarkerRequest;
      const cloneHost = new LazyCountingPgClient(databaseUrl(fixture.adminUrl, restoreDatabase));
      cleanupClients.push(cloneHost);
      const host = new CommunitiesStagingRoleSplitMarkerCeremonyPgHost({
        ...fixture.config,
        stateDirectory,
        request,
        clone: cloneHost,
      });
      return {
        host,
        cloneHost,
        request,
        requestSha256: communitiesStagingRoleSplitRestoreMarkerRequestSha256(request),
        stateDirectory,
      };
    }

    beforeAll(async () => {
      const adminUrl = parsedConfiguredUrl as URL;
      const containerId = configuredContainerId as string;
      const containerName = configuredContainerName as string;
      const observedContainer = (
        await runDockerCliCommand(
          [
            'inspect',
            '--format',
            '{{.Id}}|{{.Name}}|{{ index .Config.Labels "com.padlhub.disposable" }}',
            containerId,
          ],
          { maximumStdoutBytes: 1024 },
        )
      )
        .toString('utf8')
        .trim();
      expect(observedContainer).toBe(
        `${containerId}|/${containerName}|${DISPOSABLE_CONTAINER_LABEL}`,
      );
      const admin = new Client({
        connectionString: adminUrl.toString(),
        connectionTimeoutMillis: 5_000,
        query_timeout: 5_000,
        statement_timeout: 5_000,
      });
      cleanupClients.push(admin);
      await admin.connect();
      const server = await admin.query<{
        current_database: string;
        major: string;
        system_identifier: string;
      }>(
        "SELECT current_database(), split_part(current_setting('server_version'), '.', 1) AS major, system_identifier::text AS system_identifier FROM pg_catalog.pg_control_system()",
      );
      expect(server.rows).toEqual([
        expect.objectContaining({ current_database: ADMIN_DATABASE, major: '16' }),
      ]);
      const roleNames = Object.values(ROLE_NAMES);
      const reservedRoleNames = [...roleNames, MARKER_WRITER_ROLE];
      const existing = await admin.query<{ database_count: string; role_count: string }>(
        'SELECT (SELECT count(*)::text FROM pg_catalog.pg_database WHERE datname = ANY($1::text[])) AS database_count, (SELECT count(*)::text FROM pg_catalog.pg_roles WHERE rolname = ANY($2::text[])) AS role_count',
        [[SOURCE_DATABASE, CLONE_DATABASE], reservedRoleNames],
      );
      expect(existing.rows).toEqual([{ database_count: '0', role_count: '0' }]);

      for (const role of roleNames)
        await admin.query(
          `CREATE ROLE ${quoteIdentifier(role)} ${
            role === READER_ROLE
              ? `LOGIN PASSWORD ${quoteLiteral(decodeURIComponent(adminUrl.password))}`
              : 'NOLOGIN'
          } NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
        );
      await admin.query(
        `CREATE ROLE ${quoteIdentifier(MARKER_WRITER_ROLE)} LOGIN PASSWORD ${quoteLiteral(
          decodeURIComponent(adminUrl.password),
        )} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
      );
      await admin.query(
        `CREATE DATABASE ${quoteIdentifier(SOURCE_DATABASE)} OWNER ${quoteIdentifier(OWNER_ROLE)}`,
      );
      await admin.query(`SET ROLE ${quoteIdentifier(OWNER_ROLE)}`);
      await admin.query(`REVOKE ALL ON DATABASE ${quoteIdentifier(SOURCE_DATABASE)} FROM PUBLIC`);
      await admin.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(SOURCE_DATABASE)} TO ${quoteIdentifier(READER_ROLE)}`,
      );
      await admin.query('RESET ROLE');

      const sourceSetup = new Client({
        connectionString: databaseUrl(adminUrl, SOURCE_DATABASE),
        connectionTimeoutMillis: 5_000,
        query_timeout: 5_000,
        statement_timeout: 5_000,
      });
      cleanupClients.push(sourceSetup);
      await sourceSetup.connect();
      await sourceSetup.query(`SET ROLE ${quoteIdentifier(OWNER_ROLE)}`);
      await sourceSetup.query(`ALTER SCHEMA public OWNER TO ${quoteIdentifier(OWNER_ROLE)}`);
      await sourceSetup.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      await sourceSetup.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(READER_ROLE)}`);
      await sourceSetup.query(
        'CREATE TABLE public.schema_migrations (filename text PRIMARY KEY, checksum text NOT NULL)',
      );
      for (const entry of ledger)
        await sourceSetup.query(
          'INSERT INTO public.schema_migrations (filename, checksum) VALUES ($1, $2)',
          [entry.filename, entry.checksum],
        );
      await sourceSetup.query('CREATE SCHEMA communities');
      await sourceSetup.query(
        'CREATE TABLE communities."Quoted Table" (tenant_id uuid NOT NULL, visible_text text NOT NULL)',
      );
      await sourceSetup.query('ALTER TABLE communities."Quoted Table" ENABLE ROW LEVEL SECURITY');
      await sourceSetup.query('ALTER TABLE communities."Quoted Table" FORCE ROW LEVEL SECURITY');
      await sourceSetup.query(
        'CREATE POLICY "Tenant Policy" ON communities."Quoted Table" USING (tenant_id = nullif(current_setting(\'app.tenant_id\', true), \'\')::uuid)',
      );
      await sourceSetup.query('CREATE SEQUENCE communities."Quoted Sequence"');
      await sourceSetup.query("CREATE TYPE communities.\"Quoted Enum\" AS ENUM ('one', 'two')");
      await sourceSetup.query(
        'CREATE TYPE communities."Quoted Composite" AS (visible_text text, enabled boolean)',
      );
      await sourceSetup.query(
        'CREATE FUNCTION public.role_split_overload(value integer) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT value $$',
      );
      await sourceSetup.query(
        'CREATE FUNCTION public.role_split_overload(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT value $$',
      );
      await sourceSetup.query(
        'CREATE FUNCTION public.empty_acl_fixture() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 1 $$',
      );
      await sourceSetup.query(
        `REVOKE ALL ON FUNCTION public.empty_acl_fixture() FROM PUBLIC, ${quoteIdentifier(OWNER_ROLE)}`,
      );
      await sourceSetup.query(
        `GRANT USAGE ON SCHEMA communities TO ${quoteIdentifier(READER_ROLE)}`,
      );
      await sourceSetup.query(
        `GRANT SELECT ON public.schema_migrations, communities."Quoted Table" TO ${quoteIdentifier(READER_ROLE)}`,
      );
      await sourceSetup.query('CREATE EXTENSION pg_trgm WITH SCHEMA public');
      await sourceSetup.query('RESET ROLE');
      const functions = await sourceSetup.query<{ identity: string }>(
        `SELECT routine.oid::regprocedure::text AS identity
           FROM pg_catalog.pg_proc routine
           JOIN pg_catalog.pg_namespace namespace ON namespace.oid = routine.pronamespace
          WHERE namespace.nspname IN ('public', 'communities')`,
      );
      for (const routine of functions.rows) {
        await sourceSetup.query(
          `ALTER FUNCTION ${routine.identity} OWNER TO ${quoteIdentifier(OWNER_ROLE)}`,
        );
        await sourceSetup.query(`REVOKE ALL ON FUNCTION ${routine.identity} FROM PUBLIC`);
      }
      await sourceSetup.query(
        `REVOKE ALL ON FUNCTION public.empty_acl_fixture() FROM ${quoteIdentifier(OWNER_ROLE)}`,
      );
      const types = await sourceSetup.query<{ schema_name: string; type_name: string }>(
        `SELECT namespace.nspname AS schema_name, object_type.typname AS type_name
           FROM pg_catalog.pg_type object_type
           JOIN pg_catalog.pg_namespace namespace ON namespace.oid = object_type.typnamespace
          WHERE namespace.nspname IN ('public', 'communities')
            AND (object_type.typrelid = 0 OR EXISTS (
              SELECT 1 FROM pg_catalog.pg_class relation
               WHERE relation.oid = object_type.typrelid AND relation.relkind = 'c'
            ))
            AND object_type.typelem = 0`,
      );
      for (const type of types.rows) {
        await sourceSetup.query(
          `ALTER TYPE ${quoteIdentifier(type.schema_name)}.${quoteIdentifier(type.type_name)} OWNER TO ${quoteIdentifier(OWNER_ROLE)}`,
        );
        await sourceSetup.query(
          `REVOKE ALL ON TYPE ${quoteIdentifier(type.schema_name)}.${quoteIdentifier(type.type_name)} FROM PUBLIC`,
        );
      }
      await normalizePgTrgmExtensionSecurity(sourceSetup);
      await sourceSetup.query('RESET ROLE');
      await sourceSetup.end();

      const bindings = await admin.query<{
        source_database_oid: string;
        source_database_owner: string;
        source_database_owner_oid: string;
        clone_owner_oid: string;
      }>(
        'SELECT d.oid::text AS source_database_oid, owner.rolname AS source_database_owner, d.datdba::text AS source_database_owner_oid, clone_owner.oid::text AS clone_owner_oid FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles owner ON owner.oid = d.datdba JOIN pg_catalog.pg_roles clone_owner ON clone_owner.rolname = $2 WHERE d.datname = $1',
        [SOURCE_DATABASE, OWNER_ROLE],
      );
      expect(bindings.rows).toHaveLength(1);
      const binding = bindings.rows[0]!;
      const mappedRoles = await admin.query<{ rolname: string; oid: string }>(
        'SELECT rolname, oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname',
        [roleNames],
      );
      expect(mappedRoles.rows).toHaveLength(COMMUNITIES_STAGING_ROLE_SPLIT_ROLE_CATEGORIES.length);
      const roleOids = new Map(mappedRoles.rows.map((row) => [row.rolname, row.oid]));
      const roleMappingText = `${[
        COMMUNITIES_STAGING_ROLE_SPLIT_MAPPING_VERSION,
        ...COMMUNITIES_STAGING_ROLE_SPLIT_ROLE_CATEGORIES.map((category) => {
          const roleName = ROLE_NAMES[category];
          const roleOid = roleOids.get(roleName);
          if (!roleOid) throw new Error('PG16_VERIFY_ROLE_OID_MISSING');
          return `${category}=${roleName}|${roleOid}`;
        }),
      ].join('\n')}\n`;

      const directory = await mkdtemp(join(tmpdir(), 'phub-pg16-role-split-'));
      cleanupDirectory = directory;
      await chmod(directory, 0o700);
      const archiveBasename = 'postgres-communities-rehearsal-20260819T220000Z-901.dump';
      const evidenceBasename = `${archiveBasename}.evidence`;
      const archivePath = join(directory, archiveBasename);
      const evidencePath = join(directory, evidenceBasename);
      const tocPath = join(directory, 'archive.toc');
      const dumpArguments = [
        'pg_dump',
        '-U',
        'postgres',
        '--format=custom',
        '--no-password',
        `--dbname=${SOURCE_DATABASE}`,
      ] as const;
      expect(dumpArguments).not.toContain('--no-owner');
      expect(dumpArguments).not.toContain('--no-acl');
      const archiveHandle = await open(
        archivePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await runDisposableDockerCommand(containerId, dumpArguments, {
          stdoutFd: archiveHandle.fd,
          maximumStdoutBytes: 0,
        });
        await archiveHandle.sync();
      } finally {
        await archiveHandle.close();
      }
      const archiveBytes = await readFile(archivePath);
      expect(archiveBytes.length).toBeGreaterThan(0);
      expect(archiveBytes.length).toBeLessThanOrEqual(16 * 1024 * 1024);

      const archiveForToc = await open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let tocBytes: Buffer;
      try {
        tocBytes = await runDisposableDockerCommand(containerId, ['pg_restore', '--list'], {
          stdinFd: archiveForToc.fd,
          maximumStdoutBytes: 2 * 1024 * 1024,
        });
      } finally {
        await archiveForToc.close();
      }
      expect(tocBytes.length).toBeGreaterThan(0);
      const [pgDumpVersion, pgRestoreVersion] = await Promise.all([
        runDisposableDockerCommand(containerId, ['pg_dump', '--version']),
        runDisposableDockerCommand(containerId, ['pg_restore', '--version']),
      ]);
      const evidenceText = `${[
        'schemaVersion=communities-role-split-local-archive-evidence-v1',
        'archiveFormat=custom',
        'restoreExitOnError=true',
        'restoreNoOwner=false',
        'restoreNoAcl=false',
        'extensionSecurityPreseeded=true',
        `pgDumpVersionSha256=${sha(pgDumpVersion)}`,
        `pgRestoreVersionSha256=${sha(pgRestoreVersion)}`,
      ].join('\n')}\n`;
      await writeFile(evidencePath, evidenceText, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await writeFile(tocPath, tocBytes, { flag: 'wx', mode: 0o600 });
      await Promise.all([archivePath, evidencePath, tocPath].map((path) => chmod(path, 0o600)));

      const request = {
        restoreDatabase: CLONE_DATABASE,
        expectedCloneDatabaseOwner: OWNER_ROLE,
        expectedCloneDatabaseOwnerOid: binding.clone_owner_oid,
        sourceDatabase: SOURCE_DATABASE,
        sourceDatabaseOid: binding.source_database_oid,
        sourceDatabaseOwner: binding.source_database_owner,
        sourceDatabaseOwnerOid: binding.source_database_owner_oid,
        systemIdentifier: server.rows[0]!.system_identifier,
        backupBasename: archiveBasename,
        backupSha256: sha(archiveBytes),
        backupBytes: String(archiveBytes.length),
        backupEvidenceBasename: evidenceBasename,
        backupEvidenceSha256: sha(evidenceText),
        archiveTocSha256: sha(tocBytes),
        sourceLedgerSha256: communitiesStagingRoleSplitLedgerSha256(ledger),
        sourceLedgerCount: String(ledger.length),
        activeRelease: 'd'.repeat(40),
        restoreRunId: '901',
        restoreRunAttempt: '1',
        postgresMajor: '16',
        objectManifestSha256: COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
        restoreHelperSha256: '2'.repeat(64),
        markerWriterSha256: '3'.repeat(64),
      } satisfies CommunitiesStagingRoleSplitRestoreMarkerRequest;
      const adminHost = new LazyCountingPgClient(adminUrl.toString());
      const sourceHost = new LazyCountingPgClient(databaseUrl(adminUrl, SOURCE_DATABASE));
      const cloneHost = new LazyCountingPgClient(databaseUrl(adminUrl, CLONE_DATABASE));
      cleanupClients.push(adminHost, sourceHost, cloneHost);
      const config = {
        stateDirectory: directory,
        request,
        creationReceiptSha256: '1'.repeat(64),
        admin: adminHost,
        source: sourceHost,
        clone: cloneHost,
        archive: { path: archivePath, evidencePath, tocPath },
        createCloneDatabase: async (restoreDatabase: string) => {
          await admin.query(
            `CREATE DATABASE ${quoteIdentifier(restoreDatabase)} WITH TEMPLATE template0 OWNER ${quoteIdentifier(OWNER_ROLE)}`,
          );
          await admin.query(`SET ROLE ${quoteIdentifier(OWNER_ROLE)}`);
          await admin.query(
            `REVOKE ALL ON DATABASE ${quoteIdentifier(restoreDatabase)} FROM PUBLIC`,
          );
          await admin.query(
            `GRANT CONNECT ON DATABASE ${quoteIdentifier(restoreDatabase)} TO ${quoteIdentifier(READER_ROLE)}`,
          );
          await admin.query('RESET ROLE');
          const extensionSetup = new Client({
            connectionString: databaseUrl(adminUrl, restoreDatabase),
            connectionTimeoutMillis: 5_000,
            query_timeout: 5_000,
            statement_timeout: 5_000,
          });
          try {
            await extensionSetup.connect();
            await extensionSetup.query(`SET ROLE ${quoteIdentifier(OWNER_ROLE)}`);
            await extensionSetup.query('CREATE EXTENSION pg_trgm WITH SCHEMA public');
            await extensionSetup.query('RESET ROLE');
            await normalizePgTrgmExtensionSecurity(extensionSetup);
          } finally {
            await extensionSetup.end().catch(() => undefined);
          }
        },
        restoreArchive: async ({ archiveFile, request: restoreRequest }) => {
          expect((await archiveFile.stat()).isFile()).toBe(true);
          const restoreArguments = [
            'pg_restore',
            '-U',
            'postgres',
            '--exit-on-error',
            '--no-password',
            '--use-set-session-authorization',
            `--dbname=${restoreRequest.restoreDatabase}`,
          ] as const;
          expect(restoreArguments).not.toContain('--no-owner');
          expect(restoreArguments).not.toContain('--no-acl');
          await runDisposableDockerCommand(containerId, restoreArguments, {
            stdinFd: archiveFile.fd,
            maximumStdoutBytes: 1024 * 1024,
          });
        },
      } satisfies CommunitiesStagingRoleSplitMarkerCeremonyPgHostConfig;
      fixture = {
        admin,
        adminUrl,
        adminHost,
        sourceHost,
        cloneHost,
        directory,
        request,
        requestSha256: communitiesStagingRoleSplitRestoreMarkerRequestSha256(request),
        roleMappingText,
        config,
      };
    }, 30_000);

    afterAll(async () => {
      await Promise.all(cleanupClients.map((client) => client.end().catch(() => undefined)));
      const prefix = join(tmpdir(), 'phub-pg16-role-split-');
      if (cleanupDirectory?.startsWith(prefix))
        await rm(cleanupDirectory, { recursive: true, force: true });
    });

    it('writes and exactly reads back a database marker as a non-superuser clone owner', async () => {
      const restoreDatabase = 'phub_restore_990_1';
      await fixture.admin.query(
        `CREATE DATABASE ${quoteIdentifier(restoreDatabase)} OWNER ${quoteIdentifier(
          MARKER_WRITER_ROLE,
        )}`,
      );
      try {
        const binding = await fixture.admin.query<{
          database_oid: string;
          owner_oid: string;
          system_identifier: string;
          owner_is_superuser: boolean;
          owner_can_create_database: boolean;
          owner_can_create_role: boolean;
        }>(
          `SELECT database.oid::text AS database_oid,
                  owner.oid::text AS owner_oid,
                  (pg_control_system()).system_identifier::text AS system_identifier,
                  owner.rolsuper AS owner_is_superuser,
                  owner.rolcreatedb AS owner_can_create_database,
                  owner.rolcreaterole AS owner_can_create_role
             FROM pg_catalog.pg_database database
             JOIN pg_catalog.pg_roles owner ON owner.oid = database.datdba
            WHERE database.datname = $1`,
          [restoreDatabase],
        );
        expect(binding.rows).toEqual([
          expect.objectContaining({
            owner_is_superuser: false,
            owner_can_create_database: false,
            owner_can_create_role: false,
          }),
        ]);
        const row = binding.rows[0]!;
        const request = {
          ...fixture.request,
          restoreDatabase,
          expectedCloneDatabaseOwner: MARKER_WRITER_ROLE,
          expectedCloneDatabaseOwnerOid: row.owner_oid,
          systemIdentifier: row.system_identifier,
          restoreRunId: '990',
        } satisfies CommunitiesStagingRoleSplitRestoreMarkerRequest;
        const markerWriterUrl = new URL(
          roleDatabaseUrl(fixture.adminUrl, MARKER_WRITER_ROLE, restoreDatabase),
        );
        markerWriterUrl.search = '?sslmode=disable';
        const factory = new CommunitiesStagingRoleSplitCloneOnlyConnectionFactory(
          sha('pg16-marker-writer-factory'),
          markerWriterUrl.toString(),
          {
            database: restoreDatabase,
            host: '127.0.0.1',
            port: fixture.adminUrl.port,
            connectionUser: MARKER_WRITER_ROLE,
            sslMode: 'disable',
          },
          5_000,
          5_000,
        );
        const marker = `phub-communities-role-split-clone-v2:${sha('pg16-marker-writer')}`;
        const writer = new CommunitiesStagingRoleSplitPgMarkerWriter(
          request.markerWriterSha256,
          factory,
          10_000,
        );
        await expect(
          writer.write({ request, cloneDatabaseOid: row.database_oid, marker }),
        ).resolves.toBeUndefined();
        const readback = await fixture.admin.query<{
          marker: string | null;
          owner_oid: string;
        }>(
          `SELECT pg_catalog.shobj_description(database.oid, 'pg_database') AS marker,
                  database.datdba::text AS owner_oid
             FROM pg_catalog.pg_database database
            WHERE database.oid = $1::oid AND database.datname = $2`,
          [row.database_oid, restoreDatabase],
        );
        expect(readback.rows).toEqual([{ marker, owner_oid: row.owner_oid }]);
      } finally {
        await fixture.admin.query(`DROP DATABASE ${quoteIdentifier(restoreDatabase)}`);
      }
    });

    it('binds a real PG16 custom archive restore, ledger, ownership, ACL and RLS', async () => {
      const host = new CommunitiesStagingRoleSplitMarkerCeremonyPgHost(fixture.config);
      const lease = await host.acquireLease(fixture.requestSha256);
      const candidate = createCommunitiesStagingRoleSplitMarkerCeremonyCandidate(
        fixture.requestSha256,
      );
      await host.createCandidate(lease, candidate);
      expect(await host.observeClone(lease, null)).toBe('absent');
      const { cloneDatabaseOid } = await host.createClone(lease);
      const owned = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(candidate, 'OWNED', {
        cloneDatabaseOid,
      });
      await host.advanceState(lease, candidate, owned);
      const restorePending = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(
        owned,
        'RESTORE_PENDING',
        { cloneDatabaseOid },
      );
      await host.advanceState(lease, owned, restorePending);
      await host.restoreClone(lease, cloneDatabaseOid);
      const restored = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(
        restorePending,
        'RESTORED',
        { cloneDatabaseOid },
      );
      await host.advanceState(lease, restorePending, restored);
      const artifacts = await host.verifyBindings(lease, cloneDatabaseOid);
      verifiedArtifacts = artifacts;
      const markerPayloadSha256 = communitiesStagingRoleSplitRestoreMarkerPayloadSha256(
        artifacts.payload,
      );
      const verified = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(restored, 'VERIFIED', {
        cloneDatabaseOid,
        markerPayloadSha256,
      });
      await host.saveVerified(lease, restored, verified, artifacts);

      const catalog = await fixture.cloneHost.query<{
        table_owner: string;
        rls_enabled: boolean;
        rls_forced: boolean;
        policy_count: string;
        overload_count: string;
        empty_function_acl: string;
        reader_column_select: boolean;
      }>(
        `SELECT
           pg_catalog.pg_get_userbyid(c.relowner) AS table_owner,
           c.relrowsecurity AS rls_enabled,
           c.relforcerowsecurity AS rls_forced,
           (SELECT count(*)::text FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid) AS policy_count,
           (SELECT count(*)::text FROM pg_catalog.pg_proc p WHERE p.proname = 'role_split_overload') AS overload_count,
           (SELECT p.proacl::text FROM pg_catalog.pg_proc p WHERE p.proname = 'empty_acl_fixture') AS empty_function_acl,
           pg_catalog.has_column_privilege($1, c.oid, 'visible_text', 'SELECT') AS reader_column_select
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'communities' AND c.relname = 'Quoted Table'`,
        [READER_ROLE],
      );
      expect(catalog.rows).toEqual([
        {
          table_owner: OWNER_ROLE,
          rls_enabled: true,
          rls_forced: true,
          policy_count: '1',
          overload_count: '2',
          empty_function_acl: '{}',
          reader_column_select: true,
        },
      ]);

      expect(await host.observeMarker(lease, cloneDatabaseOid, artifacts.marker)).toBe('absent');
      await host.releaseLease(lease);
    }, 30_000);

    it('retains a real restored clone after response loss and never retries pg_restore automatically', async () => {
      const scenario = await createFailureScenario('902');
      let restoreCalls = 0;
      let loseRestoreResponse = true;
      const lostRestoreResponse = withFailureMatrixOverrides(scenario.host, {
        restoreClone: async (
          lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
          cloneDatabaseOid: string,
        ) => {
          restoreCalls += 1;
          await scenario.host.restoreClone(lease, cloneDatabaseOid);
          if (loseRestoreResponse) throw new Error('PG16_VERIFY_INJECTED_RESTORE_RESPONSE_LOSS');
        },
      });

      await expect(
        runCommunitiesStagingRoleSplitMarkerCeremony(scenario.requestSha256, lostRestoreResponse),
      ).rejects.toEqual(
        new CommunitiesStagingRoleSplitMarkerCeremonyError(
          'COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_RESTORE_OUTCOME_AMBIGUOUS',
        ),
      );
      expect(restoreCalls).toBe(1);
      const lease = await scenario.host.acquireLease(scenario.requestSha256);
      const state = await scenario.host.loadState(lease);
      expect(state?.phase).toBe('RESTORE_PENDING');
      expect(await scenario.host.observeClone(lease, state?.cloneDatabaseOid ?? null)).toBe(
        'exact',
      );
      expect(await scenario.host.observeMarkerPresence(lease, state?.cloneDatabaseOid ?? '')).toBe(
        'absent',
      );
      await scenario.host.releaseLease(lease);
      expect(
        await scenario.cloneHost.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM public.schema_migrations',
        ),
      ).toEqual({ rows: [{ count: String(ledger.length) }] });
      await expect(
        readFile(join(scenario.stateDirectory, 'marker-evidence.json'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });

      loseRestoreResponse = false;
      await expect(
        runCommunitiesStagingRoleSplitMarkerCeremony(scenario.requestSha256, lostRestoreResponse),
      ).rejects.toEqual(
        new CommunitiesStagingRoleSplitMarkerCeremonyError(
          'COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_RESTORE_OUTCOME_AMBIGUOUS',
        ),
      );
      expect(restoreCalls).toBe(1);
    }, 30_000);

    it('retains the real clone and durable state when pre-marker cleanup fails', async () => {
      const scenario = await createFailureScenario('903');
      let cleanupAttempts = 0;
      const cleanupFailure = withFailureMatrixOverrides(scenario.host, {
        verifyBindings: async (
          lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
          cloneDatabaseOid: string,
        ): Promise<CommunitiesStagingRoleSplitMarkerCeremonyArtifacts> => {
          await scenario.host.verifyBindings(lease, cloneDatabaseOid);
          throw new Error('PG16_VERIFY_INJECTED_POST_VERIFY_FAILURE');
        },
        dropExactClone: () => {
          cleanupAttempts += 1;
          return Promise.reject(new Error('PG16_VERIFY_INJECTED_CLEANUP_FAILURE'));
        },
      });

      await expect(
        runCommunitiesStagingRoleSplitMarkerCeremony(scenario.requestSha256, cleanupFailure),
      ).rejects.toEqual(
        new CommunitiesStagingRoleSplitMarkerCeremonyError(
          'COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_CLEANUP_FAILED',
        ),
      );
      expect(cleanupAttempts).toBe(1);
      const lease = await scenario.host.acquireLease(scenario.requestSha256);
      const state = await scenario.host.loadState(lease);
      expect(state?.phase).toBe('RESTORED');
      expect(await scenario.host.observeClone(lease, state?.cloneDatabaseOid ?? null)).toBe(
        'exact',
      );
      expect(await scenario.host.observeMarkerPresence(lease, state?.cloneDatabaseOid ?? '')).toBe(
        'absent',
      );
      await scenario.host.releaseLease(lease);
      await expect(
        readFile(join(scenario.stateDirectory, 'marker-evidence.json'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }, 30_000);

    it('reconciles real marker and evidence response loss without rewriting either artifact', async () => {
      const delegate = new CommunitiesStagingRoleSplitMarkerCeremonyPgHost(fixture.config);
      let markerWrites = 0;
      let evidenceWrites = 0;
      let evidenceMode: 'fail_before_write' | 'write_then_lose_response' = 'fail_before_write';
      const failureMatrixHost = withFailureMatrixOverrides(delegate, {
        writeMarker: async (
          lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
          cloneDatabaseOid: string,
          marker: string,
        ) => {
          void lease;
          markerWrites += 1;
          await writeExactMarkerInCatalogTransaction(
            fixture.admin,
            fixture.request,
            cloneDatabaseOid,
            marker,
          );
          throw new Error('PG16_VERIFY_INJECTED_MARKER_RESPONSE_LOSS');
        },
        publishEvidence: async (
          lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
          evidence: CommunitiesStagingRoleSplitRestoreMarkerEvidence,
        ) => {
          void lease;
          evidenceWrites += 1;
          if (evidenceMode === 'fail_before_write')
            throw new Error('PG16_VERIFY_INJECTED_EVIDENCE_WRITE_FAILURE');
          await writeFile(
            join(fixture.directory, 'marker-evidence.json'),
            `${canonicalJson(evidence)}\n`,
            { encoding: 'utf8', flag: 'wx', mode: 0o600 },
          );
          throw new Error('PG16_VERIFY_INJECTED_EVIDENCE_RESPONSE_LOSS');
        },
      });

      await expect(
        runCommunitiesStagingRoleSplitMarkerCeremony(fixture.requestSha256, failureMatrixHost),
      ).rejects.toEqual(
        new CommunitiesStagingRoleSplitMarkerCeremonyError(
          'COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_EVIDENCE_WRITE_FAILED',
        ),
      );
      expect(markerWrites).toBe(1);
      expect(evidenceWrites).toBe(1);
      let lease = await delegate.acquireLease(fixture.requestSha256);
      let state = await delegate.loadState(lease);
      expect(state?.phase).toBe('MARKED');
      expect(
        await delegate.observeMarker(
          lease,
          state?.cloneDatabaseOid ?? '',
          verifiedArtifacts.marker,
        ),
      ).toBe('exact');
      await delegate.releaseLease(lease);
      await expect(
        readFile(join(fixture.directory, 'marker-evidence.json'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });

      evidenceMode = 'write_then_lose_response';
      await expect(
        runCommunitiesStagingRoleSplitMarkerCeremony(fixture.requestSha256, failureMatrixHost),
      ).rejects.toEqual(
        new CommunitiesStagingRoleSplitMarkerCeremonyError(
          'COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_EVIDENCE_WRITE_FAILED',
        ),
      );
      expect(markerWrites).toBe(1);
      expect(evidenceWrites).toBe(2);

      await expect(
        runCommunitiesStagingRoleSplitMarkerCeremony(fixture.requestSha256, failureMatrixHost),
      ).resolves.toBeUndefined();
      expect(markerWrites).toBe(1);
      expect(evidenceWrites).toBe(2);
      lease = await delegate.acquireLease(fixture.requestSha256);
      state = await delegate.loadState(lease);
      expect(state?.phase).toBe('EVIDENCED');
      expect(
        await delegate.observeMarker(
          lease,
          state?.cloneDatabaseOid ?? '',
          verifiedArtifacts.marker,
        ),
      ).toBe('exact');
      const persistedEvidence = await readFile(
        join(fixture.directory, 'marker-evidence.json'),
        'utf8',
      );
      expect(persistedEvidence).toMatch(/^\{"authorizes":/u);
      await delegate.releaseLease(lease);
    }, 30_000);

    it('produces deterministic real-catalog INPUT_C and passes the no-change evaluator', async () => {
      const requestText = canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest(fixture.request);
      const evidenceText = markerEvidenceText(verifiedArtifacts.payload, verifiedArtifacts.marker);
      const input = {
        confirmation: COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CONFIRMATION,
        connectionString: `postgresql://${READER_ROLE}@postgres:5432/${CLONE_DATABASE}`,
        requestText,
        expectedRequestSha256: fixture.requestSha256,
        markerEvidenceText: evidenceText,
        expectedMarkerEvidenceSha256: sha(evidenceText),
        roleMappingText: fixture.roleMappingText,
        expectedRoleMappingSha256: sha(fixture.roleMappingText),
      };
      let aclWireFailure: string | null = null;
      let queryFailure: string | null = null;
      const createClient: CommunitiesStagingRoleSplitInventoryClientFactory = () => {
        const client = new Client({
          connectionString: roleDatabaseUrl(fixture.adminUrl, READER_ROLE, CLONE_DATABASE),
          connectionTimeoutMillis: 5_000,
          query_timeout: 30_000,
          statement_timeout: 30_000,
        });
        return {
          connect: async () => {
            await client.connect();
          },
          query: async <T extends Record<string, unknown>>(
            text: string,
            values?: readonly unknown[],
          ): Promise<QueryResult<T>> => {
            const category = /communities-role-split-input-c:([A-Za-z]+)/u.exec(text)?.[1];
            let result: QueryResult<T>;
            try {
              result = await client.query<T>(text, values ? [...values] : undefined);
            } catch (error: unknown) {
              const pgError = error as { code?: string };
              queryFailure = `PG16_VERIFY_QUERY_FAILED_${category ?? 'control'}_${pgError.code ?? 'unknown'}`;
              throw error;
            }
            for (const row of result.rows) {
              if (row.field_kind !== 'ACL_EXPLICIT' && row.field_kind !== 'ACL_EFFECTIVE') continue;
              if (typeof row.value !== 'string') {
                aclWireFailure = `PG16_VERIFY_ACL_WIRE_INVALID_${category ?? 'unknown'}`;
                throw new Error(aclWireFailure);
              }
              try {
                JSON.parse(row.value);
              } catch {
                aclWireFailure = `PG16_VERIFY_ACL_JSON_INVALID_${category ?? 'unknown'}`;
                throw new Error(aclWireFailure);
              }
            }
            return result;
          },
          end: () => client.end(),
        };
      };
      const first = await produceCommunitiesStagingRoleSplitInventory(input, createClient).catch(
        (error: unknown) => {
          if (aclWireFailure !== null) throw new Error(aclWireFailure);
          if (queryFailure !== null) throw new Error(queryFailure);
          throw error;
        },
      );
      const second = await produceCommunitiesStagingRoleSplitInventory(input, createClient);
      expect(second).toEqual(first);
      expect(first.anomalies).toEqual([]);
      const artifactPath = join(fixture.directory, 'inventory.input-c.json');
      const artifactText = communitiesRoleSplitInputCArtifactText(first);
      await writeFile(artifactPath, artifactText, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      const artifactMetadata = await stat(artifactPath);
      expect(artifactMetadata.mode & 0o777).toBe(0o600);
      const independentlyPinnedArtifactSha256 = communitiesRoleSplitInputCArtifactSha256(first);
      const artifactVerification = verifyCommunitiesStagingRoleSplitInventoryArtifact(
        await readFile(artifactPath),
        independentlyPinnedArtifactSha256,
      );
      expect(artifactVerification).toMatchObject({
        artifactSha256: independentlyPinnedArtifactSha256,
        manifestSha256: first.manifestSha256,
        anomalyObservationCount: 0,
        binding: { callerSuppliedArtifactPinMatched: true, canonicalArtifactBytes: true },
        limitations: {
          independentCustodyNotAttested: true,
          cleanCloneProvenanceNotAttested: true,
        },
      });
      expect(Object.values(artifactVerification.authorizes)).toEqual([
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
      ]);
      expect(Object.keys(first.normalized)).toHaveLength(12);
      expect(
        first.normalized.functions.filter((record) => record.fieldKind === 'OWNER').length,
      ).toBe(3);
      expect(first.normalized.types.filter((record) => record.fieldKind === 'OWNER').length).toBe(
        2,
      );
      expect(
        first.normalized.relations.filter((record) => record.fieldKind === 'OWNER').length,
      ).toBe(2);
      expect(
        first.normalized.sequences.filter((record) => record.fieldKind === 'OWNER').length,
      ).toBe(1);
      expect(first.normalized.rlsPolicies.map((record) => record.fieldKind)).toEqual(
        expect.arrayContaining(['RLS', 'POLICY']),
      );
      expect(
        first.normalized.extensions.some((record) => record.fieldKind === 'EXTENSION_MEMBER'),
      ).toBe(true);
      expect(
        first.normalized.relations.some(
          (record) =>
            record.fieldKind === 'ACL_EXPLICIT' &&
            record.semantic !== null &&
            'entries' in record.semantic &&
            record.semantic.entries.length > 0,
        ),
      ).toBe(true);
      expect(JSON.stringify(first)).not.toMatch(
        new RegExp(
          [
            SOURCE_DATABASE,
            CLONE_DATABASE,
            ...Object.values(ROLE_NAMES),
            fixture.request.systemIdentifier,
            verifiedArtifacts.payload.cloneDatabaseOid,
          ].join('|'),
          'u',
        ),
      );
      expect(() => assertCommunitiesRoleSplitInputC(first)).not.toThrow();
      const envelope = acceptanceEnvelope(first);
      expect(assertCommunitiesRoleSplitAcceptancePass(envelope, acceptancePins(first))).toEqual(
        envelope.comparison,
      );

      const extensionFunction = await fixture.cloneHost.query<{ identity: string }>(
        `SELECT routine.oid::regprocedure::text AS identity
           FROM pg_catalog.pg_proc routine
           JOIN pg_catalog.pg_depend dependency
             ON dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
            AND dependency.objid = routine.oid
            AND dependency.objsubid = 0
            AND dependency.deptype = 'e'
           JOIN pg_catalog.pg_extension extension
             ON extension.oid = dependency.refobjid
            AND dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
          WHERE extension.extname = 'pg_trgm'
          ORDER BY routine.oid
          LIMIT 1`,
      );
      expect(extensionFunction.rows).toHaveLength(1);
      await fixture.cloneHost.query(`SET ROLE ${quoteIdentifier(OWNER_ROLE)}`);
      try {
        await fixture.cloneHost.query(
          `GRANT EXECUTE ON FUNCTION ${extensionFunction.rows[0]!.identity} TO PUBLIC`,
        );
        const extensionGrant = await produceCommunitiesStagingRoleSplitInventory(
          input,
          createClient,
        );
        expect(extensionGrant.anomalies.map((entry) => entry.code)).toContain(
          'PUBLIC_GRANT_FORBIDDEN',
        );
        expect(extensionGrant.normalized.extensions).not.toEqual(first.normalized.extensions);
      } finally {
        await fixture.cloneHost.query(
          `REVOKE EXECUTE ON FUNCTION ${extensionFunction.rows[0]!.identity} FROM PUBLIC`,
        );
        await fixture.cloneHost.query('RESET ROLE');
      }
      expect(await produceCommunitiesStagingRoleSplitInventory(input, createClient)).toEqual(first);
    }, 30_000);

    it('rejects receipt drift before PG access and resumes the same verified receipt', async () => {
      const beforeQueries =
        fixture.adminHost.queryCount + fixture.sourceHost.queryCount + fixture.cloneHost.queryCount;
      const changedReceiptHost = new CommunitiesStagingRoleSplitMarkerCeremonyPgHost({
        ...fixture.config,
        creationReceiptSha256: '4'.repeat(64),
      });
      await expect(changedReceiptHost.acquireLease(fixture.requestSha256)).rejects.toMatchObject({
        code: 'STATE_RECEIPT_MISMATCH',
      });
      expect(
        fixture.adminHost.queryCount + fixture.sourceHost.queryCount + fixture.cloneHost.queryCount,
      ).toBe(beforeQueries);
      await expect(
        readFile(join(fixture.directory, 'ceremony.lock'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });

      const resumed = new CommunitiesStagingRoleSplitMarkerCeremonyPgHost(fixture.config);
      const lease = await resumed.acquireLease(fixture.requestSha256);
      const state = await resumed.loadState(lease);
      expect(state?.phase).toBe('EVIDENCED');
      const artifacts = await resumed.loadVerifiedArtifacts(lease);
      await expect(
        resumed.verifyBindings(lease, artifacts.payload.cloneDatabaseOid),
      ).resolves.toEqual(artifacts);
      await resumed.releaseLease(lease);
    });

    it('rejects real restored-ledger drift without rewriting state or marker', async () => {
      await fixture.cloneHost.query(
        "UPDATE public.schema_migrations SET checksum = $1 WHERE filename = '0002_acl_fixture.sql'",
        ['c'.repeat(64)],
      );
      const host = new CommunitiesStagingRoleSplitMarkerCeremonyPgHost(fixture.config);
      const lease = await host.acquireLease(fixture.requestSha256);
      const artifacts = await host.loadVerifiedArtifacts(lease);
      await expect(
        host.verifyBindings(lease, artifacts.payload.cloneDatabaseOid),
      ).rejects.toMatchObject({ code: 'LEDGER_BINDING_INVALID' });
      expect(
        await host.observeMarker(lease, artifacts.payload.cloneDatabaseOid, artifacts.marker),
      ).toBe('exact');
      await host.releaseLease(lease);
    });
  });
