# Official station stream: Web and native consumer

This concrete consumer pairs with the authenticated LK station v3 history, summaries and
`station-read.v1` owner. It does not replace `/chat` v2, introduce a message writer, or run a
database migration. The native companion below adds only the concrete v3 allowlist. All requests
go to PadlHub APIs.

The existing legacy-community read/chat and OAuth gates compose the server adapter. Fresh,
authorized owner summaries choose `AVAILABLE`, `UNADOPTED`, or `NOT_STATION` for each mapped
public community. Only the latter two explicit owner results allow the existing Web history
path. An absent/old receiver, malformed response, authorization failure or adopted-stream outage
shows unavailable history/unread state; it never invents zero unread or downgrades to v2.
Install the matched owner graph before this consumer. Native clients retain their existing v2
history and original station-message send/status behavior.

The new public routes are GET `community-views/station-stream-summaries` (at most 50 distinct
public UUIDs), GET `community-views/:id/station-stream`, POST `:id/read-requests` and GET
`:id/read-requests/:requestId`. All require current PadlHub actor/tenant/session authority.
The private owner receives only the existing short-lived verified user delegation. Read-only
batch mapping requires exactly one tenant-scoped mapping per public UUID; no missing identity
is created. Private community IDs and message author identity never enter public DTOs. Cursor
scope contains public tenant/community, stream, epoch and position only; it is not ACL authority.
Every owner operation is timeout-bounded, has no automatic retries, shares a bounded circuit
breaker, and emits only operation/status/duration metrics without payloads or credentials.

STREAM order uses the owner's immutable sequence. Each forward cursor retains a fixed `through`
while the independently observed published frontier may advance. Reconnect/focus/visibility
reads consume every page in that fixed range (at most ten pages per wake-up, with the next exact
cursor retained for explicit continuation). They never replace a backlog with a later head.
Older sequence windows and timestamp-only archive pages remain separate. Confirmed send ACKs
may be displayed while awaiting sequence publication but cannot authorize read-through.

Read marking is an explicit user action after the accepted consecutive range has rendered.
A latest window with an unseen gap cannot advance over it; the reader can load missing earlier
windows first. The original request UUID/stream/epoch/through is saved in scoped session storage
before POST. Ambiguous responses, corrupt/unavailable storage, logout and old-epoch failures do
not silently erase custody or issue a new request. Reload and manual status recovery use only
GET. A confirmed receipt proves the original acceptance, not current unread zero: only a fresh
owner observation updates the counter. Source/principal/epoch/unmount fences discard late
responses. The UI clears adopted history on unproven/denied reads and hides community content
synchronously when logout starts. Read receipts contain no message body, token or private ID.

Rollback may restore the old Web reader without deleting owner stream/read records. It loses
v3 sequence/unread presentation and must not pretend v2 timestamps or advisory unread values
are equivalent. No source change authorizes owner adoption, runtime publication or activation.
The owner retains responsibility for atomic read receipts, epoch authorization, dense published
frontier and unread count. Provider/runtime acceptance and native v3 adoption remain separate.

The synthetic shared fixture `apps/api/src/communities/fixtures/station-stream-v3.json` is emitted
by the actual LK helper and bound in its test and this adapter test. SHA-256:
`40093222ddf4c9b020f48868dc4dd08a02d490949d57b091ba42e4aa35ee2385`.
LOCAL tests are synthetic parser/transport/SQL-shape/UI evidence, not a live provider or Mongo
read. Full repository gates and matched owner physical/runtime acceptance are reported separately.

## Native v3 companion

Android's shared community entry and the existing iOS station directory now select the same
`StationStreamThread` only from fresh AVAILABLE summaries. Explicit UNADOPTED/NOT_STATION
keeps the existing v2 reader; missing/malformed/forbidden summaries cannot downgrade an adopted
stream. No new backend route, owner authority, schema, SDK retry or feature flag is introduced.

Native read custody uses localStorage for the original request UUID, public stream UUID,
membership epoch and requested sequence, scoped by tenant/user/community. Web retains its
sessionStorage default. An exclusive WebLock prevents two native views reserving simultaneous
commands. A pending request, including an older epoch, is never overwritten or automatically
resent; reload/process restart and manual recovery use only its original status GET. Exact
receipt matching and original principal/lifetime checks precede metadata deletion. Corrupt,
unavailable or quota-limited storage and missing Web Locks fail closed. No message text, token,
phone or private provider identity is stored. Owner unread observations remain separate from
historical read receipts; ACK overlays/archive cannot authorize read-through.

The concrete JS/Java/Swift guards permit only batch summaries (1–50 unique public UUIDs), stream
GET (limit1–50, opaque base64url cursor16–1024), exact read POST and original read status GET.
Read POST remains <=16KiB UTF8 with exact UUID/header identity and safe integer counters; the
separate message-send64KiB/8000UTF16 exception is unchanged. Only v3 history responses allow
3MiB: fifty legal8000-unit messages can exceed the old2M/1MiB bounds after JSON escaping.
The API owner client, Android streaming sender/engine/JS bridge and iOS checked transport enforce
that bound. Summary/receipt and old v2 limits remain unchanged. This fixes the bounded size gap
in #541; it is not permission to increase arbitrary provider/native response limits.

Native distribution requires the coherent #541 server plus matched station owner contract.
Rollback may remove native v3 presentation, but must retain local original custody and owner
receipts. Integrate this packet before tournament native Stage B; root must serialize shared
App/auth gateway/session changes. Pending #525/#512/#518 features are not copied here.
LOCAL host JVM/reference JSON and rendered synthetic components are not Android device or app
acceptance. Local Swift build is intentionally not run under the disk budget; automatic iOS CI
must compile/test the actual bridge. Android APK automatic PR build is absent on this ancestry;
it requires the separately owned coherent Android CI integration, not workflow dispatch here.
