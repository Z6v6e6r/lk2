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
  identified by the viewer's phone number and keeps one dialog per station.
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
- `SUPPORT_STATIONS_ENABLED` is default-off and requires `SUPPORT_LEGACY_BASE_URL`. The provider
  client is bounded (timeout, at most two attempts with backoff, per-operation circuit breaker,
  bounded response body, `redirect: 'error'`, HTTPS-only base URL outside localhost) and emits only
  redacted metrics: no phone, no message body.

## Consequences

- CUP keeps one support inbox and one dialog per viewer and station. Existing LK1 dialogs stay
  visible when the viewer's verified phone is the number CUP already stored; when the two phones
  differ, the verified identity wins and older dialogs under the provider-asserted number are not
  enumerated. That trade is deliberate: reading a recycled number's history is the worse failure.
- The provider receives the PadlHub user UUID (`externalUserId`, `externalChatId`) so it can link the
  CUP client to a PadlHub account. That value is a pseudonymous internal identifier, not PII, and it
  is the only PadlHub identifier shared with the legacy contour.
- The station tab is provider-backed and deliberately outside the LK2 conversation contract: it has
  no realtime subscription, no notification policy, no attachments and no unread cursor. Its list is
  loaded lazily on that tab, not by the five-second LK2 refresh, so the provider is not polled.
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

- The provider's real response shape is unverified: the message page (`beforeTs` + `limit`) is
  assumed to return the newest messages, so replay and recovery can miss a write if the provider
  pages the other way. History is capped at 50 messages with no pagination.
- `SUPPORT_LEGACY_BASE_URL` is only accepted with HTTPS outside localhost; an operator must configure
  the live contour before the flag can be enabled.
- Provider attempts are logged as metrics only; a counter for circuit state is a follow-up.

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
  metrics.
- `packages/observability/src/index.test.ts`: a provider URL carrying `phone=` is never exported to
  telemetry.
- `apps/web/src/ChatsPage.test.tsx` and `apps/web/src/auth-gateway.test.ts`: station list, thread,
  text-only composer, start dialog, disabled feature, and the exact HTTP request shapes.
