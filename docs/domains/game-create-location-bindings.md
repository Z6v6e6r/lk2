# CREATE location evidence

This packet produces private public court → public station → Viva room/studio bindings. It does not
activate CREATE admission, reserve usage, create an exercise, or change LK1. The existing CREATE
admission remains unavailable. `resolveCreateDraftLocation` is an internal repository method;
provider IDs never enter the existing draft or public game DTO.

## Owner and activation

Games/integration owns `GAME_CREATE_LOCATION_BINDING_SYNC_ENABLED`, default false. Its purpose is
controlled production-capable evidence collection and emergency disable. The dedicated worker runs
on startup and 60 seconds after completion. The local/staging roster flag and public-clone source
remain unchanged. Disabled means no new cycle DB, credential, Mongo or Viva access. Missing schema
returns unavailable; no process runs DDL.

Activation requires separate owner approval and these runtime prerequisites:

- Migration 0105 applied by the authorized migration path, with backup/rollback checks. Review
  worker/API least privileges for the new table and existing read/row-lock paths separately.
- Explicit tenant UUID and existing server Mongo reference; complete historical source retention
  and unambiguous raw plus pseudonymous import lineage. Public hashes without raw witnesses fail
  closed. Incomplete or oversized manifests cannot qualify.
- Dedicated absolute `GAME_CREATE_LOCATION_BINDING_ADMIN_CREDENTIAL_FILE` reference to an
  operator-supplied private owner-only regular file. The existing safe file reader enforces its
  filesystem properties. Strict JSON fields: `purpose: GAME_CREATE_LOCATION_BINDING`,
  `providerTenantKey: iSkq6G`, `accessToken`, ISO `expiresAt`. No file/value is created here and no
  notification credential is reused. The configured tenant needs the exact canonical Viva binding.
- Independently verified credential tenant/room-read scope and acceptance of authenticated
  `GET /api/v1/studios/{studioId}/rooms/{roomId}`. That admin URL has no tenant segment: the file's
  tenant is an operator assertion, not a code-verified token-tenant echo. Credential availability,
  tenant scope and provider response acceptance are UNKNOWN until that evidence exists. Do not
  activate with an unverified/cross-tenant admin token.

Review the flag after the first production rollout. Remove it only after producer/reader adoption
and an equivalent emergency disable exists. This packet performs no activation, grants, migration,
credential provisioning, provider call, store action or production verification.

## Complete evidence

One bounded SQL statement reads all tenant legacy game/station/court aliases and every canonical
court game, including history. A 10,001st row in either set fails closed. Mongo reads exact source
game aliases with primary/majority consistency, no cache and a minimal projection: game ID, source
update time, raw studio/room IDs. Archived and cancelled history is included. Duplicate source IDs,
missing historical witnesses, unknown aliases, conflicting stations and reverse collisions fail
closed. Reverse checks cover both aliases and raw source witnesses behind other canonical games,
even when those other games already have corrupt court aliases.

Every alias must equal an explicit raw ID or its existing exact pseudonym. Nothing is decoded,
inferred from a name or selected by alias priority. Only after all aliases agree is one provenance
row selected deterministically for its FK. There is no canonical court table: the FK protects the
mapping row identity, while semantic `internal_id` equality is checked during publish and read.
Existing importer alias retargeting is not constrained by a new composite FK.

The adapter permits only a fixed-origin GET, with bearer, timeout, bounded transient-status retry,
circuit breaker, redirect refusal, bounded response and exact room identity. Contradictory explicit
room/studio fields revoke the original active revision. A transport failure does not prove deletion
and never renews existing evidence.

## Freshness, writes and reads

TTL is five minutes from the beginning of source observation, not from completion of a slow provider
call. Complete lineage contradiction revokes by CAS; TTL also closes reads during outages. Producers
are serialized; publish checks the original binding revision and lineage digest, plus unique active
room ownership. Binding, audit and outbox commit in one transaction. Audit/outbox contain only public
UUIDs and revision/state, never bearer/raw source/provider IDs. Exact last-command replay is read-only;
changed bytes conflict. An older command after a later revision cannot renew old evidence.

The internal resolver locks the authenticated organizer's exact eligible draft, then the active
binding, published station, provenance map and tenant/provider binding. It compares the full lineage
and checks expiry again using the database clock. Revoke, unpublish and identity removal cannot
commit between those reads. Existing draft output is unchanged; old binaries ignore the new table.

The manifest deliberately covers the whole tenant: any import/alias or court-game change, including
a local draft, invalidates bindings until the next successful cycle. This is a conservative
availability tradeoff. Existing import writers do not share the producer lock. Changes committed
before the manifest SELECT are detected; later changes are outside that snapshot. This is bounded
readiness evidence, not durable dispatch authority or cross-system linearizability. Future CREATE
execution must re-resolve original draft/binding revision, lineage and expiry before an attempt and
LK must independently verify the provider pair. An existing attempt retains its original snapshot;
it must not rebind to newly observed evidence.

## Rollback and verification

Disable the dedicated flag; preserve the additive table, audit/outbox and any attempted-operation
snapshots. Evidence expires within five minutes and readers fail closed. Old binaries require no
schema drop. Do not contract the table while any reader uses it. Operator schema/data changes remain
separate approval boundaries.

LOCAL tests use synthetic fetch/Mongo/SQL ports. Physical PostgreSQL tests run only in the existing
GitHub CI database (`APP_ENV=ci`, `GITHUB_ACTIONS=true`, exact loopback phub target), with owned random
tenants/role and cleanup. They neither provision a database nor apply migrations; standard CI
migration setup supplies the schema. Their LOCAL skip is not PostgreSQL acceptance. Tests do not
certify concurrent future CREATE dispatch or provider runtime behavior.
