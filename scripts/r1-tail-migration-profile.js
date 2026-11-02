// Exact R1 schema tail only. No operation-supplied SQL, filenames, budgets or target.
import { createHash } from 'node:crypto';
import descriptor from '../deploy/timeweb/r1-tail108-119.v1.json' with { type: 'json' };

export const R1_TAIL = Object.freeze(descriptor);
export const R1_TAIL_ARGUMENT = '--r1-tail-migrations-108-119';
export const R1_TAIL_TARGET = Object.freeze(descriptor.target);
export const R1_TAIL_OWNERS = Object.freeze({
  'notifications.intents': 'phub_beta',
  'notifications.deliveries': 'phub_migrator',
});
export const r1Hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const r1Encode = (value) => Buffer.from(JSON.stringify(value) + '\n');
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
export const r1Same = (a, b) => canonical(a) === canonical(b);
export const r1Stop = (code) => {
  throw Error(`R1_TAIL_${code}`);
};
export function r1Exact(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !r1Same(Object.keys(value).sort(), [...keys].sort())
  )
    r1Stop('SHAPE');
}
export function r1LedgerCount(rows) {
  if (!Array.isArray(rows) || rows.length < 108 || rows.length > 119) r1Stop('LEDGER');
  for (const [i, row] of rows.entries()) {
    r1Exact(row, ['filename', 'checksum']);
    if (!r1Same(row, descriptor.inventory[i])) r1Stop('LEDGER');
  }
  if (
    r1Hash(JSON.stringify(rows.map(({ filename, checksum }) => [filename, checksum])) + '\n') !==
    descriptor.checkpoints[String(rows.length)]
  )
    r1Stop('LEDGER');
  return rows.length;
}
export function r1PackagedInventory(rows) {
  if (!Array.isArray(rows) || rows.length !== 119) r1Stop('PACKAGE');
  r1LedgerCount(rows);
  return rows;
}
export function parseR1TailTarget(value) {
  r1Exact(value, [
    'databaseName',
    'systemIdentifier',
    'fromCount',
    'catalogVariant',
    'catalogsSha256',
  ]);
  if (
    value.databaseName !== R1_TAIL_TARGET.databaseName ||
    value.systemIdentifier !== R1_TAIL_TARGET.systemIdentifier ||
    !Number.isSafeInteger(value.fromCount) ||
    value.fromCount < 108 ||
    value.fromCount > 118 ||
    !['DORMANT', 'SCENARIO_EDITOR_V1'].includes(value.catalogVariant) ||
    !/^[a-f0-9]{64}$/.test(value.catalogsSha256 ?? '')
  )
    r1Stop('TARGET');
  return value;
}
// Catalog input is an independently reviewed source file, never request JSON.
export function validateR1TailCatalogs(value, bytes, expectedSha256) {
  r1Exact(value, ['schema', 'status', 'inventorySha256', 'builderSha256', 'variants']);
  if (
    value.schema !== 'PHUB_R1_TAIL_CATALOGS_V1' ||
    value.status !== 'REHEARSED_REVIEWED' ||
    value.inventorySha256 !== r1Hash(r1Encode(descriptor)) ||
    !/^[a-f0-9]{64}$/.test(value.builderSha256 ?? '') ||
    r1Hash(bytes) !== expectedSha256
  )
    r1Stop('CATALOGS_NOT_ADMITTED');
  r1Exact(value.variants, ['DORMANT', 'SCENARIO_EDITOR_V1']);
  for (const variant of Object.values(value.variants)) {
    r1Exact(
      variant,
      Array.from({ length: 12 }, (_, i) => String(i + 108)),
    );
    for (const phases of Object.values(variant)) {
      r1Exact(phases, ['prepared', 'cleaned']);
      for (const point of Object.values(phases)) {
        r1Exact(point, ['sha256', 'rowCount']);
        if (
          !/^[a-f0-9]{64}$/.test(point.sha256 ?? '') ||
          !Number.isSafeInteger(point.rowCount) ||
          point.rowCount < 1
        )
          r1Stop('CATALOG_POINT');
      }
    }
  }
  return value;
}
export function validateR1TailCatalog(rows, catalogs, variant, count, phase = 'prepared') {
  const point = catalogs?.variants?.[variant]?.[String(count)]?.[phase];
  if (!point || !Array.isArray(rows) || rows.length !== point.rowCount) r1Stop('CATALOG');
  let previous = '';
  for (const row of rows) {
    r1Exact(row, ['key', 'value']);
    if (typeof row.key !== 'string' || typeof row.value !== 'string' || row.key <= previous)
      r1Stop('CATALOG');
    previous = row.key;
  }
  if (r1Hash(r1Encode(rows)) !== point.sha256) r1Stop('CATALOG');
}
