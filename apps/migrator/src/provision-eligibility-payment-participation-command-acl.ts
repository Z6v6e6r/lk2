import {
  ELIGIBILITY_PAYMENT_PARTICIPATION_COMMAND_ACL_RELATIONS,
  assertEligibilityPaymentParticipationCommandAclMatrixBinding,
} from '@phub/database';

import { provisionEligibilityPaymentAclBoundary } from './provision-eligibility-payment-acl-boundary.js';

function fail(code: string): never {
  throw new Error(code);
}

function parseDatabaseUrl(value: string | undefined, label: string): URL {
  if (!value) fail(`${label}_REQUIRED`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label}_INVALID`);
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname !== 'postgres' ||
    (parsed.port || '5432') !== '5432' ||
    parsed.search ||
    parsed.hash
  ) {
    fail(`${label}_INVALID`);
  }
  return parsed;
}

const migratorUrl = parseDatabaseUrl(process.env.DATABASE_URL, 'DATABASE_URL');
const runtimeUrl = parseDatabaseUrl(process.env.RUNTIME_DATABASE_URL, 'RUNTIME_DATABASE_URL');
let databaseName: string;
let runtimeDatabaseName: string;
let runtimeRoleName: string;
try {
  databaseName = decodeURIComponent(migratorUrl.pathname.replace(/^\//, ''));
  runtimeDatabaseName = decodeURIComponent(runtimeUrl.pathname.replace(/^\//, ''));
  runtimeRoleName = decodeURIComponent(runtimeUrl.username);
} catch {
  fail('ELIGIBILITY_PAYMENT_ACL_DATABASE_TARGET_INVALID');
}
if (
  !/^phub_restore_[0-9]+(?:_[0-9]+)+$/.test(databaseName) ||
  runtimeDatabaseName !== databaseName ||
  runtimeUrl.hostname !== migratorUrl.hostname ||
  (runtimeUrl.port || '5432') !== (migratorUrl.port || '5432') ||
  !runtimeRoleName ||
  runtimeRoleName === decodeURIComponent(migratorUrl.username)
) {
  fail('ELIGIBILITY_PAYMENT_ACL_DATABASE_TARGET_INVALID');
}
const phase = process.env.ELIGIBILITY_PAYMENT_ACL_PHASE;
if (phase !== 'pre' && phase !== 'post') fail('ELIGIBILITY_PAYMENT_ACL_PHASE_INVALID');
assertEligibilityPaymentParticipationCommandAclMatrixBinding({
  version: process.env.ELIGIBILITY_PAYMENT_ACL_MATRIX_VERSION ?? '',
  sha256: process.env.ELIGIBILITY_PAYMENT_ACL_MATRIX_SHA256 ?? '',
});

await provisionEligibilityPaymentAclBoundary({
  migratorConnectionString: migratorUrl.toString(),
  runtimeRoleName,
  phase,
  expectedRelations: ELIGIBILITY_PAYMENT_PARTICIPATION_COMMAND_ACL_RELATIONS,
});
process.stdout.write(`ELIGIBILITY_PAYMENT_ACL_${phase.toUpperCase()}_PROVISIONED\n`);
