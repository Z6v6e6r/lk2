import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  CLOSED_R1_CONTROLLER_FILES,
  validateClosedR1ControllerClosure,
} from './timeweb-closed-application-source.js';
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

const nativeJoinPair = [
  {
    path: 'apps/web/src/NativeGameJoin.tsx',
    oldOid: '5f0bd216b2236ad3dceb759dec01e9d56e261d36',
    newOid: '76175a62bd0a25ac281dd2ddf949f94add1106f5',
  },
  {
    path: 'apps/web/src/NativeGameJoin.test.tsx',
    oldOid: 'f428b2d54b2f88d415fa936eca66b4b6d68435a3',
    newOid: '89350edf3ad31bdef5662197b95f554ce72182c6',
  },
].map((row) => ({ ...row, status: 'M', oldMode: '100644', newMode: '100644' }));
const r1Entries = CLOSED_R1_CONTROLLER_FILES.map((path) => ({
  path,
  status: 'M',
  oldMode: '100644',
  newMode: '100644',
  oldOid: 'a'.repeat(40),
  newOid: 'b'.repeat(40),
}));
it('pins the actual reviewed native JOIN blobs outside the editable allowlist', () => {
  for (const row of nativeJoinPair) {
    expect(CLOSED_R1_CONTROLLER_FILES).not.toContain(row.path);
    const bytes = readFileSync(row.path);
    expect(
      createHash('sha1')
        .update('blob ' + bytes.length + '\0')
        .update(bytes)
        .digest('hex'),
    ).toBe(row.newOid);
  }
});
for (const validator of ['closed', 'tail'] as const) {
  function validate(entries: unknown) {
    if (validator === 'closed') return validateClosedR1ControllerClosure(entries);
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { readFileSync } from 'node:fs';
      import { validateR1TailSourceDelta } from './scripts/r1-tail-migration-source.js';
      try { validateR1TailSourceDelta(JSON.parse(readFileSync(0, 'utf8'))); console.log('PASS'); }
      catch (error) { console.log(error.message); process.exitCode = 1; }
    `,
      ],
      {
        input: JSON.stringify(entries),
        encoding: 'utf8',
        timeout: 10000,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      },
    );
    expect(result.stderr).toBe('');
    if (result.status !== 0) throw Error(result.stdout.trim());
    expect(result.stdout.trim()).toBe('PASS');
  }
  describe(`${validator} exact native JOIN prerequisite`, () => {
    it('preserves the prior source and admits only the complete reviewed pair', () => {
      expect(() => validate(r1Entries)).not.toThrow();
      expect(() => validate([...r1Entries, ...nativeJoinPair])).not.toThrow();
    });
    it.each<[string, unknown[]]>([
      ['partial component', [nativeJoinPair[0]!]],
      ['partial test', [nativeJoinPair[1]!]],
      ['duplicate component', [nativeJoinPair[0]!, nativeJoinPair[0]!]],
      ['duplicate pair', [...nativeJoinPair, ...nativeJoinPair]],
      ...[
        { oldOid: 'c'.repeat(40) },
        { newOid: 'c'.repeat(40) },
        { oldMode: '100755' },
        { newMode: '120000' },
        { status: 'A' },
        { status: 'D' },
        { status: 'R100' },
        { extra: true },
      ].map(
        (mutation) =>
          [
            JSON.stringify(mutation),
            [{ ...nativeJoinPair[0]!, ...mutation }, nativeJoinPair[1]!],
          ] as [string, unknown[]],
      ),
    ])('rejects %s', (label, rows) => {
      const code =
        validator === 'tail' && label.startsWith('duplicate')
          ? 'R1_TAIL_SOURCE_DELTA'
          : 'R1_NATIVE_JOIN';
      expect(() => validate([...r1Entries, ...rows])).toThrow(code);
    });
    it('does not admit another application path beside the reviewed pair', () => {
      expect(() =>
        validate([
          ...r1Entries,
          ...nativeJoinPair,
          { ...nativeJoinPair[0], path: 'apps/web/src/App.tsx' },
        ]),
      ).toThrow();
    });
  });
}
