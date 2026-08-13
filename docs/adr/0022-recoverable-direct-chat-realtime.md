# ADR 0022: Recoverable direct-chat realtime

Status: Accepted

## Decision

Direct-chat realtime is an optional, tenant-gated delivery hint over the authoritative HTTP and
PostgreSQL history. API issues a 30-second one-time JWT ticket bound to tenant, user and refresh
session family. The ticket is sent in the first WebSocket frame, never in a URL. API and realtime
both revalidate current gates, user permission and session authority; subscription and every
fanout revalidate active conversation membership.

RabbitMQ events contain only tenant, conversation, message and sequence identifiers. Each realtime
instance owns an exclusive fanout queue so every node can reach its local sockets; `prefetch(1)`
plus per-conversation serialization preserves projection order. Queue loss during a restart is
recovered from HTTP history rather than pretending RabbitMQ is the source of truth.
Invalid envelopes produce a durable, publisher-confirmed quarantine record containing only routing
key, reason and content hash; the raw invalid body is not copied. Transient projection or broker
failures remove readiness and reconnect the consumer; they are not acknowledged as success.

The browser treats every event as a recovery trigger and reads `GET messages?afterSequence=`.
Commands remain HTTP-only. The existing five-second polling loop stays active as a fallback.

## Consequences

- Lost, duplicate or delayed broker events cannot corrupt durable history.
- Logout, permission removal and membership removal terminate or deny realtime without waiting for
  JWT expiry; idle sockets are rechecked periodically.
- Realtime can be rolled back with only its tenant gate while HTTP chat remains available.
- Presence, typing, edits/deletes and contextual chats need separate contracts and are not implied
  by this decision.
