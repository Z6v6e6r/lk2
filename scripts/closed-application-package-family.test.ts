import { lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import full from '../deploy/timeweb/r1-tail108-119.v1.json';
import descriptor from '../deploy/timeweb/closed-application-prefix108-package119.v1.json';
import {
  assertClosedPackagedCatalog,
  closedProfileArgument,
  r1ClosedProfileArgument,
} from '../apps/migrator/src/closed-single-migration.js';
import {
  CLOSED_R1_OPERATION_SCHEMAS,
  closedApplicationPackageFamily,
  closedApplicationDescriptorPath,
} from './closed-application-package-family.js';
import {
  closedApplicationOperationFixture,
  closedBackupFixture,
} from './timeweb-closed-application.fixture.js';
import {
  closedApplicationCommand,
  validateClosedApplicationOperation,
} from './timeweb-closed-application-profile.js';
import {
  closedApplicationBackupDefinition,
  validateClosedApplicationBackupOperation,
} from './timeweb-closed-application-backup.js';
import {
  CLOSED_R1_CONTROLLER_FILES,
  validateClosedR1ControllerClosure,
  attestClosedApplicationControllerSource,
} from './timeweb-closed-application-source.js';
import { attestClosedApplicationPrevious } from './timeweb-closed-application-runtime.js';
import { encodeApiWorkerMigrationCapsule } from './timeweb-api-worker-migration.js';
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('explicit patched119 package with immutable108 closed prefix', () => {
  it('keeps historical108 rejection and refuses incomplete/foreign prefix or suffix in119 family', () => {
    expect(() => assertClosedPackagedCatalog(full.inventory, 'R1_PACKAGE119')).not.toThrow();
    expect(() => assertClosedPackagedCatalog(full.inventory)).toThrow('SOURCE_CATALOG');
    for (const rows of [
      full.inventory.slice(0, 108),
      full.inventory.slice(0, -1),
      [...full.inventory, { filename: '0116_foreign.sql', checksum: 'a'.repeat(64) }],
      full.inventory.map((row, i) =>
        i === 106 || i === 118 ? { ...row, checksum: 'f'.repeat(64) } : row,
      ),
      [...full.inventory].reverse(),
    ])
      expect(() => assertClosedPackagedCatalog(rows, 'R1_PACKAGE119')).toThrow();
    expect(descriptor.prefixLedgerSha256).toBe(full.checkpoints['108']);
  });
  it.each(['game_start_0103', 'subject_link_0104'] as const)(
    'uses explicit%s schema and CLI without selecting0105',
    (kind) => {
      const old = closedApplicationOperationFixture(kind),
        next = closedApplicationOperationFixture(kind, 'R1_PACKAGE119');
      expect(closedApplicationPackageFamily(old)).toBe('HISTORICAL108');
      expect(closedApplicationPackageFamily(next)).toBe('R1_PACKAGE119');
      expect(validateClosedApplicationOperation(next)).toBe(next);
      const oldArg = closedApplicationCommand(old, 'migration')[2]!,
        newArg = closedApplicationCommand(next, 'migration')[2]!;
      expect(closedProfileArgument(oldArg)).toBe(kind);
      expect(closedProfileArgument(newArg)).toBeUndefined();
      expect(r1ClosedProfileArgument(newArg)).toBe(kind);
      expect(r1ClosedProfileArgument(oldArg)).toBeUndefined();
      expect(newArg).toBe(
        kind === 'game_start_0103'
          ? '--r1-game-start-migration-0103'
          : '--r1-subject-link-migration-0104',
      );
      expect(closedApplicationCommand(next, 'migration').join(' ')).not.toContain('0105');
      expect(closedApplicationDescriptorPath(next)).toBe(
        'deploy/timeweb/closed-application-prefix108-package119.v1.json',
      );
      expect(() =>
        validateClosedApplicationOperation({
          ...next,
          schema:
            CLOSED_R1_OPERATION_SCHEMAS[
              kind === 'game_start_0103' ? 'subject_link_0104' : 'game_start_0103'
            ],
        }),
      ).toThrow();
      expect(() =>
        validateClosedApplicationOperation({
          ...next,
          publishedMigrator: { ...next.publishedMigrator, sourceSha: 'f'.repeat(40) },
        }),
      ).toThrow();
      const backup = closedBackupFixture(kind, 'R1_PACKAGE119');
      expect(validateClosedApplicationBackupOperation(backup)).toBe(backup);
      expect(backup.schema).toBe(closedApplicationBackupDefinition(next).schema);
      expect(() =>
        validateClosedApplicationBackupOperation({
          ...backup,
          schema: closedBackupFixture(kind).schema,
        }),
      ).toThrow();
      expect(() =>
        validateClosedApplicationBackupOperation({
          ...closedBackupFixture(kind),
          schema: backup.schema,
        }),
      ).toThrow();
    },
  );
  it('limits new source closure without accepting SQL, deps, workflows, symlinks or missing hooks', () => {
    const rows = CLOSED_R1_CONTROLLER_FILES.map((path) => ({
      path,
      status: 'M',
      oldMode: '100644',
      newMode: '100644',
      oldOid: 'a'.repeat(40),
      newOid: 'b'.repeat(40),
    }));
    expect(validateClosedR1ControllerClosure(rows)).toBe(rows);
    for (const path of [
      'package-lock.json',
      '.github/workflows/pull-request.yaml',
      'packages/database/migrations/0103_game_start_notification_scenarios.sql',
      'apps/api/src/main.ts',
    ])
      expect(() => validateClosedR1ControllerClosure([...rows, { ...rows[0]!, path }])).toThrow(
        'R1_DELTA',
      );
    expect(() =>
      validateClosedR1ControllerClosure(
        rows.filter((row) => row.path !== 'apps/migrator/src/migration-runner.ts'),
      ),
    ).toThrow('R1_REQUIRED');
    expect(() =>
      validateClosedR1ControllerClosure([{ ...rows[0]!, newMode: '120000' }, ...rows.slice(1)]),
    ).toThrow('R1_DELTA');
  });
  it('rejects source identity drift before reading migration bytes for the new schema', () => {
    const op = closedApplicationOperationFixture('game_start_0103', 'R1_PACKAGE119'),
      root = '/opt/phub/timeweb-beta/standard/source';
    let migrationReads = 0;
    expect(() =>
      attestClosedApplicationControllerSource(op, {
        assertGitConfig: () => {},
        secure: () => lstatSync('.'),
        present: () => false,
        read: (path) => {
          if (path === '/etc/phub/timeweb-beta-standard-delivery.json')
            return encode({
              schema: 1,
              enabled: true,
              owner: 'synthetic',
              controllerSha: op.controllerSha,
            });
          migrationReads++;
          throw Error('NO_FOREIGN_SOURCE_READ');
        },
        git: (args) =>
          args.includes('--show-toplevel')
            ? root
            : args.includes('--absolute-git-dir') || args.includes('--git-common-dir')
              ? root + '/.git'
              : 'f'.repeat(40),
      }),
    ).toThrow('IDENTITY');
    expect(migrationReads).toBe(0);
  });
  it.each(['HISTORICAL108', 'R1_PACKAGE119'] as const)(
    'refuses a mixed predecessor chain when subject-link family is%s',
    (family) => {
      const op = closedApplicationOperationFixture('subject_link_0104', family);
      const previous = closedApplicationOperationFixture(
        'game_start_0103',
        family === 'R1_PACKAGE119' ? 'HISTORICAL108' : 'R1_PACKAGE119',
      );
      const bytes = encode(previous),
        capsule = encodeApiWorkerMigrationCapsule(bytes, encode({}));
      const request = {
        ...op,
        previousMigrationSuccess: { ...op.previousMigrationSuccess!, operationSha256: hash(bytes) },
      };
      expect(() =>
        attestClosedApplicationPrevious(request, {
          secure: () => lstatSync('.'),
          read: (path) => {
            if (path.endsWith('/preparation.json')) return capsule;
            throw Error('MIXED_CHAIN_MUST_STOP_BEFORE_PROOFS');
          },
          present: () => false,
        }),
      ).toThrow('PREVIOUS_BINDING');
    },
  );
});
