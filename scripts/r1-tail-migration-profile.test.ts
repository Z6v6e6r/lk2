import releaseSchema from '../deploy/timeweb/release-manifest.schema.json';
import { closedApplicationOperationFixture } from './timeweb-closed-application.fixture.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import descriptor from '../deploy/timeweb/r1-tail108-119.v1.json';
import reviewed from '../deploy/timeweb/r1-tail108-119-catalogs.v1.json';
import { R1_TAIL_CATALOG_SQL, R1_TAIL_TABLES } from './r1-tail-migration-catalog.js';
import {
  parseR1TailTarget,
  r1Encode,
  r1Hash,
  r1LedgerCount,
  r1PackagedInventory,
  validateR1TailCatalogs,
} from './r1-tail-migration-profile.js';

describe('fixed R1 tail inventory and admission', () => {
  it('pins119 actual SQL bytes and all12 exact full prefixes', async () => {
    const directory = resolve('packages/database/migrations');
    const actual = await Promise.all(
      (await readdir(directory))
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map(async (filename) => ({
          filename,
          checksum: createHash('sha256')
            .update(await readFile(resolve(directory, filename)))
            .digest('hex'),
        })),
    );
    // The released R1 tail stays byte-frozen at ledger 119. Later additive migrations are admitted
    // only through this explicit post-119 review list, never by editing the release inventory.
    const frozen = actual.slice(0, descriptor.inventory.length);
    expect(frozen).toEqual(descriptor.inventory);
    expect(actual.slice(descriptor.inventory.length).map(({ filename }) => filename)).toEqual([
      '0116_profile_provider_observations.sql',
    ]);
    expect(r1PackagedInventory(frozen)).toEqual(frozen);
    expect(r1LedgerCount(frozen.map(({ filename, checksum }) => ({ checksum, filename })))).toBe(
      119,
    );
    for (let count = 108; count <= 119; count++)
      expect(r1LedgerCount(frozen.slice(0, count))).toBe(count);
    for (const bad of [
      frozen.slice(0, 107),
      frozen.slice(1),
      [...frozen].reverse(),
      frozen.map((row, i) => (i === 110 ? { ...row, checksum: 'a'.repeat(64) } : row)),
      [...frozen, { filename: '0117_unreviewed.sql', checksum: 'a'.repeat(64) }],
    ])
      expect(() => r1LedgerCount(bad)).toThrow('R1_TAIL_LEDGER');
  });
  it('rejects SQL/target/budget selection and unreviewed golden catalogs', () => {
    const target = {
      databaseName: 'phub_beta',
      systemIdentifier: '7679125609183186977',
      fromCount: 108,
      catalogVariant: 'DORMANT',
      catalogsSha256: 'a'.repeat(64),
    };
    expect(parseR1TailTarget(target)).toEqual(target);
    for (const bad of [
      { ...target, fromCount: 107 },
      { ...target, fromCount: 119 },
      { ...target, systemIdentifier: 'wrong' },
      { ...target, sql: 'select 1' },
      { ...target, statementMs: 0 },
      { ...target, catalogVariant: 'AUTO' },
    ])
      expect(() => parseR1TailTarget(bad)).toThrow();
    expect(
      validateR1TailCatalogs(reviewed, r1Encode(reviewed), r1Hash(r1Encode(reviewed))),
    ).toEqual(reviewed);
    expect(reviewed.builderSha256).toBe(r1Hash(R1_TAIL_CATALOG_SQL));
    for (const status of ['UNREHEARSED', 'REHEARSED_UNREVIEWED']) {
      const unreviewed = { ...reviewed, status };
      expect(() =>
        validateR1TailCatalogs(unreviewed, r1Encode(unreviewed), r1Hash(r1Encode(unreviewed))),
      ).toThrow('R1_TAIL_CATALOGS_NOT_ADMITTED');
    }
  });
  it('serializes exact changed relations, parent ACLs and attached trigger definitions', () => {
    expect(R1_TAIL_TABLES).toContain('notifications.intents');
    expect(R1_TAIL_TABLES).toContain('notifications.deliveries');
    expect(R1_TAIL_TABLES).toContain('commerce.monthly_purchase_attempts');
    expect(R1_TAIL_CATALOG_SQL).toContain('true as fresh');
    expect(R1_TAIL_CATALOG_SQL).toContain('tr.tgfoid=p.oid');
    expect(R1_TAIL_CATALOG_SQL).toContain('securityDefiner');
    expect(R1_TAIL_CATALOG_SQL).toContain('nullsNotDistinct');
  });
});

describe('R1 tail publication manifest contract', () => {
  const operation = closedApplicationOperationFixture('game_start_0103');
  const image = operation.publishedMigrator;
  const manifest = {
    schemaVersion: 'PHUB_TIMEWEB_RELEASE_MANIFEST_V2',
    gitCommit: operation.controllerSha,
    gitTree: operation.controllerTree,
    publication: {
      runId: image.publicationRunId,
      runAttempt: releaseSchema.properties.publication.properties.runAttempt.const,
    },
    images: [
      {
        component: 'migrator',
        digest: image.image.split('@')[1],
        runtimeDigest: image.imageId,
        revision: operation.controllerSha,
      },
    ],
  };
  function validateBytes(op: unknown, bytes: Buffer): unknown {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { readFileSync } from 'node:fs';
      import { validateR1TailPublicationManifest } from './scripts/r1-tail-migration-runtime.js';
      const { operation, text } = JSON.parse(readFileSync(0, 'utf8'));
      try { console.log(JSON.stringify({ value: validateR1TailPublicationManifest(operation, Buffer.from(text)) })); }
      catch { console.log(JSON.stringify({ error: 'MANIFEST' })); }
    `,
      ],
      {
        input: JSON.stringify({ operation: op, text: bytes.toString('utf8') }),
        encoding: 'utf8',
        timeout: 10000,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout) as { value?: unknown; error?: string };
    if (parsed.error) throw Error(parsed.error);
    return parsed.value;
  }
  function validate(value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value));
    return validateBytes(
      {
        ...operation,
        publishedMigrator: {
          ...image,
          manifestSha256: createHash('sha256').update(bytes).digest('hex'),
        },
      },
      bytes,
    );
  }
  it('accepts the canonical V2 first-attempt string without changing artifact bytes', () => {
    expect(manifest.publication.runAttempt).toBe('1');
    expect(validate(manifest)).toEqual(manifest);
  });
  it.each([1, 2, '2', '01', '1.0', true, null, ['1']])(
    'rejects noncanonical attempt %j',
    (runAttempt) => {
      expect(() =>
        validate({ ...manifest, publication: { ...manifest.publication, runAttempt } }),
      ).toThrow('MANIFEST');
    },
  );
  it('retains source, digest and artifact-byte integrity checks', () => {
    for (const invalid of [
      { ...manifest, gitCommit: 'f'.repeat(40) },
      { ...manifest, gitTree: 'f'.repeat(40) },
      { ...manifest, publication: { ...manifest.publication, runId: '999' } },
      { ...manifest, images: [] },
      { ...manifest, images: [...manifest.images, ...manifest.images] },
      {
        ...manifest,
        images: [{ ...manifest.images[0], runtimeDigest: 'sha256:' + 'f'.repeat(64) }],
      },
    ])
      expect(() => validate(invalid)).toThrow('MANIFEST');
    expect(() => validateBytes(operation, Buffer.from(JSON.stringify(manifest)))).toThrow(
      'MANIFEST',
    );
  }, 30_000);
});
