import {
  ELIGIBILITY_PAYMENT_ACL_RELATIONS,
  ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_RELATIONS,
  ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_MATRIX_SHA256,
  ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_MATRIX_VERSION,
  ELIGIBILITY_PAYMENT_PARTICIPATION_COMMAND_ACL_MATRIX_SHA256,
  ELIGIBILITY_PAYMENT_PARTICIPATION_COMMAND_ACL_MATRIX_VERSION,
  ELIGIBILITY_PAYMENT_PARTICIPATION_COMMAND_ACL_RELATIONS,
  EligibilityPaymentAclMatrixError,
  assertEligibilityPaymentCupProjectionAclMatrixBinding,
  assertEligibilityPaymentParticipationCommandAclMatrixBinding,
} from '@phub/database';

import { verifyEligibilityPaymentAclBoundary } from './eligibility-payment-acl-boundary.js';

const connectionString = process.env.DATABASE_URL;
const runtimeRoleName = process.env.DATABASE_RUNTIME_ROLE;
const phase = process.env.ELIGIBILITY_PAYMENT_ACL_PHASE;
const matrixVersion = process.env.ELIGIBILITY_PAYMENT_ACL_MATRIX_VERSION;
const matrixSha256 = process.env.ELIGIBILITY_PAYMENT_ACL_MATRIX_SHA256;

if (
  !connectionString ||
  !runtimeRoleName ||
  (phase !== 'pre' && phase !== 'post') ||
  (matrixVersion === undefined) !== (matrixSha256 === undefined)
) {
  process.stderr.write('ELIGIBILITY_PAYMENT_ACL_INPUT_INVALID\n');
  process.exitCode = 1;
} else {
  try {
    const expectedRelations = matrixVersion
      ? matrixVersion === ELIGIBILITY_PAYMENT_PARTICIPATION_COMMAND_ACL_MATRIX_VERSION
        ? (() => {
            assertEligibilityPaymentParticipationCommandAclMatrixBinding({
              version: matrixVersion,
              sha256: matrixSha256 ?? '',
            });
            return ELIGIBILITY_PAYMENT_PARTICIPATION_COMMAND_ACL_RELATIONS;
          })()
        : (() => {
            assertEligibilityPaymentCupProjectionAclMatrixBinding({
              version: matrixVersion,
              sha256: matrixSha256 ?? '',
            });
            return ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_RELATIONS;
          })()
      : ELIGIBILITY_PAYMENT_ACL_RELATIONS;
    await verifyEligibilityPaymentAclBoundary({
      migratorConnectionString: connectionString,
      runtimeRoleName,
      phase,
      expectedRelations,
    });
    const matrix = matrixVersion
      ? matrixVersion === ELIGIBILITY_PAYMENT_PARTICIPATION_COMMAND_ACL_MATRIX_VERSION
        ? `${ELIGIBILITY_PAYMENT_PARTICIPATION_COMMAND_ACL_MATRIX_VERSION}:${ELIGIBILITY_PAYMENT_PARTICIPATION_COMMAND_ACL_MATRIX_SHA256}`
        : `${ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_MATRIX_VERSION}:${ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_MATRIX_SHA256}`
      : 'eligibility-payment-acl-v1';
    process.stdout.write(`ELIGIBILITY_PAYMENT_ACL_${phase.toUpperCase()}_READY matrix=${matrix}\n`);
  } catch (error) {
    const code =
      error instanceof EligibilityPaymentAclMatrixError
        ? error.code
        : error instanceof Error && error.message === 'ELIGIBILITY_PAYMENT_ACL_RUNTIME_ROLE_INVALID'
          ? error.message
          : 'ELIGIBILITY_PAYMENT_ACL_VERIFY_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
