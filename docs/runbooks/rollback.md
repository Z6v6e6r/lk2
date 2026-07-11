# Runbook: application rollback

1. Declare the incident and stop concurrent deployments.
2. Record release, environment, tenant impact and correlation IDs.
3. Select the last known-good **digest**, never a mutable tag.
4. Confirm the expanded database schema remains backward-compatible.
5. Remove app node A from the load balancer, deploy the previous digest, wait for readiness and run smoke tests.
6. Return A to traffic and repeat for node B.
7. Roll workers back only after checking event compatibility and queue lag.
8. Mark the rollback in observability, verify error/business-invariant recovery and close the alert only after a soak period.

Do not reverse a database migration as the first response. Escalate if the old binary is incompatible with current data.
