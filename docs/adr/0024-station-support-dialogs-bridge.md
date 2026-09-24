# ADR 0024: Station support dialogs stay a bridged legacy contour

Status: Accepted

## Context

The Chats screen ships a `Станции` filter that today renders only a "not connected" state. The
product wants the station chats that already open dialogs in CUP to appear there, by analogy with
the LK1 cabinet.

Two facts constrain the answer:

- LK1 (`SupportChatWidget`) writes those dialogs into the shared support store through the LK1
  support contour (`/lk/support/dialogs`, `/lk/support/dialogs/{id}/messages`,
  `POST /lk/support/dialogs/events`). CUP operators answer them in the existing ЦУП; a client is
  identified by the viewer's phone number and keeps one open dialog per client and connector, whose
  station the latest explicit selection replaces.
- PadlHub has no station conversation model. `docs/domains/chats-and-notifications.md` keeps the
  `STATION` conversation kind closed until a station membership/privacy model is approved, and the
  database kind `SUPPORT` is modelled but unused. Building that model now would move every operator
  out of the ЦУП they work in today.

## Decision

`apps/api` exposes a narrow, default-off station-support boundary and the browser never calls the
legacy contour directly:

- `GET /user/api/v1/{tenantKey}/support/stations` lists the tenant's published PadlHub stations —
  the same editorial aggregate `GET /locations` already serves, so the picker uses PadlHub UUIDs.
- `GET .../support/dialogs`, `GET .../support/dialogs/{dialogId}/messages` and
  `POST .../support/messages` proxy the LK1 support contour from the server.
- The viewer identity is resolved server-side from integration custody. The verified login phone is
  the primary key because it is the stronger identity, matching the existing legacy bridge; the
  provider-asserted `legacy_viewer_phone` is only a fallback. Exactly one phone is forwarded: the
  API never asks the provider to merge two numbers into one client, because that would unite two
  viewers' support histories with no ownership proof.
- Neither the phone nor the provider dialog/message identifiers ever reach the browser: dialogs are
  addressed by a PadlHub UUID derived from the tenant and the provider id and resolved by enumerating
  the caller's own dialogs, so one viewer can never address another viewer's dialog and the derived
  id is not a cross-tenant correlator.
- The legacy station key for a chosen station comes from
  `integration.external_entity_map` (`LK_LEGACY_SNAPSHOT`/`game_station`, preferring a raw key over
  a public-clone pseudonym). A station without a binding fails closed with
  `SUPPORT_STATION_NOT_BOUND`; a dialog whose provider station does not resolve still lists, with
  `stationId: null`.
- The send command requires `Idempotency-Key`, is rate-limited, and carries a namespaced value
  (`phub:` + a hash of tenant, user and key) as the provider's `externalMessageId`. A retried command
  replays from the provider's stored message, and a replay whose stored body differs from the
  submitted text is refused with `IDEMPOTENCY_KEY_REUSED` instead of silently dropping the text.
- The provider write is attempted exactly once. Automatic retry covers only the two idempotent reads,
  because no recorded provider evidence proves that a repeated `externalMessageId` is deduped. An
  ambiguous timeout, 5xx or 2xx-without-dialog-id is resolved by reading the message back before the
  API reports failure, and a terminal 4xx is a distinct `SUPPORT_MESSAGE_REJECTED` (422) that neither
  counts towards the shared circuit breaker nor pretends to be an outage.
- The dialog list is bounded to the newest 200 dialogs, matching the published `maxItems`, and a
  write into a `CLOSED` dialog is refused with `SUPPORT_DIALOG_CLOSED`.
- The event body carries only properties the CUP ingest DTO declares. The ingest validates with
  `whitelist: true, forbidNonWhitelisted: true`, so one undeclared property refuses the entire
  command with HTTP 400: an earlier body sent `phoneNumber`, which that DTO does not declare (it
  declares `phone` and `primaryPhone`), and every station message was rejected before the station
  was read. `kind: 'TEXT'` keeps the message an actionable client text; without it the ingest reads
  a station-carrying event as a `STATION_SELECTION` system event, which the operator inbox does not
  treat as a message waiting for an answer. The station itself is routed by `selectedStationId`,
  which the web connector derives from the event's `stationId`.
- `POST .../support/attachments` uploads one picture: the bytes are validated, re-encoded to WebP
  (bounded dimension and quality, 8 MiB in, 3 MiB out, which keeps the forwarded inline data URL
  inside the 4 MiB the CUP workspace itself already sends) and stored under the caller's own
  content-addressed key in the same PadlHub media bucket the native chat contour uses. The command
  carries base64 inside the JSON body so no extra body parser is registered and the smaller existing
  parser limits stay untouched. Nothing is written to the provider here, so an abandoned upload is
  invisible to an operator. `GET .../support/attachments/{attachmentId}/content` rebuilds the object
  key from the caller's verified identity before answering a redirect to a short-lived signed URL,
  which needs the bearer token for exactly that reason.
- A provider picture is materialized on the history read: an inline base64 image is decoded locally
  and a linked image is downloaded only from the host `SUPPORT_LEGACY_BASE_URL` names, bounded by
  timeout and byte budget, then converted to the same WebP form and stored under the caller's own
  key. A picture the deployment refuses leaves the message text-only, and the provider's raw value
  never reaches the browser.
- `POST .../support/messages` accepts up to four `attachmentIds` belonging to the caller. Each one is
  read from storage and forwarded to the CUP ingest as an inline WebP data URL, because the provider
  stores the URL in its own message record and a signed link would expire inside the operator's
  history. A picture-only message carries the preview text the CUP workspace itself writes
  (`Фото: <name>`), and a replay must match both the text and the attachment signature, otherwise the
  reused key is refused with `IDEMPOTENCY_KEY_REUSED`.
- The message view exposes the operator name the provider stored (`authorName`), so the viewer sees
  who answered instead of a generic station label.
- `SUPPORT_STATIONS_ENABLED` is default-off and requires `SUPPORT_LEGACY_BASE_URL`. The provider
  client is bounded (timeout, at most two attempts with backoff, per-operation circuit breaker,
  bounded response body, `redirect: 'error'`, HTTPS-only base URL outside localhost) and emits only
  redacted metrics: no phone, no message body.

## Consequences

- CUP keeps one support inbox and one open dialog per client and connector. Existing LK1 dialogs stay
  visible when the viewer's verified phone is the number CUP already stored; when the two phones
  differ, the verified identity wins and older dialogs under the provider-asserted number are not
  enumerated. That trade is deliberate: reading a recycled number's history is the worse failure.
- The provider receives the PadlHub user UUID (`externalUserId`, `externalChatId`) so it can link the
  CUP client to a PadlHub account. That value is a pseudonymous internal identifier, not PII, and it
  is the only PadlHub identifier shared with the legacy contour.
- The Chats «Станции» tab lists every published station as a chat destination, not only the
  stations the viewer already wrote to. Tapping a station opens the viewer's own thread with it and
  the first message sends that station to the provider; a station without history shows an empty
  thread, and a dialog whose station the published list cannot map stays visible so its history is
  never hidden. The API contract is unchanged: the client joins the published station list it
  already reads with its own dialog list. The provider keeps one open dialog per client and
  connector rather than one per station, so an explicitly selected station moves that dialog's
  station (and the CUP client's current station), exactly as the LK1 widget does; per-station
  threads remain the provider's behaviour to change.
- The station tab is provider-backed and deliberately outside the LK2 conversation contract: it has
  no realtime subscription, no notification policy and no unread cursor. It carries pictures through
  the shared media bucket, but it is not the messaging media pipeline: there is no quarantine scan, no
  attachment row and no per-message lifecycle, because the provider's own message record stays the
  canonical object. Its list is
  loaded on demand — by the station tab and by the unfiltered tab, which shows the dialogs that
  already have correspondence — and not by the five-second LK2 refresh, so the provider is not polled.
- Reading the message history requires no new database object and no migration; the provider's own
  message record is the idempotency ledger, so a command that cannot be confirmed is reported as
  unavailable rather than duplicating a message.
- The audit trail for a station write is the provider's canonical message record plus a redacted LK2
  metric; PadlHub creates no local business row, therefore it writes no `audit.audit_log` entry that
  could claim success for a write it could not confirm.
- Migrating station dialogs into native PadlHub `SUPPORT` conversations (and a CUP support workspace)
  remains the documented target. This ADR does not change the `STATION` conversation kind or the
  membership/privacy question; it only stops the UI from being empty while that model is pending.

## Known limitations

- The ingest request contract is verified against the live CUP backend, but the message page
  (`beforeTs` + `limit`) is still assumed to return the newest messages, so replay and recovery can
  miss a write if the provider pages the other way. One history page stays capped at 50 messages. The
  history read walks backwards with the `nextBefore` cursor the server derives from the provider's
  ordering instant of the oldest message in the page — never from that message's display timestamp,
  which may be absent — and reports `hasMore` for a full page, so a provider that pages the other way
  ends the walk on the repeated page instead of looping, and an incomplete provider page silently
  ends the history at that point.
- `SUPPORT_LEGACY_BASE_URL` is only accepted with HTTPS outside localhost; an operator must configure
  the live contour before the flag can be enabled.
- Provider attempts are logged as metrics only; a counter for circuit state is a follow-up.
- Stored station pictures are immutable and content-addressed with no retention job, so they are kept
  as long as the operator's own record of the message exists. Deleting a provider message does not
  delete the PadlHub copy. Nothing is reused from the messaging media contour here because that
  pipeline is defined over `messaging.media_assets` rows tied to a PadlHub conversation: a station
  dialog has no conversation, and giving it one needs the membership model that stays open. The
  shared client/presign plumbing is therefore duplicated deliberately; extracting one S3 helper for
  every store is a follow-up, not part of this slice.
- The public attachment id is the digest of the stored WebP, so identical bytes produce the same id
  for any caller. Delivery rebuilds the object key from the caller's own identity, so the id is not a
  capability; it is a content fingerprint only, and it is deliberately not treated as a secret.
- The forwarded inline payload is bounded by the 4 MiB data URL the CUP workspace itself sends, and
  duplicate ids plus an aggregate that would exceed that budget are refused instead of being split
  across one oversized event.
- Follow-up finding: the composer still allows 8000 characters while the station route refuses more
  than 4000, so a long station message fails only on submit. Pre-existing, out of this slice.
- Materialization re-encodes on every history read even when the object already exists; the bounded
  page (50 messages, 4 pictures each) and the absent polling make that acceptable today.
- The provider ingest accepts an 8 000 000-character URL, so the outbound budget is bounded by the
  3 MiB stored WebP rather than by the provider contract; the live ingest body limit was not
  measured, and the CUP workspace's own 4 MiB dialog-photo cap is the only observed envelope.

## Alternatives considered

- **Native PadlHub `SUPPORT` conversations and a new CUP support workspace.** Rejected for this
  slice: it needs the missing membership/privacy decision, a new CUP workspace, and leaves existing
  LK1 dialogs either unmigrated or duplicated.
- **Client-side call to the legacy support API.** Rejected: it would put the viewer's phone and the
  legacy identifiers in the browser, outside the PadlHub API boundary.
- **Deriving the support station key from the station name.** Rejected: names are presentation data
  and would silently create a second station bucket in CUP.

## Verification

- `apps/api/src/support/station-support-routes.test.ts`: authentication, tenant gate, permission,
  idempotency key, ownership, identity fail-closed, verified-phone precedence, station binding,
  replay, replay-with-different-body conflict, ambiguous-write recovery, 2xx-without-dialog-id
  recovery, closed-dialog refusal, provider rejection, bounded list size, validation.
- `packages/database/src/station-support-repository.test.ts`: both phones, missing links,
  raw-key-over-pseudonym preference, pseudonym-only fallback, empty reverse-mapping short circuit.
- `apps/api/src/support/station-support-provider.test.ts`: request shape, exactly one phone, bounded
  retry of reads, no retry of the write, terminal 4xx without circuit impact, circuit breaker,
  timeout, oversized body, malformed success body, numeric provider ids, insecure base URL, redacted
  metrics, operator name and picture normalization, attachment array only when a picture is attached.
- `apps/api/src/support/station-support-routes.test.ts` picture cases: WebP materialization without a
  leaked provider value, refused source host, owner-scoped delivery redirect, refused uploads,
  inline WebP forwarding with a preview text, unknown attachment id, replay with a different picture
  set, and the text-only surface when the deployment has no media bucket.
- `packages/observability/src/index.test.ts`: a provider URL carrying `phone=` is never exported to
  telemetry.
- `apps/web/src/ChatsPage.test.tsx`: station list, thread, picture upload and send with its
  attachment id, operator picture rendering through an authorized blob, operator name, start dialog,
  disabled feature, and the exact HTTP request shapes.
- `apps/web/src/auth-gateway.test.ts`: the station upload request the browser actually sends; the
  earlier gap between the browser field name and the route contract is exactly what this test pins.
- `apps/api/src/support/station-support-media.test.ts`: object-key ownership, public id round trip,
  data-url and upload size bounds, the inline data-url budget, and the host allow-list with an
  untruthful chunked response.
- `apps/web/src/chats-ui/station-attachments.test.ts`: picture-only selection limits and the base64
  encoding the upload command carries.
- `apps/web/src/chats-ui/ChatsThreadKeyboardCss.test.ts`: the phone thread reserves the navigation
  strip, drops it while the composer is focused, and the reservation never applies to the desktop
  shell.
