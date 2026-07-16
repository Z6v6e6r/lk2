# ADR 0006: Chats, notifications and moderation over shared delivery infrastructure

- Status: accepted
- Date: 2026-07-14
- Extends: [ADR 0001](0001-modular-monolith.md)

## Context

PadlHub needs one product area for:

- trigger-driven system notifications;
- CUP correspondence through external connectors;
- chats bound to a game, tournament or community;
- direct user-to-user conversations;
- Web, iOS and Android push delivery;
- CUP and optional external moderation/control signals.

RabbitMQ, WebSocket and connector APIs provide transport but do not define durable product state.
Treating a connector thread, broker queue or realtime connection as the source of truth would make
history, authorization, unread state and retries inconsistent between web, mobile and CUP.

## Decision

Create two `LOCAL_ONLY` domain aggregates and one `LOCAL_ONLY` control module inside the modular
monolith:

1. `messaging` owns conversations, membership, monotonically ordered messages, attachment metadata,
   revisions and per-member read cursors.
2. `notifications` owns templates, trigger rules, recipient intents, inbox items, preferences,
   channel deliveries and attempt history.
3. `moderation` owns reports, policy versions, review cases and immutable enforcement actions.

Connector accounts, encrypted delivery endpoints and external contact/thread/message identifiers
belong to `integration`. Connectors can ingest or deliver content but never become a write owner.
The same rule applies to external moderation providers: they submit deduplicated signals or
recommendations, while only PadlHub policy or an authorized moderator applies a state change.

All durable state is committed to PostgreSQL. Commands that publish content write business state,
an audit record and an outbox event in one tenant-scoped transaction. RabbitMQ delivers
identifier-only events at least once; consumers use inbox/provider idempotency and bounded retries.
Realtime is a recoverable projection. The client sends messages through the HTTP API, receives
ordered events through a ticket-authenticated WebSocket and fills any sequence gap through HTTP.

Notifications and chat messages remain distinct. A policy may explicitly create both from one
domain event, but an inbox notification never silently changes conversation history.

Push uses distinct Web Push/VAPID, APNs and FCM adapters behind one notification delivery port.
Registration records are encrypted per installation. Provider acceptance, delivery receipts,
client display and user open are different facts and must not be collapsed into one success state.

## Consequences

- Direct, contextual and support chats share one authorization and ordering engine.
- CUP connector screens can switch providers without changing PadlHub conversation IDs.
- Trigger rules and templates can evolve independently from message history.
- Web, iOS and Android push transports can change provider details without changing notification
  intent or inbox contracts.
- External moderation can improve detection without delegating PadlHub authorization or data
  ownership.
- Delivery is at-least-once, not falsely exactly-once; every boundary therefore needs deduplication.
- Message content, destinations and raw connector payloads must not enter logs, traces, metrics or
  broker events.
- The first migration is expand-only. API, worker, realtime and CUP behavior can be enabled in
  vertical slices without a destructive schema rollback.
