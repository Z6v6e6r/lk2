# Direct chat acceptance test — 2026-08-05

## Goal

Prove, in the selected staging environment, that one existing active PadlHub player can send a text
message to another existing active PadlHub player and that the recipient reads the same canonical
message from PostgreSQL through the PadlHub User API and Web UI.

This test accepts the HTTP M1 vertical slice. WebSocket delivery, push delivery and external
messenger delivery are separate gates and are not used as substitutes for canonical message
persistence.

## Owner-provided inputs

The test owner must confirm these values before any staging mutation:

- target environment and canonical HTTPS origin;
- tenant key;
- existing active PadlHub UUID and login/session for player A;
- existing active PadlHub UUID and login/session for player B;
- confirmation that both accounts belong to the same tenant and player A has
  `chat.direct.create`;
- approved test message text that contains no personal or production-sensitive data;
- operator PadlHub UUID with authority to change the tenant messaging runtime.

Do not create accounts, expose credentials, copy Viva identifiers or guess user UUIDs to satisfy
these inputs.

## Release preflight

1. Merge the accepted integration SHA and build one immutable image set.
2. Promote the same digests to staging; record the manifest SHA and rollback digests.
3. Verify a restorable PostgreSQL backup before applying the expand-only migration.
4. Apply migrations outside API startup and verify RLS plus `FORCE RLS` on all new messaging
   runtime/idempotency tables.
5. Verify API, worker and PostgreSQL readiness. RabbitMQ is required for outbox delivery evidence,
   but an event must never contain message text.
6. Keep all messaging runtime gates off while performing unauthenticated, cross-tenant and
   permission-denial checks.
7. Run the messaging runtime command in dry-run mode, inspect tenant/operator identities, then
   enable only HTTP and direct messaging. Keep realtime and contextual messaging off.

## Acceptance journey

1. Player A and player B sign in using separate browser profiles or devices.
2. Player A opens the explicit direct-chat link containing player B's PadlHub UUID. No global
   player directory is assumed by M1.
3. The client creates or reuses the normalized direct conversation with an `Idempotency-Key`.
4. Player A sends the approved text with a stable `clientMessageId` and a new `Idempotency-Key`.
5. Repeat the exact send command. The API must return the original message and allocate no second
   sequence.
6. Player B opens the conversation. HTTP polling/history must return the message with the same
   `messageId`, `conversationId`, body and server sequence.
7. Player B advances the read cursor, then repeats the command. The second result must be an
   idempotent replay and unread count must stay zero.
8. Do not send an additional message as part of the minimum acceptance. HTTP gap recovery is a
   separate, separately approved mutation scenario; the Wednesday one-message test proves the
   recipient path through bounded polling/history.

## Negative and privacy checks

- a third user and a user from another tenant cannot list the conversation or read/send messages;
- reusing an idempotency key with a different recipient/body fails with the stable conflict code;
- a disabled runtime returns the documented unavailable/disabled response and the UI does not
  advertise a working chat;
- logs, traces, metrics, RabbitMQ payloads, audit values and outbox payloads contain identifiers and
  sequence only, never message body, phone, email, push token or Viva identifier;
- one message, one audit command result and one identifier-only outbox event are committed in the
  same PostgreSQL transaction;
- outbox lag returns to baseline and the dead-letter queue does not grow.

## Evidence package

Capture and retain without credentials or message-sensitive payloads:

- deployed manifest SHA and immutable image digests;
- migration check, RLS/FORCE RLS query and runtime dry-run/apply result;
- correlation IDs for create, first send, replay, recipient history and read-cursor replay;
- screenshots from both player sessions with UUIDs and tokens redacted;
- database evidence for one conversation, two active members, ordered sequence and read cursor;
- outbox/RabbitMQ metadata showing identifier-only delivery and zero unexpected DLQ growth;
- rollback confirmation by disabling HTTP/direct gates after the test if the contour is not yet
  approved for continued staging use.

## Go/no-go

The Wednesday test is **GO** only when the integration branch passes `npm run check`, the target
environment and two users are confirmed, the release preflight is green and the negative checks can
be executed. It is **NO-GO** if identities are guessed, backup/RLS evidence is missing, any client
calls Viva directly, message text reaches telemetry/broker payloads, or recipient visibility is
proved only by a sender-side response.
