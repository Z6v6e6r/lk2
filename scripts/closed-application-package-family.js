// Explicit package family only; never infer admission from observed SQL/ledger length.
import { createHash } from 'node:crypto';
import historical from '../deploy/timeweb/closed-application-migrations-0103-0104.v1.json' with { type: 'json' };
import r1 from '../deploy/timeweb/closed-application-prefix108-package119.v1.json' with { type: 'json' };
import inventory from '../deploy/timeweb/r1-tail108-119.v1.json' with { type: 'json' };
export const CLOSED_R1_OPERATION_SCHEMAS = Object.freeze({
  game_start_0103: 'PHUB_TIMEWEB_R1_GAME_START_0103_MIGRATION_OPERATION_V1',
  subject_link_0104: 'PHUB_TIMEWEB_R1_SUBJECT_LINK_0104_MIGRATION_OPERATION_V1',
});
const oldSchemas = {
  game_start_0103: 'PHUB_TIMEWEB_GAME_START_0103_MIGRATION_OPERATION_V1',
  subject_link_0104: 'PHUB_TIMEWEB_SUBJECT_LINK_0104_MIGRATION_OPERATION_V1',
};
export const CLOSED_R1_ARGUMENTS = Object.freeze({
  '--r1-game-start-migration-0103': 'game_start_0103',
  '--r1-subject-link-migration-0104': 'subject_link_0104',
});
const oldArguments = {
  game_start_0103: '--game-start-migration-0103',
  subject_link_0104: '--subject-link-migration-0104',
};
const fail = (code) => {
  throw Error('CLOSED_APPLICATION_PACKAGE_' + code);
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function closedApplicationPackageFamily(operation) {
  const kind = operation?.migrationProfile;
  if (!Object.hasOwn(oldSchemas, kind ?? '')) fail('KIND');
  if (operation.schema === oldSchemas[kind]) return 'HISTORICAL108';
  if (operation.schema === CLOSED_R1_OPERATION_SCHEMAS[kind]) return 'R1_PACKAGE119';
  return fail('SCHEMA');
}
export function closedApplicationPackageDescriptor(operation) {
  return closedApplicationPackageFamily(operation) === 'R1_PACKAGE119' ? r1 : historical;
}
export function closedApplicationDescriptorPath(operation) {
  return closedApplicationPackageFamily(operation) === 'R1_PACKAGE119'
    ? 'deploy/timeweb/closed-application-prefix108-package119.v1.json'
    : 'deploy/timeweb/closed-application-migrations-0103-0104.v1.json';
}
export function closedApplicationPackageArgument(operation) {
  if (closedApplicationPackageFamily(operation) === 'HISTORICAL108')
    return oldArguments[operation.migrationProfile];
  return Object.entries(CLOSED_R1_ARGUMENTS).find(
    ([, kind]) => kind === operation.migrationProfile,
  )[0];
}
export function assertClosedR1Descriptor() {
  if (
    r1.schema !== 'PHUB_CLOSED_APPLICATION_PREFIX108_PACKAGE119_V1' ||
    r1.packagedCount !== 119 ||
    r1.prefixCount !== 108 ||
    r1.prefixLedgerSha256 !== historical.packagedLedgerSha256 ||
    r1.packagedLedgerSha256 !== inventory.checkpoints['119'] ||
    JSON.stringify(r1.profiles) !== JSON.stringify(historical.profiles) ||
    JSON.stringify(r1.checkpoints) !== JSON.stringify(historical.checkpoints)
  )
    fail('DESCRIPTOR');
  return r1;
}
export function assertClosedR1PackagedCatalog(packaged) {
  assertClosedR1Descriptor();
  if (!Array.isArray(packaged) || packaged.length !== 119) fail('SOURCE_CATALOG');
  for (let i = 0; i < 119; i++)
    if (
      packaged[i]?.filename !== inventory.inventory[i].filename ||
      packaged[i]?.checksum !== inventory.inventory[i].checksum
    )
      fail('SOURCE_CATALOG');
  const digest = (rows) =>
    hash(JSON.stringify(rows.map((row) => [row.filename, row.checksum])) + '\n');
  if (
    digest(packaged) !== r1.packagedLedgerSha256 ||
    digest(packaged.slice(0, 108)) !== r1.prefixLedgerSha256
  )
    fail('SOURCE_PREFIX');
}
