import { EligibilityPaymentAclMatrixError } from '@phub/database';

import {
  EligibilityPaymentAclProvisionError,
  provisionEligibilityPaymentAcl,
} from './eligibility-payment-acl-provisioner.js';

const connectionString = process.env.DATABASE_URL;
const runtimeRoleName = process.env.DATABASE_RUNTIME_ROLE;
const restoreDatabase = process.env.PHUB_RESTORE_DATABASE;
const confirmation = process.env.ELIGIBILITY_PAYMENT_ACL_PROVISION_CONFIRMATION;
const matrixVersion = process.env.ELIGIBILITY_PAYMENT_ACL_MATRIX_VERSION;
const matrixSha256 = process.env.ELIGIBILITY_PAYMENT_ACL_MATRIX_SHA256;

if (
  !connectionString ||
  !runtimeRoleName ||
  !restoreDatabase ||
  !confirmation ||
  !matrixVersion ||
  !matrixSha256
) {
  process.stderr.write('ELIGIBILITY_PAYMENT_ACL_PROVISION_INPUT_INVALID\n');
  process.exitCode = 1;
} else {
  try {
    await provisionEligibilityPaymentAcl({
      connectionString,
      runtimeRoleName,
      restoreDatabase,
      confirmation,
      matrixVersion,
      matrixSha256,
    });
    process.stdout.write('ELIGIBILITY_PAYMENT_ACL_PROVISIONED\n');
  } catch (error) {
    const code =
      error instanceof EligibilityPaymentAclProvisionError ||
      error instanceof EligibilityPaymentAclMatrixError
        ? error.code
        : error instanceof Error &&
            error.message === 'ELIGIBILITY_PAYMENT_ACL_MATRIX_BINDING_INVALID'
          ? error.message
          : 'ELIGIBILITY_PAYMENT_ACL_PROVISION_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
