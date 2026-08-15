# C-07 — Community image lifecycle and safety

Status: accepted, 2026-08-04.

## Decision

The first Communities media release accepts images only. One source is JPEG, PNG or WebP, no
larger than 15 MiB, and one post revision references at most ten distinct media UUIDs in display
order. Comments do not accept media. A post body remains mandatory.

The browser first requests an idempotent upload intent, uploads to a short-lived private quarantine
capability, finalizes that intent and polls canonical status. A post command may reference only
`READY` media from the same tenant, community and uploader. The post, ordered attachment snapshot,
immutable post revision, idempotency result, audit and outbox event commit in one PostgreSQL
transaction. A separate attach mutation is forbidden.

The signed quarantine PUT is single-use: the signature binds `If-None-Match: *`, and storage CORS
must allow that exact request header. A replayed browser PUT to an already-created key therefore
fails instead of creating another provider version. Quarantine lifecycle removes noncurrent
versions within seven days; this bounds provider-version residue from interrupted uploads without
shortening READY or archived retention.

Issuance capacity is enforced from durable `media_assets` evidence inside the same tenant
transaction and before a new intent is inserted. An actor may hold at most ten unexpired
`UPLOADING` intents, at most 20 actor pipeline slots across unexpired `UPLOADING` plus every
`SCANNING` item, and at most 100 issued intents plus 150 MiB of declared source bytes in a rolling
24-hour window. Rejected, expired and purged rows do not refund either rolling budget. A tenant may
reserve at most 100 pipeline slots across unexpired `UPLOADING` plus every `SCANNING` item,
including a terminal failed scan. Fixed-order tenant then actor advisory locks make these limits
exact across concurrent API instances and prevent tiny uploads from monopolizing tenant scanning.
An exact issue replay is resolved before quota evaluation and consumes no additional capacity, but
only after current actor/membership/publishing authorization and an authoritative locked check that
the same media row is still unexpired `UPLOADING`. Terminal or expired rows never receive another
PUT grant. These are conservative activation defaults and require workload/capacity ratification
before production enablement.

Source-version GC is never eligible before the original `uploadExpiresAt`. This ensures every PUT
grant already issued for that key has expired before exact source deletion can make `If-None-Match:
*` true again; READY/REJECTED transitions may schedule GC immediately, but the worker cannot claim
that job until the signed-upload window is closed.

Media follows `UPLOADING -> SCANNING -> READY | REJECTED`; an unused intent may become `EXPIRED`,
and a retention or GC tombstone may become `PURGED`. The worker validates magic bytes, exact size
and checksum, decoded pixel bounds and safety signals, removes metadata and creates immutable WebP
variants. Quarantine originals are never served.

Every generated key follows the internal contract
`community-media/ready/{tenantId}/{communityId}/{mediaId}/{variant}/{sha256}.webp`. The scope UUIDs
prevent cross-community aliasing, while the content hash makes each variant immutable. This key is
provider-internal and is covered by a worker-to-repository regression test.

Finalize binds the observed storage `VersionId`, checksum, size, content type and ETag. Every scan,
transform and delivery operation addresses that exact immutable version. Provider version IDs and
object keys remain internal. A repeated finalize command is resolved from its idempotency record
before storage HEAD, so replay remains valid after quarantine cleanup.

DTOs expose stable authenticated PadlHub variant URLs. The PadlHub endpoint authorizes the current
viewer and responds with a redirect to a short-lived signed URL for the exact variant version. The
signed Location is transport state and is never persisted or shared as canonical media data.

Unattached `READY` media expires after 24 hours. Once media is bound to a post, every post revision
keeps its immutable ordered media snapshot. Removing media from a later edit does not remove it from
older revisions. Archiving a post retains body, attachment references and media objects for five
years from `archived_at`; storage lifecycle rules may not shorten this domain retention.

Durable community realtime events are retained for 30 days. A cursor older than retained history
receives the existing retained-gap conflict and the client discards its cursor, reloads canonical
feed/comment/media state and resumes from the returned latest sequence. WebSocket hints and media
events are never a source of truth.

## Atomic boundaries

- Issue: asset intent, actor-scoped idempotency result, audit and
  `community.media.upload_requested.v1` outbox commit together. Signing happens after commit and may
  issue a fresh short-lived URL for the same media UUID on replay. A new command first takes the
  tenant pipeline and actor quota locks, evaluates durable rolling usage and either commits all
  issue evidence or returns a stable quota outcome without a media row.
- Finalize: replay/conflict is checked first. A bounded HEAD observes the current version, then
  `UPLOADING -> SCANNING`, the exact immutable object evidence, idempotency, audit and
  `community.media.scan_requested.v1` commit together.
- Worker completion: terminal asset state, immutable variants, inbox completion, system audit and
  `community.media.ready.v1` or `community.media.rejected.v1` commit together.
- Post create/edit: READY validation, permanent binding to one post and the ordered revision
  snapshot are part of the existing content command transaction.
- GC: claims use a durable lease with bounded retries. Object deletion is idempotent; metadata and
  audit tombstones survive physical purge.
- Recovery: scans and GC jobs have a configured maximum of bounded attempts. Exhaustion persists
  `failure_code` plus `scan_failed_at` or `dead_at`, clears the lease and removes the item from
  ordinary claims. An authorized CUP operator may release only that terminal item through an
  idempotent replay command with a mandatory reason; the command writes audit and outbox evidence.

## Dependency and backlog readiness

API readiness verifies PostgreSQL and the configured S3 bucket. Worker readiness additionally
verifies S3 and performs a bounded ClamAV PING. A failed readiness attempt is never cached: the next
probe retries the dependency, allowing a recovered S3 or ClamAV to return the process to ready.
Operational telemetry exports active scan/GC backlog counts, oldest-item age and terminal
failed/dead counts. Terminal counts block release until an operator investigates and either replays
the exact item through CUP or accepts its disposition.

## Release gates

The feature remains disabled until all gates pass:

1. Expand-only tenant-RLS schema, composite foreign keys, generated OpenAPI/SDK and old-client
   compatibility are green.
2. Storage preflight proves versioning is `Enabled`, buckets are private, public ACL/policy access
   is absent, and CORS permits only the approved LK origins, `PUT`/`HEAD`/`GET` and the exact signed
   required headers, including `If-None-Match`. Quarantine noncurrent versions must expire within
   seven days. Lifecycle policies must not delete attached or archived READY objects before the
   five-year domain deadline.
3. Signed upload includes the media UUID metadata, exact content type/checksum constraints and a
   short expiry. Secrets, object keys, provider IDs and signed URLs are absent from audit/outbox/logs.
4. Spoofed MIME, checksum/size mismatch, corrupt images, decompression bombs, duplicate finalize,
   replay after quarantine cleanup, worker crash, reordered delivery and storage outage tests pass.
5. CUP displays every image before a moderator can decide. User composer enables post submission
   only when all selected media are READY.
6. Load evidence covers concurrent issue/finalize, scan backlog age, ten-image feed posts, delivery
   redirect latency, hot communities and GC recovery. The quota race proves exactly ten actor
   intents, exactly 20 actor pipeline reservations and exactly 100 tenant pipeline reservations
   under concurrent issuers; rolling count and byte tests prove state transitions and purge cannot
   refund either 24-hour budget.
7. Rollback disables new intent/finalize/attachment commands but continues READY delivery, scanning
   already-finalized objects and GC. No schema rollback is required.
