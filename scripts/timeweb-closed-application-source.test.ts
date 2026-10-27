import { describe, expect, it } from 'vitest';
import { validateClosedApplicationControllerClosure } from './timeweb-closed-application-source.js';

function closure() {
  const paths = [
    'apps/migrator/src/main.ts',
    'apps/migrator/src/migration-runner.ts',
    'apps/migrator/src/closed-single-migration.ts',
    'scripts/migrate.ts',
    'scripts/closed-schema-migration-guard.ts',
    'deploy/timeweb/closed-application-migrations-0103-0104.v1.json',
    'scripts/closed-application-migration-catalog.js',
    'scripts/closed-application-migration-acl.js',
    'scripts/timeweb-api-worker-migration.js',
    'scripts/timeweb-closed-application-profile.js',
    'scripts/timeweb-closed-application-source.js',
    'scripts/timeweb-closed-application-runtime.js',
    'scripts/timeweb-closed-application-backup.js',
    'scripts/timeweb-closed-application-controller.js',
    'scripts/control-timeweb-database-backup.py',
  ];
  return [
    ...paths.map((path) => ({
      path,
      oldMode: '000000',
      newMode: '100644',
      oldOid: '0'.repeat(40),
      newOid: 'a'.repeat(40),
      status: 'A',
    })),
    {
      path: '.github/workflows/pull-request.yaml',
      oldMode: '100644',
      newMode: '100644',
      oldOid: 'ac7b7ea78fd496cdb2caae3f42b0371741ef1465',
      newOid: 'd6fa780fb7f509abb14d1e5774ecb29e2b0719c7',
      status: 'M',
    },
  ];
}
describe('separate closed migration source enrollment', () => {
  it('requires the complete migration/controller/backup closure and exact reviewed CI patch', () => {
    const entries = closure();
    expect(validateClosedApplicationControllerClosure(entries)).toBe(entries);
    for (const entry of entries)
      expect(() =>
        validateClosedApplicationControllerClosure(entries.filter((item) => item !== entry)),
      ).toThrow();
  });
  it('refuses symlinks, mode changes, deletion, rename, duplicate paths and foreign runtime files', () => {
    const entries = closure(),
      row = entries[0]!;
    for (const changed of [
      { ...row, newMode: '120000' },
      { ...row, status: 'D', newOid: '0'.repeat(40) },
      { ...row, status: 'R100' },
      { ...row, status: 'M', oldMode: '100755' },
      { ...row, path: 'apps/api/src/main.ts' },
      { ...row, path: 'scripts/foreign-controller.js' },
    ])
      expect(() =>
        validateClosedApplicationControllerClosure([changed, ...entries.slice(1)]),
      ).toThrow();
    expect(() => validateClosedApplicationControllerClosure([...entries, row])).toThrow();
    const workflow = entries.at(-1)!;
    expect(() =>
      validateClosedApplicationControllerClosure([
        ...entries.slice(0, -1),
        { ...workflow, newOid: 'f'.repeat(40) },
      ]),
    ).toThrow('WORKFLOW');
    expect(() =>
      validateClosedApplicationControllerClosure([
        ...entries.slice(0, -1),
        { ...workflow, oldOid: 'f'.repeat(40) },
      ]),
    ).toThrow('WORKFLOW');
  });
});
