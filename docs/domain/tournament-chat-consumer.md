# Tournament chat consumer: Stage A

Source-only API and Web adoption of CUP `tournament-chat.v1`, against CUP #71
`cb413d41c59e0dd14b400884ea71c154fb4520dc`. CUP is the sole message/roster owner.
This packet does not grant access from a local registration projection, tournament creator,
mechanic list, phone, or display name. CUP admits only its exact current LOCAL_ONLY JOIN
generation or currently assigned canonical organizer. The explicit organizer assignment
packet LK2 #539 / CUP #70 remains a separate integration dependency; no source was copied.

## Trust and compatibility

The three authenticated LK2 routes under
`/user/api/v1/:tenantKey/tournaments/:tournamentId/chat` are:

- `POST /message-requests`: exact `{requestId,text}`, UUID Idempotency-Key equal to requestId.
- `GET /message-requests/:requestId`: original request status only; never dispatches/replays POST.
- `GET /messages?limit=1..50&cursor=...`: fixed-frontier history, no cache/anonymous fallback.

All public identities are PadlHub UUIDs. The backend verifies the current tenant/sub/sid,
ACTIVE user/tenant and current refresh session in one tenant-scoped PostgreSQL read. Both
forward and reverse VIVA mapping cardinalities must be exactly one, with synced/error-free
mapping and the authoritative provider tenant binding. Canonical tenant key and provider
namespace may differ. Those integration identifiers occur only in the dedicated internal
assertion, never in browser responses, audit labels, or message storage in the browser.
The final local identity/session read must still match before returning owner data.

`TOURNAMENT_CHAT_ENABLED` defaults false; its owner is the API/CUP integration release owner.
Activation requires separately approved dedicated RSA key installation on both sides,
CUP71 index/collection readiness and accepted recovery process, coherent source installation,
clock budget evidence, verified tenant namespace, and the current-role/organizer dependency.
No key or index is created by this client. Review the flag at coherent activation; disabling
rejects new API traffic and leaves browser original custody intact. It does not erase CUP
receipts or authorize rollback of accepted intents.

Dedicated source configuration: `TOURNAMENT_CHAT_OWNER_BASE_URL` (HTTPS origin only),
`TOURNAMENT_CHAT_TENANT_ID`, `TOURNAMENT_CHAT_TENANT_KEY`, `TOURNAMENT_CHAT_ACTOR_ISSUER`,
`TOURNAMENT_CHAT_ACTOR_KEY_ID`, `TOURNAMENT_CHAT_ACTOR_PRIVATE_KEY_FILE`. No actual values or
credentials are included. The signer uses only `phub-tournament-chat-actor+jwt`, audience
`cup-tournament-chat-v1`, scope `tournaments.chat.actor`, exact method/path/body hash,
correlation and current session binding; lifetime 30 seconds. Existing organizer lookup,
subscription, browser and user/provider tokens cannot substitute for it.

The HTTP call has an eight-second timeout, no blind retry, no redirects, 8KiB receipt /
3MiB history response bounds and a three-failure/ten-second dependency breaker. Expected
actor access/input/conflict denials and local identity failures do not poison other actors'
breaker. Public errors are fixed safe codes. API audit logs carry only public tournament
UUID and fixed outcome labels; CUP owns the durable acceptance audit.

## Custody and history

The SDK strictly validates version, original tournament/request/hash, UUIDs, exact fields,
contiguous descending sequence, fixed stream/frontier/cursor and exact UTF-8 text. Leading
BOM is retained like the owner; malformed surrogate/NUL text is refused. The SDK keeps its
concrete parser local to avoid a new runtime package dependency. A shared synthetic fixture
emitted by the actual CUP71 service with its existing in-memory store, plus parity tests,
checks both parsers. It is not a live CUP or Mongo result.

Web persists only up to 16 unresolved metadata entries per canonical tenant/user/tournament
in localStorage: original request UUID, exact text fingerprint and full original request hash.
Browser Web Locks serialize that scope. A storage/lock failure or full set refuses a new
intent without evicting an unresolved one. Exact pending text manually retried reuses its UUID;
edited text gets another UUID while the old entry stays. Text itself is not persisted.
Reload performs GET status only; it cannot reconstruct or automatically resend an old body.
An UNKNOWN/timeout/403/404/malformed result is not evidence of nonacceptance. Only a valid
CONFIRMED receipt bound to the original full request hash clears that original entry.
Logout/session retirement fences late results and never consumes original custody.
Current access denial hides cached history and draft but retains minimal metadata.
Clearing browser site data loses local recovery metadata; no server-side listing or durable
multi-device custody is introduced in Stage A.

Fresh reads on focus/online/visibility and explicit refresh page one fixed owner snapshot,
then at most four pages (200 messages) until the exact prior head UUID/sequence is reached.
Successful catch-up preserves already loaded older rows and their original pagination cursor.
If the anchor is not reached, stream changes, or a sequence is malformed, old history is not
silently replaced: the UI reports the gap and offers an explicit fresh-history restart.
Continuation remains authorized by CUP's current witness/stream and fixed frontier.
This is bounded HTTP catch-up, not a realtime or gap-free delivery guarantee.
CONFIRMED means durable published storage, never delivery, read status, or unread count.

## Evidence and remaining gates

Focused synthetic API/signature/parser/custody/component tests and scoped source checks
are LOCAL. The PostgreSQL suite uses only the existing migrated disposable GitHub CI service,
with exact CI/mode/localhost credential guard, random owned tenant and scoped cleanup.
It is skipped locally; no DB/container was provisioned. Existing database uniqueness prevents
physical ambiguous mappings; tests assert both constraints without weakening them, while
unit cases exercise defensive forward/reverse count refusals.

Web is the only enabled client in this packet. Both App navigation and gateway reject native
commands. Android/iOS adoption remains mandatory Stage B after the independently owned native
station packet and this Web packet are coherently integrated. There is no native/read/unread/
realtime completion claim. No workflow, dependency, migration, shared runtime configuration,
installed credential, provider, production database or deployment was changed by this task.
