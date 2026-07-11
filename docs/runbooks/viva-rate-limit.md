# Runbook: Viva rate limiting or outage

## Signals

- rising 429/401/403 or timeout count;
- falling remaining quota and open circuit;
- sync lag or reconciliation drift;
- user requests falling back to stale data.

## Response

1. Group by tenant, operation, app version and Viva request ID.
2. Reduce background synchronization and coalesce identical reads.
3. Serve fresh local data; widen stale-local tolerance only for approved noncritical domains.
4. Keep bookings, payments, rights and other critical commands server-side and fail in a controlled way if they cannot be confirmed.
5. Enable delegated mobile reads only when Viva delegation is available, the operation is allowlisted and the feature flag has a bounded rollout.
6. Open P1 for broad Viva unavailability or queue/sync failure; P2 for isolated station/operation impact.
7. Reconcile after recovery before returning ownership modes or freshness windows to normal.

Never distribute a system API key to clients or multiply relay IPs without Viva's agreement.
