# Tournament read positions — actual Web consumer

CUP owns the read baseline/cursor; LK2 never becomes a second tournament roster.
This source packet adds an explicit Web read acknowledgement, not notifications,
delivery/read-by-others, native routes, channel policy or realtime guarantees.

Public `tournament-chat-read.v1`: GET `chat/read-position`, POST `chat/read-requests`
(exact original UUID as Idempotency-Key), GET `chat/read-requests/:requestId`.
A command binds streamId, opaque witnessHash and throughSequence. Private CUP
responses additionally carry exact participant generation/actor hash or organizer
revision/canonical UUID. LK2 verifies and strips the witness; no phone, provider
identity or original JOIN generation enters the public response.

Before participant READ mutation, fresh CUP position proves current registration.
The reverse resolver then reads tenant+tournament+owner_operation_id LIMIT2 from
existing `booking.tournament_local_attempts`, validates the original canonical actor,
command/authority hashes, exact provider namespace/client/mapping UUID and both
current mapping cardinalities. READY, missing, duplicate, corrupt and completed
REJECTED originals refuse. DISPATCHED only proves identity together with that fresh
owner witness; it never proves registration alone. Current ACTIVE session/user/tenant
checks remain before/after transport. Organizer authority is explicit current
assignment, never inferred from creator or mechanics lists.

Migration0113 adds only a nonunique reverse lookup index. No0111/0112 packet is
copied, no new table/backfill/startup DDL. Migration application and rollback are
separately authorized operations; preserve originals and receipts on rollback.

CUP first stream/read bootstrap has genuine baseline0. Existing streams without a
read marker require explicit full adoption at their current contiguous frontier P;
GET cannot adopt. Successful new JOIN/ASSIGN baseline=P is in the same full raw-row
CAS as membership. LEAVE/REVOKE retain custody and remain available with malformed
or saturated read markers. Old generation/revision commands never rebind.

READ acceptance stores an immutable requested through/resulting readThrough and
audit intent in the owner CAS. Recovery copies that exact result before cleanup,
never recomputes it from newer reads. Original GET status has no candidate creation,
marking, recovery or retry. UNKNOWN/403/404/absence/timeout retains original custody.

Web requires an explicit Mark read button and a contiguous loaded range from owner
readThrough+1 to retained head. Latest50 over an unread prefix cannot mark all read;
load older pages first. History is bracketed by matching owner witness observations.
Changed stream/witness/current ACL clears private view state. Focus/online/reload
only read; reload restores original READ using GET and never dispatches a fresh key.
Web Locks serialize16 metadata-only originals; no message bodies, private witnesses,
TTL or eviction. Corrupt/quota/full storage fails closed. Different ranges retain
separate originals, late logout/ACL ACKs cannot clear custody. Native remains gated.

SOURCE/LOCAL/CI are distinct. Existing guarded CI PostgreSQL/Mongo fixtures prove
query/CAS behavior only when actually executed. No local DB/provider is used.
Activation still requires coherent CUP/LK2 installation, old-writer drain, explicit
existing-stream adoption, Mongo read recovery index and capacity/durability/clock
proof, migration0113 and separately installed dedicated signer configuration.
Current state observations cannot promise cross-database atomicity or delivery.

Existing API database-role SELECT access to the original attempt and identity/mapping
relations must be verified on the installed runtime. Source tests do not prove
installed grants. This packet adds no grants and does not change worker role authority.
