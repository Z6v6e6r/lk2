# R1 — post119 runtime admission and recovery

Status: **NO-GO for application activation**. This is an evidence-based source audit, not an executable deployment plan. It supersedes the earlier local claim that the initial-beta renderer is sufficient for an existing-beta upgrade.

Audit source: LK2 `b1c32748451af4e79e73421d98db35eec076ba38` (PR569 merged), with migration/artifact custody frozen separately at `b88f2100e0d77b8c3bbb3a75ced70f2fd97dcefd`. Source reads and two independent specialist analyses were performed on 2026-11-03 MSK. No fresh production database, broker, role or component acceptance was performed for this audit.

## Critical path

1. Fresh Timeweb metadata was approved and captured. R1 recovered; R2 proved unexecuted; R3 stopped during dependency installation because npm received the same user/global config path. Guarded R3 recovery restored old source/config and released its marker; original deliverytrue restored06:24:31UTC. Fixed R4 is locally prepared and reviewed, not executed. See [current operations](R1-OPERATIONS-20261103.md).
2. Complete newly admitted b88 enrollment, verified backup/independent restore, and closed migration chain106 →107 →108 →119. Retain all R1/R2/R3 packets and the partial stage; never replay their execute. Preserve b88 source proof, publication41506910421, canonical manifest and intermediate receipts. Main advancement does not replace these inputs.
3. After cleaned119 success, separately verify application role privileges and tenant isolation for the actual API/Worker connections. Apply only a separately reviewed, exact missing-privilege plan, then recheck. Do not alter migration SQL, golden catalog or historical allowlists to hide a missing application grant.
4. Complete an existing critical executor's fixed four-service upgrade/recovery profile. Bind all actual previous API/Web/Worker/Realtime identities, preserved secret-set lineage and runtime gates. Initial-install rendering and chained pair upgrades do not provide this recovery contract.
5. Freeze the final reviewed source and successful main CI, publish one matching application image set and canonical manifest, then admit the exact application operation. Keep this application artifact separate from the b88 migration tuple.
6. Perform component readiness, mixed-version recovery and mandatory user journeys only in the admitted environment. Source/CI, publication, migration and runtime acceptance remain distinct evidence.

CUP first-restart custody and LK monthly effective binding are parallel prerequisites. Attributable Viva settlement/visit-return and final provider acceptance remain separate blockers. Mobile signing/store execution is deferred by the owner.

## Why the initial-beta renderer is insufficient

`render-timeweb-beta-release-env.js` rejects `previousReleaseId` other than `NONE`, and its CLI supplies `NONE`. Its output uses `stop-candidate-no-previous-release`. The shared runtime-secret marker must equal the new release ID. Its Compose-stage path checks source/artifact/env, but does not seal previous component identities or provide an upgrade journal and restoration mapping.

For an already running mixed-source beta, stopping the candidate does not restore the previous services. Relabelling an existing secret marker is not a valid workaround. The canonical artifact validator and frozen-source custody checker can be reused; the initial-install execution contract cannot serve as proof of a safe upgrade.

The existing API/Worker executor is the smallest suitable basis: it already has durable capsule/journal, shared lock, Worker containment, DB fence, preserved-secret mode and recovery around delivery-gate release. It currently excludes Web and Realtime from its target pair. The API/Web executor excludes Worker/Realtime. Chaining them does not create a single four-component rollback scope.

A bounded extension should use an explicit fixed R1 schema/profile with four target slots, durable activation intents, per-component health, complete previous identity restoration and an honest installed-component descriptor. It must preserve historical pair profiles and migration source closure. It must not turn a mixed installed descriptor into a fabricated canonical publication manifest.

Before implementation/execution scope can be fixed, obtain actual previous component/image/config custody, application roles, provider gates, backup/restore and new-state recovery constraints. No new executor, controller enrollment or live upgrade is delivered by this audit.

## Runtime grants after119

Ledger108 →119 applies SQL0105–0115. SQL0103–0115 contains no `GRANT`, `REVOKE` or `ALTER DEFAULT PRIVILEGES`. `R1_TAIL_SAFE_ROLES_SQL` rejects migrator default table grants to nonowners in the affected tail schemas. Cleanup restores the privilege preimage; it does not provision application rights.

The admitted tail therefore does not supply runtime DML privileges on these14 new tables:

| Schema        | Tables                                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| integration   | game_create_location_bindings                                                                                                                                               |
| games         | managed_self_leave_attempts, managed_self_leave_command_links, quarter_create_attempts                                                                                      |
| booking       | training_registration_attempts, tournament_local_attempts                                                                                                                   |
| notifications | station_message_sources, station_message_facts, station_message_recipient_outbox; tournament_message_sources, tournament_message_facts, tournament_message_recipient_outbox |
| commerce      | monthly_purchase_attempts, monthly_purchase_launches                                                                                                                        |

These tables have ENABLE/FORCE RLS and tenant policies. RLS policies do not grant SQL access. Read the exact relation names from the frozen catalog before preparing an operational plan; this audit is not grant SQL.

`identity.external_subject_link_commands` from0104 is a separate case: identity default privileges are outside that tail restriction, so actual inherited rights are UNKNOWN until read back. Do not infer its privileges from the14-table result.

Acceptance must bind actual connection roles, schema USAGE, table/column rights, owners, FORCE RLS and cross-tenant negative cases. Include row-lock dependencies: `SELECT ... FOR SHARE/UPDATE` also requires UPDATE privilege. The station domain contract already documents SELECT+UPDATE on parent identity/integration relations. Disabled new admissions do not prove retained journal/status reads avoid new tables.

Existing evidence to reuse: `apps/migrator/src/r1-tail-migration.pg.test.ts` checks restricted migrator, prefixes, ACL cleanup and119 golden; station/tournament notification PostgreSQL tests check restricted ordinary writers and RLS; quarter/training/tournament/monthly database tests check consumer transactions. Their synthetic grants are not production grant evidence. The b88 migration CI7/7 is not a full old-binary-on119 rollback test.

## Realtime compatibility and startup

The complete `apps/realtime` source, auth package, messaging authorization repositories, community event schema/types and Worker outbox-event-publisher are unchanged702 →b88. Source review found no changed ticket scope, event envelope, routing key or authorization SQL that demonstrates a mixed-version protocol break. This does not prove runtime equivalence: the reachable OTel dependency closure includes the `systeminformation`5.31.16 →5.33.16 update, shared barrels expand, and observability adds launch-code redaction.

Even with Communities realtime disabled, the messaging consumer declares `phub.events`, durable `phub.realtime.messaging.quarantine.v1`, an exclusive auto-delete queue and the messaging binding, then consumes. Invalid events may be published to quarantine with confirm and ACKed. Starting this process has broker side effects.

Before startup verify the exact broker/vhost/principal, exchange/queue properties, policies/bindings/permissions, connection and consumer baseline, dedicated ticket secret/issuer/audience, Redis and PostgreSQL identity/role, replica count, retained previous image/env, and recovery mapping. Do not enable Communities as an incidental deploy change. After startup require dependency-aware readiness including Rabbit consumer readiness; HTTP liveness alone is insufficient.

Realtime notifications are hints. Its queue is ephemeral and restart can lose hints. Messaging keeps a process-local processed-event cache bounded to10000 IDs; Communities uses process-local per-community sequence watermarks. Canonical HTTP recovery remains required; messaging exposes `conversation.gap` with `recovery:HTTP`. Do not claim durable delivery from this transport.

Existing acceptance targets are the Realtime app/consumer/Rabbit registration/reconnect tests, config isolation tests, messaging PostgreSQL concurrency tests and the direct-chat realtime E2E harness. The latter makes HTTP mutations and enforces APP_ENV local/ci, loopback PostgreSQL/Rabbit *_verify targets and a nonzero Redis database. It may run only in an owned isolated LOCAL/CI fixture. Admitted-runtime journeys need a separately scoped compatible mechanism; admission does not make this harness valid for staging/production.

## Rollback limits

The migration changes are additive; ordinary NULL-context notification paths have restricted-writer tests. Old702 FCM claims only PENDING/SENDING, leaving new station/tournament states parked. These are source compatibility properties, not proof of a complete rollback under actual119 data and privileges.

After new provider-visible work, restoring the previous per-component images (API/Worker/Realtime702, Web871) may remove needed original-operation recovery. Preserve journals, dispatch markers, notification holds and any compatible recovery API. Never down-migrate or convert new delivery states to manufacture compatibility. The exact plan must define containment, per-component restoration, retained new-state recovery, and the point beyond which only forward reconciliation is safe.

No publication, host checkout, secret/ACL change, DB write, broker operation, provider action, restart or deployment was performed for this audit.
