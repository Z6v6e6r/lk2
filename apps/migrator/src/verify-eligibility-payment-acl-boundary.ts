import { EligibilityPaymentAclMatrixError } from '@phub/database';

import { verifyEligibilityPaymentAclBoundary } from './eligibility-payment-acl-boundary.js';

const connectionString = process.env.DATABASE_URL;
const runtimeRoleName = process.env.DATABASE_RUNTIME_ROLE;
const phase = process.env.ELIGIBILITY_PAYMENT_ACL_PHASE;

if (!connectionString || !runtimeRoleName || (phase !== 'pre' && phase !== 'post')) {
  process.stderr.write('ELIGIBILITY_PAYMENT_ACL_INPUT_INVALID\n');
  process.exitCode = 1;
} else {
  try {
    await verifyEligibilityPaymentAclBoundary({
      migratorConnectionString: connectionString,
      runtimeRoleName,
      phase,
    });
    process.stdout.write(`ELIGIBILITY_PAYMENT_ACL_${phase.toUpperCase()}_READY\n`);
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
