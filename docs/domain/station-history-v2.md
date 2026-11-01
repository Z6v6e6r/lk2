# Station community history v2

This candidate fixes pagination across equal timestamps. It is a read-only companion
of LK's opt-in `historyVersion=2` contract, not a message-delivery or reconnect watermark.

For a currently authorized STATION community, the API sends the verified user-scoped
Bearer and `historyVersion=2`, `limit`, optional `beforeTs` (positive integer
milliseconds) and `beforeId` (lower-case public UUID). It sends no phone/client identity
query. Other community kinds and feed retain their existing history contract. A
matched owner must be installed before enabling this reader: an older graph's response
without exact v2 acknowledgement fails closed, with no fallback request.

The owner returns exactly `historyVersion`, `messages`, `nextBefore`, `hasMore`.
Rows contain publicId, text, canonical ISO createdAt, matching integer createdTs,
authorName and optional private authorId/authorPhone. The API strips private author
identity and derives isViewer from the existing verified identity. Owner history
normalizes legacy IDs to deterministic UUIDs without changing stored documents.

Rows must be unique and strictly descending by `(createdTs, publicId)` with binary
UUID ordering. Every row must precede the request boundary. A continuation requires
a full requested page and exactly the last returned tuple; no continuation uses null.
Oversend, stale version, inconsistent timestamps, duplicate IDs and invalid ordering
are errors, never truncated successful pages or proof of end of history.

Public opaque v2 cursors bind tenant and public community UUID and contain only the
public timestamp/UUID tuple. They are read positions, not authorization or signatures;
current membership is checked independently on every request. Existing v1 time-only
cursors retain strict `< timestamp` semantics and can continue with v2. Previously
omitted ties require a fresh first-page read. Feed cursors are unchanged.

The UI sorts equal timestamps by public UUID, preserving distinct equal-text messages.
A page containing only already-visible ACK rows may still advance its server cursor.
A repeated cursor displays a retryable error and retains the original position and
visible messages. Empty/end pages do not invent additional reads or POSTs.

## Installation and recovery constraints

LK's historical compatibility read is bounded to 2000 rows plus one overflow detector;
overflow, unsupported legacy identity, collision or untrustworthy time must fail closed.
Canonical pages use bounded sort/limit and maxTimeMS. Actual historical count, BSON
shape, index availability and query timing must be checked before separately approved
activation. No index creation, backfill or real database operation is part of this PR.

Canonical createdTs is reservation time, not publication time. A delayed outbox message
can appear behind an already-read boundary. Reconnect starts a fresh head walk; own
unresolved sends retain original-request GET recovery. This candidate does not promise
complete reconnect delivery, unread counters, native process-death recovery or realtime.

Rollback disables the reader or restores the prior compatible source. Retain all
message/receipt/outbox records and custody. Do not reinterpret UNKNOWN as a new send,
erase receipts, or substitute station support-dialog identifiers for community UUIDs.
LOCAL/CI fixtures are synthetic acceptance, not STAGING/PROVIDER/PRODUCTION evidence.

Paired synthetic wire fixture: `apps/api/src/communities/fixtures/station-history-v2.json`,
SHA256 `50e02af00ef28ad2163f6d7909bd748c3741bbac251da3c4f7581ddce4f0440a`.
The actual LK historyRequest/historyPage helper emits these bytes; the actual LK2 parser
accepts all three mixed equal-time UUID rows and verifies the exact continuation boundary.
