import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { Client, type QueryResult } from 'pg';
import {
  GAME_INVITATIONS_0120 as profile,
  GAME_INVITATIONS_0120_TARGET as production,
  buildGameInvitations0120Sql as build,
  validateGameInvitations0120Backup as validateBackup,
  validateGameInvitations0120Request as validateRequest,
  type GameInvitations0120Target,
} from './timeweb-game-invitations-migration.js';

const dir = new URL('../packages/database/migrations/', import.meta.url);
const bytes = readFileSync(new URL(profile.filename, dir));
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const previous = readdirSync(dir)
  .filter((file) => file.endsWith('.sql') && file.localeCompare(profile.filename) < 0)
  .sort()
  .map((file) => [file, hash(readFileSync(new URL(file, dir)))] as const);
const tsv = (rows: ReadonlyArray<readonly [string, string]>) =>
  rows.map((row) => row.join('\t') + '\n').join('');

it('pins the exact 123 to 124 ledger and builds bounded SQL for the selected target', () => {
  expect(previous).toHaveLength(123);
  expect(hash(tsv(previous))).toBe(profile.before);
  expect(hash(tsv([...previous, [profile.filename, hash(bytes)]]))).toBe(profile.after);
  const readback = build(bytes, production, 'readback');
  expect(readback).toMatch(/^begin read only;/);
  expect(readback).not.toContain('insert into public.schema_migrations');
  const apply = build(bytes, production, 'apply', 'a'.repeat(64));
  expect(apply).toContain('pg_try_advisory_xact_lock(7140221)');
  expect(apply).toContain(bytes.toString());
  expect(apply).toContain('alter table games.friend_invitations owner to phub_migrator');
  expect(apply.lastIndexOf('GAME_INVITATIONS_0120_POSTIMAGE')).toBeLessThan(
    apply.lastIndexOf('commit;'),
  );
  expect(() => build(Buffer.concat([bytes, Buffer.from('\n')]), production, 'readback')).toThrow(
    'SQL_CHECKSUM',
  );
  expect(() => build(bytes, { ...production, operator: 'phub_migrator' }, 'readback')).toThrow(
    'TARGET',
  );
});

it('binds an expiring request and new backup to the enrolled release and waiver', () => {
  const enrollment = { controllerSha: 'a'.repeat(40), owner: 'owner' };
  const now = Date.parse('2026-11-26T12:00:00.000Z');
  const request = {
    schema: 'PHUB_TIMEWEB_GAME_INVITATIONS_0120_REQUEST_V1',
    attemptId: '01234567-89ab-4cde-8f00-0123456789ab',
    controllerSha: enrollment.controllerSha,
    migrationSourceSha: enrollment.controllerSha,
    postgresContainerId: 'b'.repeat(64),
    expiresAt: '2026-11-26T12:45:00.000Z',
    backupReleaseId: enrollment.controllerSha + '-1234-1',
    retainedBackupReceiptSha256: 'c'.repeat(64),
    externalRestoreDecision: {
      status: profile.restoreDecision,
      owner: 'owner',
      referenceSha256: profile.restoreMessageSha256,
      backupDecisionSha256: 'd'.repeat(64),
    },
  };
  expect(validateRequest(request, enrollment, now)).toEqual(request);
  expect(() =>
    validateRequest({ ...request, backupReleaseId: 'x/../elsewhere' }, enrollment, now),
  ).toThrow('REQUEST');
  expect(() =>
    validateRequest({ ...request, migrationSourceSha: 'f'.repeat(40) }, enrollment, now),
  ).toThrow('REQUEST');
  expect(() => validateRequest(request, enrollment, now + 46 * 60_000)).toThrow('EXPIRED');

  const backupFile = '/fixture/database.pgcustom';
  const archive = { isFile: () => true, nlink: 1, size: 200 };
  const receipt = {
    schema: 'PHUB_TIMEWEB_GAME_INVITATIONS_0120_FRESH_DUMP_V1',
    restoreAdmissionPolicy: 'GAME_INVITATIONS_0120_INTEGRITY_ONLY_V1',
    baselineReleaseId: profile.baselineReleaseId,
    databaseTarget: {
      databaseName: production.database,
      systemIdentifier: production.systemIdentifier,
    },
    sourceLedgerSha256: profile.backupLedger,
    freshDumpRestored: false,
    freshDumpIntegrityStatus: 'PG16_TOC_PARSE_VERIFIED',
    backupFile,
    backupSha256: 'f'.repeat(64),
    completedAt: '2026-11-26T11:45:00.000Z',
    dumpBytes: archive.size,
  };
  expect(() => validateBackup(receipt, archive, backupFile, now)).not.toThrow();
  expect(() => validateBackup(receipt, archive, backupFile, now + 60 * 60_000)).toThrow('BACKUP');
  expect(() =>
    validateBackup({ ...receipt, freshDumpRestored: true }, archive, backupFile, now),
  ).toThrow('BACKUP');
  expect(() =>
    validateBackup(
      { ...receipt, schema: 'PHUB_TIMEWEB_CUP_SUPPORT_FRESH_DUMP_V1' },
      archive,
      backupFile,
      now,
    ),
  ).toThrow('BACKUP');
});

const socket = process.env.GAME_INVITATIONS_0120_QA_SOCKET;
it.skipIf(!socket)(
  'applies, verifies and reconciles the transaction on disposable PostgreSQL',
  async () => {
    if (!/^\/(private\/)?tmp\/lk2-0120-pg\.[a-zA-Z0-9]+\/socket$/.test(socket ?? ''))
      throw new Error('Expected isolated 0120 QA socket');
    const database = process.env.GAME_INVITATIONS_0120_QA_DATABASE ?? 'qa_closed_0120';
    if (!/^qa_closed_0120(?:_[a-z0-9]+)?$/.test(database))
      throw new Error('Expected disposable 0120 QA database');
    const config = { host: socket, port: 25436, user: 'phub_beta', database };
    const db = new Client(config);
    await db.connect();
    try {
      const targets = await db.query<{ count: number }>(
        "select count(*)::integer from pg_namespace where nspname in ('games', 'identity')",
      );
      expect(targets.rows[0]?.count).toBe(0);
      await db.query(`create schema games; create schema identity;
      create table games.games(tenant_id uuid not null,id uuid primary key,unique(tenant_id,id));
      create table identity.users(tenant_id uuid not null,id uuid primary key,unique(tenant_id,id));
      alter table games.games enable row level security;
      alter table games.games force row level security;
      alter table identity.users enable row level security;
      alter table identity.users force row level security;
      grant usage on schema games to phub_runtime;
      create table public.schema_migrations(filename text primary key, checksum text not null);
      alter table public.schema_migrations owner to phub_migrator;`);
      for (const row of previous) {
        await db.query('insert into public.schema_migrations(filename,checksum) values($1,$2)', [
          ...row,
        ]);
      }
      const {
        rows: [target],
      } = await db.query<GameInvitations0120Target>(`select
      current_database() database, system_identifier::text "systemIdentifier",
      'phub_beta' operator, 'phub_migrator' owner,
      'public.schema_migrations'::regclass::oid::integer "ledgerOid",
      'games.games'::regclass::oid::integer "gamesOid",
      'identity.users'::regclass::oid::integer "usersOid"
      from pg_control_system()`);
      expect(target).toBeDefined();
      if (!target) throw new Error('Missing fixture target');
      type ReadbackRow = { jsonb_build_object: { state: string; catalogSha256: string } };
      const readback = async () => {
        const output = await db.query<ReadbackRow>(build(bytes, target, 'readback'));
        // pg returns a result per statement for an unparameterized multi-statement query.
        const statements = Array.isArray(output)
          ? (output as QueryResult<ReadbackRow>[])
          : [output];
        const result = statements.find(({ command }) => command === 'SELECT')?.rows[0];
        if (!result) throw new Error('Missing migration readback');
        return result.jsonb_build_object;
      };
      const before = await readback();
      expect(before.state).toBe('PREIMAGE');
      await expect(db.query(build(bytes, target, 'apply', 'a'.repeat(64)))).rejects.toThrow(
        'PREIMAGE',
      );
      await db.query('rollback');
      expect(await readback()).toEqual(before);

      const concurrent = new Client(config);
      await concurrent.connect();
      try {
        await concurrent.query('begin; select pg_advisory_xact_lock(7140221);');
        await expect(db.query(build(bytes, target, 'apply', before.catalogSha256))).rejects.toThrow(
          'BUSY',
        );
        await db.query('rollback');
      } finally {
        await concurrent.end();
      }
      await db.query(
        'alter default privileges in schema games grant select on tables to pg_read_all_stats',
      );
      const excessGrant = await readback();
      await expect(
        db.query(build(bytes, target, 'apply', excessGrant.catalogSha256)),
      ).rejects.toThrow('POSTIMAGE');
      await db.query('rollback');
      expect(await readback()).toEqual(excessGrant);
      await db.query(
        'alter default privileges in schema games revoke select on tables from pg_read_all_stats',
      );

      const ready = await readback();
      const apply = build(bytes, target, 'apply', ready.catalogSha256);
      await db.query(apply);
      expect(await readback()).toEqual({ state: 'COMMITTED', catalogSha256: ready.catalogSha256 });
      await expect(db.query(apply)).rejects.toThrow('PREIMAGE');
      await db.query('rollback');
      await db.query(
        'begin read only; set local role phub_runtime; select * from games.friend_invitations; rollback;',
      );
      await db.query('grant delete on games.friend_invitations to phub_runtime');
      expect((await readback()).state).toBe('DRIFT');
    } finally {
      await db.end();
    }
  },
);
