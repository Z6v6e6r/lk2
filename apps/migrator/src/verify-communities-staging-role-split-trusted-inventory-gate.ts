import { runCommunitiesStagingRoleSplitTrustedInventoryGatePreflight } from './communities-staging-role-split-trusted-inventory-gate-preflight.js';

try {
  process.stdout.write(
    await runCommunitiesStagingRoleSplitTrustedInventoryGatePreflight(process.argv.slice(2)),
  );
} catch {
  process.stderr.write('COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_GATE_PREFLIGHT_INVALID\n');
  process.exitCode = 1;
}
