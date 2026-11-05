import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  CLOSED_R1_CONTROLLER_FILES,
  validateClosedR1ControllerClosure,
} from './timeweb-closed-application-source.js';
import { validateClosedApplicationControllerClosure } from './timeweb-closed-application-source.js';
import { parseApiWorkerControllerDiff } from './timeweb-api-worker-upgrade.js';

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
const phonePair = [
  {
    path: 'apps/web/src/CreateGamePage.tsx',
    oldOid: '96db2b6e8d65a1f7ba48ff18e6055bebb882bc66',
    newOid: '8ff52b8b1170396f8e3cc48d6d5fd4c543b1a0eb',
  },
  {
    path: 'apps/web/src/TrainingsPage.test.tsx',
    oldOid: '208f0c772b76f9d9a89b1cfeefd9071cb7595f62',
    newOid: 'a40331a45324f83fa6141ccad991d4338b24d053',
  },
].map((row) => ({ ...row, status: 'M', oldMode: '100644', newMode: '100644' }));
it('pins the already merged phone route and training test blobs', () => {
  for (const row of phonePair) {
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
const join60Group = [
  {
    path: 'apps/api/src/games/game-commercial-join.test.ts',
    oldOid: '6350c1d9d1e213a02351327e372c11ef930b1d88',
    newOid: '23fa1a6b8fd83042645ef82d96dc2329942dd34d',
  },
  {
    path: 'apps/api/src/games/game-join-conditions-owner.ts',
    oldOid: '3ea378e81b3ab71cb263e0f1b9fc14d0a3650ef0',
    newOid: 'bae4a56b46088d9445f30a0956406832e65f3c24',
  },
  {
    path: 'apps/api/src/games/game-join-conditions-resolver.test.ts',
    oldOid: '6ae655278baadea2c9cbcaeca30894c047f88c4e',
    newOid: '4d810ff830dd5d03adf1e083e253a6458e8312f7',
  },
  {
    path: 'apps/api/src/games/game-join-conditions.test-fixture.ts',
    oldOid: '4af7f33ddf6a193e5b57440d920582081e4f6436',
    newOid: '3b93df7f80095bea1542922b8bfd9eb2588f71fd',
  },
  {
    path: 'apps/api/src/games/game-join-conditions.test.ts',
    oldOid: '020305559f9a351f50db8c4eb22cbf7f96d364bd',
    newOid: '2dd7c344ad9f929495d1f1e50e47d5c2b639b0ac',
  },
  {
    path: 'apps/api/src/games/game-join-conditions.ts',
    oldOid: 'fcedef03338f747145d08ac0796f0440d73e885a',
    newOid: 'f8c9e62ec57ca639bd8ad33f8b4f3fd09f997fa9',
  },
  {
    path: 'docs/contracts/game-join-conditions.md',
    oldOid: 'b5009d30579e65caef133116bfb2f58cd2b0be36',
    newOid: 'af199d739153277becdbca1df6c0499108ed0d4f',
  },
  {
    path: 'packages/database/src/game-join-conditions-context-repository.ts',
    oldOid: 'e4b084d60905099f1babdae0915f6cc6c8ed08ef',
    newOid: '2945dc681ee0eca5e9a6df8ed5a2f77fb21bd3a3',
  },
  {
    path: 'packages/viva-adapter/src/game-subscription-selection.ts',
    oldOid: 'd3f3518ade36ffc400c5ea7e1fe8064d5f52ba7f',
    newOid: '055441ccc3363db241af1d378eadc3c23f5e62dd',
  },
  {
    path: 'apps/api/src/games/game-commercial-join-runtime.test.ts',
    oldOid: 'c5a7bbc5fd82da33a84044bb48ffef0fea6a158c',
    newOid: '27471920361d91db421106a33e450823cd8bf438',
  },
].map((row) => ({ ...row, status: 'M', oldMode: '100644', newMode: '100644' }));
it('pins JOIN60 runtime, tests and contract without an editable app allowlist', () => {
  for (const row of join60Group) {
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
  describe(`${validator} exact JOIN60 prerequisite`, () => {
    it('preserves prior admission and accepts the complete fixed group', () => {
      expect(() => validate([...r1Entries, ...nativeJoinPair, ...phonePair])).not.toThrow();
      expect(() =>
        validate([...r1Entries, ...nativeJoinPair, ...phonePair, ...join60Group]),
      ).not.toThrow();
    });
    it.each(join60Group.map((row) => [row.path]))('rejects missing %s', (path) => {
      expect(() =>
        validate([...r1Entries, ...join60Group.filter((row) => row.path !== path)]),
      ).toThrow();
    });
    it.each([
      { oldOid: 'c'.repeat(40) },
      { newOid: 'c'.repeat(40) },
      { oldMode: '100755' },
      { newMode: '120000' },
      { newMode: '100755' },
      { status: 'A' },
      { status: 'D' },
      { status: 'R100' },
      { extra: true },
    ])('rejects mutated JOIN60 row %j', (change) => {
      expect(() =>
        validate([...r1Entries, { ...join60Group[0], ...change }, ...join60Group.slice(1)]),
      ).toThrow();
    });
    it('rejects duplicate and unrelated sibling paths', () => {
      expect(() => validate([...r1Entries, ...join60Group, join60Group[0]])).toThrow();
      expect(() =>
        validate([
          ...r1Entries,
          ...join60Group,
          { ...join60Group[0], path: 'apps/api/src/games/unreviewed.ts' },
        ]),
      ).toThrow();
    });
  });
  describe(`${validator} exact native JOIN prerequisite`, () => {
    for (const path of [
      'scripts/timeweb-api-worker-migration.d.ts',
      'scripts/timeweb-closed-application-profile.d.ts',
      'scripts/closed-application-migration-acl.js',
      'scripts/closed-application-migration-acl.d.ts',
      'scripts/closed-application-migration-acl.test.ts',
    ]) {
      it(`admits the named regular generation declaration ${path}`, () => {
        expect(CLOSED_R1_CONTROLLER_FILES).toContain(path);
        expect(() => validate(r1Entries)).not.toThrow();
      });
      it.each([
        { newMode: '120000' },
        { newMode: '100755' },
        { status: 'D', newOid: '0'.repeat(40) },
        { path: 'scripts/foreign-controller.d.ts' },
      ])(`rejects unsafe declaration change for ${path}: %j`, (change) => {
        const row = r1Entries.find((entry) => entry.path === path)!;
        expect(() =>
          validate(r1Entries.map((entry) => (entry === row ? { ...entry, ...change } : entry))),
        ).toThrow();
      });
    }
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
  describe(`${validator} current R1 phone prerequisites`, () => {
    it('preserves prior admission and accepts the exact complete phone pair', () => {
      expect(() => validate([...r1Entries, ...nativeJoinPair])).not.toThrow();
      expect(() => validate([...r1Entries, ...nativeJoinPair, ...phonePair])).not.toThrow();
    });
    it('admits the actual committed source closure', () => {
      const result = spawnSync(
        '/usr/bin/git',
        [
          'diff',
          '--no-renames',
          '--raw',
          '--abbrev=40',
          '-z',
          '27d8527f2f36e1a647012a86f92f4a51b9dd50eb',
          'HEAD',
        ],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(0);
      expect(() => validate(parseApiWorkerControllerDiff(result.stdout))).not.toThrow();
    });
    it.each(
      [
        [phonePair[0]!],
        [phonePair[1]!],
        [...phonePair, phonePair[0]!],
        ...[
          { oldOid: 'd'.repeat(40) },
          { newOid: 'd'.repeat(40) },
          { oldMode: '100755' },
          { newMode: '120000' },
          { status: 'A' },
          { status: 'D' },
          { status: 'R100' },
          { extra: true },
        ].map((mutation) => [{ ...phonePair[0]!, ...mutation }, phonePair[1]!]),
      ].map((rows, index) => [index, rows] as const),
    )('rejects altered phone prerequisite %s', (_index, rows) => {
      expect(() => validate([...r1Entries, ...rows])).toThrow();
    });
    it('admits only listed regular markdown evidence, not executable or foreign docs', () => {
      const base = r1Entries.filter((row) => !row.path.startsWith('docs/release/'));
      const report = r1Entries.find((row) => row.path === 'docs/release/R1-READINESS.md')!;
      expect(() => validate([...base, report])).not.toThrow();
      for (const mutation of [
        { newMode: '100755' },
        { newMode: '120000' },
        { status: 'D' },
        { path: 'docs/release/R1-READINESS.js' },
        { path: 'docs/release/UNRELATED.md' },
      ])
        expect(() => validate([...base, { ...report, ...mutation }])).toThrow();
    });
  });
}
