import {
  EligibilityPaymentRuntimeProbeError,
  verifyEligibilityPaymentRuntimeRole,
} from './eligibility-payment-runtime-role-probe.js';

const connectionString = process.env.DATABASE_URL;
const runtimeRoleName = process.env.DATABASE_RUNTIME_ROLE;
const restoreDatabase = process.env.PHUB_RESTORE_DATABASE;
const tenantKey = process.env.ELIGIBILITY_PAYMENT_RUNTIME_TENANT_KEY;
const confirmation = process.env.ELIGIBILITY_PAYMENT_RUNTIME_PROBE_CONFIRMATION;
const matrixVersion = process.env.ELIGIBILITY_PAYMENT_ACL_MATRIX_VERSION;
const matrixSha256 = process.env.ELIGIBILITY_PAYMENT_ACL_MATRIX_SHA256;

if (
  !connectionString ||
  !runtimeRoleName ||
  !restoreDatabase ||
  !tenantKey ||
  !confirmation ||
  !matrixVersion ||
  !matrixSha256
) {
  process.stderr.write('ELIGIBILITY_PAYMENT_RUNTIME_PROBE_INPUT_INVALID\n');
  process.exitCode = 1;
} else {
  try {
    await verifyEligibilityPaymentRuntimeRole({
      connectionString,
      runtimeRoleName,
      restoreDatabase,
      tenantKey,
      confirmation,
      matrixVersion,
      matrixSha256,
    });
    process.stdout.write('ELIGIBILITY_PAYMENT_RUNTIME_RLS_READY\n');
  } catch (error) {
    const code =
      error instanceof EligibilityPaymentRuntimeProbeError ||
      error instanceof EligibilityPaymentAclMatrixError
        ? error.code
        : error instanceof Error &&
            error.message === 'ELIGIBILITY_PAYMENT_ACL_MATRIX_BINDING_INVALID'
          ? error.message
          : 'ELIGIBILITY_PAYMENT_RUNTIME_PROBE_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
import { EligibilityPaymentAclMatrixError } from '@phub/database';
