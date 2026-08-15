# Community member-count reconciliation

## Safety boundary

The member count is a rebuildable read projection. Never use it for authorization. Canonical
membership status in `communities.memberships` remains authoritative.

Migration 0066 is expand-only. The worker creates missing projection rows, processes at most 250
members per community batch and stores its cursor in PostgreSQL. It revisits up to ten communities
per minute and rechecks a READY projection after 24 hours. These are initial bounded worker
settings, not proof of production capacity.

## Rollout

1. Apply migration 0066 with the migrator while reads still permit canonical fallback.
2. Deploy worker and verify the `phub.community-member-count-projector.v1` quorum consumer.
3. Observe:
   - `phub.worker.communities.member_count.building`;
   - `phub.worker.communities.member_count.stale`;
   - `phub.worker.communities.member_count.not_ready_age_seconds`;
   - general outbox age and DLQ depth.
4. Compare every projection to canonical ACTIVE counts on the staging synthetic tenant. Any drift
   is a failed gate; do not overwrite rows manually.
5. Run `npm run communities:load` on an isolated `*_verify` database and the worker/broker failure
   soak on the exact candidate digest.
6. Permit a permanent O(1) read cutover only after 100% of active communities are READY, STALE is
   zero and restart/redelivery produces zero drift.

## Recovery

- `BUILDING`: allow the worker to resume from `reconciliation_cursor`; reads use canonical
  fallback during the expand phase.
- `STALE`: inspect worker error/DLQ and lock-wait metrics. The next bounded cycle starts a new pass.
- prolonged not-ready age: keep the read cutover disabled, correct the worker or broker cause and
  rerun reconciliation. Do not substitute Redis or a manually edited total.

Rollback of the application keeps canonical reads available. Projection tables are disposable,
but dropping them is a later contract migration and is not part of an incident rollback.
