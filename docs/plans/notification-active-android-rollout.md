# Notification rollout while preserving the existing Android channel

Scope: prepare an immutable V3 controller/Worker change. No merge, publication, enrollment,
provider/tenant mutation or live activation is authorized by this document. V2 remains strict-zero.
The failed CCC attempt stopped before its first durable rollout member; its window was safely
closed on 2026-10-25T19:11Z. Current 8158 runtime and schema 105/backups remain in place.

V3 retains normal candidate==controller source/CI authority. It does not extend the old
controllerPromotion profile, whose frozen ledger 101/source closure does not fit schema 105.

## Data and image identities

- API/Worker and publishedMigratorImage bind to the new canonical manifest.
- completedMigration binds the old raw migration operation SHA, source/controller/candidate
  SHA/tree/CI, publication/artifact/manifest, executed migrator, plan/success/receipt, target,
  catalog105, descriptor and verified backup reference.
- Read the old capsule from its own derived candidate/publication namespace. A dedicated read-only
  consumer under the NEW source authority validates the old strict bundle, compares byte-identical
  0099–0101 SQL, descriptor/catalog/bootstrap/inverse, and checks current native105/roles/ACL/security
  and backup custody. No DDL, bootstrap, backup restamp, restore or migrator run is reachable.
- Installed MIGRATOR_IMAGE_DIGEST remains the old proved image. Publishing a new migrator does not
  establish execution and must not replace this identity.

## Android snapshot and delivery exclusion

The operation binds an identity-complete SHA256 snapshot of enabled tenant runtime rows and all
matching Android/FCM/ru.padlhub.app/SANDBOX providers. Include tenant/provider IDs, status, update
version and a hash of credential_ref; never credential bytes. Existing settings are never changed.
The current READ ONLY supervisor fence retains both canonical admin locks and ledger/tenant checks.

New Worker claims try the runtime lock then provider lock in the same transaction before SELECT
or lease update. A busy lock returns zero claims/attempts/provider calls for the next normal cycle.

Advisory locks alone do not survive a controller crash. V3 therefore also mounts a non-secret,
root-owned candidate-only gate directory read-only. Its immutable `held.json` and `released.json` tokens bind operation SHA, plan SHA, candidate
release and Worker image. The separately configured expected identity prevents stale-token reuse.
Missing, partial, foreign, symlink, hardlink, oversize, extra-name, wrong-owner/mode or HELD-only
states prevent claims. The Worker rereads the directory for every batch, before SQL/leases. A generated, exact Compose override
adds this mount/environment only to the candidate Worker; base Compose and old 8158 rollback stay
unchanged. The held marker persists through controller/SSH loss. Do not prune a gate directory
referenced by an installed Worker.

## State and recovery

1. Initial exact snapshot and zero all matching SENDING (including expired), pull/smoke.
2. Durable WORKER_STOP_INTENT, stop and attest the sole old 8158 Worker, WORKER_STOPPED.
3. Repeat exact snapshot and zero ALL matching SENDING, without enabled/status/lease-expiry
   filters that could hide an already claimed send; durable FCM_DRAIN_VERIFIED proof.
4. Only then promote API and the held, lock-aware candidate Worker. Keep new triggers/lifecycle/
   APNS/SMTP/JOIN OFF. Observe the unchanged 61-sample/>=900s policy.
5. Durable GATE_RELEASE_INTENT is the point of no return. After candidate/descriptor/observation
   proof, monotonically release the durable marker, commit the advisory fence and finish SUCCESS.
   Recovery after this intent forward-attests/finishes only; unknown candidate state is a hold,
   never an automatic rollback after possible provider work.
6. Before the release intent the held marker prevents candidate claims. Recovery contains Worker,
   performs a fresh exact static snapshot and all-SENDING read and restores 8158/settings unchanged.
   Nonzero existing SENDING blocks candidate promotion, but restoration retains the old sender
   and its established at-least-once/lease-expiry behavior. The controller never clears leases,
   invents an outcome or directly retries a provider. `rollback-fcm-readback.json` is an immutable
   FIRST pre-restore observation bound into the ROLLED_BACK receipt. Recovery reads current state
   again; that count may differ after an earlier old-Worker restore, while the first proof stays.

The provider retains its established at-least-once network semantics; collapse_key is not an
exactly-once guarantee. Existing legacy sends may resume only after the explicit release boundary.

## Required evidence

Focused positive/negative tests for schema isolation, snapshot identity drift, old-proof mixing,
input byte drift, old/new migrator split, claim lock order/contention, durable gate/path/mount
custody, old-claim race, expired SENDING and all stop/drain/release ACK windows. Preserve V2 recovery.
Run the full CRITICAL check and two independent migration/recovery and release/security reviews
before task-branch publication. Live remains separate: exact artifacts, current backup/query-plan
and runtime proof, explicit authority and fresh state checks are required.

## Filesystem publication and retained dependencies

`GATE_PREPARE_INTENT` precedes the exclusive gate directory/HELD creation. A failure before
runtime mutation is classified read-only as absent, empty, owned unpublished prefix, exact HELD
or its exact link twin and terminates ABORTED; there is no automatic fresh-request replay or
cleanup. Retire those inert paths only under a separately reviewed exact operation.

Each token is written to its fixed operation-owned `.held.incoming` or `.released.incoming`
with O_EXCL/O_NOFOLLOW, full write, chmod0644 and file fsync, then link(no-replace) to the final
name, directory fsync, unlink the incoming twin and directory fsync. Worker denies extra names
and multiple links. After durable release intent, recovery may remove only the exact unpublished
byte prefix and restart that write, or normalize the exact same-inode/full-byte twin; it never
replaces a final token or cleans foreign content. Before the FIRST released publication there
is another strict-zero DB read under the same advisory fence. After publication provider work
may already have happened: only forward attestation/completion is allowed.

The installed descriptor records `PHUB_WORKER_DELIVERY_GATE_RECEIPT`. Reads revalidate the
original terminal proof, both tokens, exact generated override, live RO directory mount, expected
environment, Worker image and Compose config hash. Docker/host restart retain these dependencies.
API/Web-only releases carry the pointer and preserve Worker. A subsequent API/Worker rollout
from this V3 baseline deliberately stops with `PRESERVED_WORKER_RECREATE_UNSUPPORTED`; a future
previous-gate recreate protocol needs a separate change. Never recreate with base Compose alone
or prune the gate directory/override/evidence while referenced.

## Before any new live request

New candidate==controller CI/publication/enrollment and exact-target approval are still required.
Refresh backup custody, native105, runtime/preimage, exact Android snapshot and capacity without
expanding disk/reboot. Obtain real row counts and EXPLAIN/read-only duration for the ALL-SENDING
query on the actual target; its tenant-leading indexes and 5-second fence timeout are not
validated by synthetic tests. No Timeweb history contract is added. LOCAL/CI proof does not
authorize deployment, new real trigger sends, JOIN or provider/tenant configuration changes.
