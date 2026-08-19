import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  createCommunitiesStagingRoleSplitMarkerCeremonyCandidate,
  type CommunitiesRoleSplitAcceptanceEnvelope,
  type CommunitiesRoleSplitExpectedPins,
  type CommunitiesRoleSplitGrantDecision,
  type CommunitiesRoleSplitGrantObjectKind,
  type CommunitiesRoleSplitInputC,
  type CommunitiesRoleSplitObjectKind,
  type CommunitiesStagingRoleSplitLedgerEntry,
  type CommunitiesStagingRoleSplitRestoreMarkerPayload,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
} from '@phub/database';
import { Client, type QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CommunitiesStagingRoleSplitMarkerCeremonyPgHost,
  type CommunitiesStagingRoleSplitMarkerCeremonyPgClient,
  type CommunitiesStagingRoleSplitMarkerCeremonyPgHostConfig,
} from './communities-staging-role-split-marker-ceremony-pg-host.js';
import {
  COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CONFIRMATION,
  COMMUNITIES_STAGING_ROLE_SPLIT_MAPPING_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_ROLE_CATEGORIES,
  produceCommunitiesStagingRoleSplitInventory,
  type CommunitiesStagingRoleSplitInventoryClientFactory,
} from './communities-staging-role-split-inventory.js';

const ADMIN_DATABASE = 'phub_role_split_admin_verify';
const SOURCE_DATABASE = 'phub_source_verify';
const CLONE_DATABASE = 'phub_restore_901_1';
const OWNER_ROLE = 'phub_owner_verify';
const READER_ROLE = 'phub_reader_verify';
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

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

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

    beforeAll(async () => {
      const adminUrl = parsedConfiguredUrl as URL;
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
      const existing = await admin.query<{ database_count: string; role_count: string }>(
        'SELECT (SELECT count(*)::text FROM pg_catalog.pg_database WHERE datname = ANY($1::text[])) AS database_count, (SELECT count(*)::text FROM pg_catalog.pg_roles WHERE rolname = ANY($2::text[])) AS role_count',
        [[SOURCE_DATABASE, CLONE_DATABASE], roleNames],
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
      const operators = await sourceSetup.query<{ identity: string }>(
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
        await sourceSetup.query(
          `ALTER OPERATOR ${operator.identity} OWNER TO ${quoteIdentifier(OWNER_ROLE)}`,
        );
      const operatorClasses = await sourceSetup.query<{
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
        await sourceSetup.query(
          `ALTER OPERATOR CLASS ${quoteIdentifier(operatorClass.schema_name)}.${quoteIdentifier(operatorClass.class_name)} USING ${quoteIdentifier(operatorClass.access_method)} OWNER TO ${quoteIdentifier(OWNER_ROLE)}`,
        );
      const operatorFamilies = await sourceSetup.query<{
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
        await sourceSetup.query(
          `ALTER OPERATOR FAMILY ${quoteIdentifier(operatorFamily.schema_name)}.${quoteIdentifier(operatorFamily.family_name)} USING ${quoteIdentifier(operatorFamily.access_method)} OWNER TO ${quoteIdentifier(OWNER_ROLE)}`,
        );
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
      await writeFile(archivePath, 'template-clone-fixture');
      await writeFile(evidencePath, 'local-pg16-fixture');
      await writeFile(tocPath, 'template source clone');
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
        backupSha256: sha('template-clone-fixture'),
        backupBytes: String(Buffer.byteLength('template-clone-fixture')),
        backupEvidenceBasename: evidenceBasename,
        backupEvidenceSha256: sha('local-pg16-fixture'),
        archiveTocSha256: sha('template source clone'),
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
          expect(restoreDatabase).toBe(CLONE_DATABASE);
          await admin.query(
            `CREATE DATABASE ${quoteIdentifier(restoreDatabase)} WITH TEMPLATE ${quoteIdentifier(SOURCE_DATABASE)} OWNER ${quoteIdentifier(OWNER_ROLE)}`,
          );
          await admin.query(`SET ROLE ${quoteIdentifier(OWNER_ROLE)}`);
          await admin.query(
            `REVOKE ALL ON DATABASE ${quoteIdentifier(CLONE_DATABASE)} FROM PUBLIC`,
          );
          await admin.query(
            `GRANT CONNECT ON DATABASE ${quoteIdentifier(CLONE_DATABASE)} TO ${quoteIdentifier(READER_ROLE)}`,
          );
          await admin.query('RESET ROLE');
        },
        restoreArchive: async ({ archiveFile, request: restoreRequest }) => {
          expect(restoreRequest).toEqual(request);
          expect((await archiveFile.stat()).isFile()).toBe(true);
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

    it('binds a real PG16 template clone, ledger, ownership, ACL, RLS and marker readback', async () => {
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

      await fixture.admin.query(
        `COMMENT ON DATABASE ${quoteIdentifier(CLONE_DATABASE)} IS ${quoteLiteral(artifacts.marker)}`,
      );
      expect(await host.observeMarker(lease, cloneDatabaseOid, artifacts.marker)).toBe('exact');
      await host.releaseLease(lease);
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
      expect(state?.phase).toBe('VERIFIED');
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
