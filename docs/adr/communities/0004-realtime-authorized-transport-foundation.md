# ADR: Communities realtime authorized transport foundation

- Status: accepted for staging implementation
- Date: 2026-08-04
- Production status: `NO-GO`

## Context

The existing realtime process authenticated a long-lived JWT and returned only
`connection.ready`. It did not consume a one-time credential, verify the live PadlHub session in
PostgreSQL, authorize community membership, bound connection count or command rate, detect dead
sockets, or protect the process from a slow client buffer.

The original transport foundation did not have a durable per-community sequence. The follow-up
slice now stores identifier-only events in PostgreSQL and uses RabbitMQ only to reduce delivery
latency; PostgreSQL remains the only recovery authority.

## Decision

Implement the transport and durable recovery as a staging-only slice:

1. `POST /user/api/v1/{tenantKey}/realtime/tickets` requires a PadlHub user JWT and a live refresh
   session family. It returns a 30-second HS256 JWT with audience `phub-realtime`, signed with a
   dedicated `JWT_REALTIME_SECRET` that is distinct from API access and refresh secrets.
   When the gate is enabled outside local/CI, realtime startup rejects an environment containing
   `JWT_ACCESS_SECRET` or `JWT_REFRESH_SECRET`; API and realtime therefore require separate secret
   files/mounts.
2. Redis stores only `ticket jti -> session sid` for 30 seconds. The gateway uses atomic `GETDEL`,
   so replay fails closed. Tickets never appear in a URL, log, audit value or browser cache.
3. The gateway rechecks the session in PostgreSQL at authentication and before every client
   command. The presented `sid` may be a recently rotated member of a family only while that
   family still has one active, unrevoked current session.
4. `community.subscribe` succeeds only for an `ACTIVE` user, `ACTIVE` community and `ACTIVE`
   canonical membership in the same tenant. `not found` and `not authorized` are indistinguishable.
5. A process accepts at most `REALTIME_MAX_CONNECTIONS`, at most
   `REALTIME_MAX_SUBSCRIPTIONS_PER_CONNECTION` topics per connection, 60 commands and 20 subscribe
   attempts per minute. A shared ping/pong sweep removes dead sockets. A client exceeding the
   bounded write buffer is closed with retryable overload semantics.
6. PostgreSQL and Redis are readiness dependencies. Realtime has its own database pool budget and
   warms that pool before listening.
7. Every content/moderation transaction allocates a monotonic per-community sequence, stores an
   identifier-only event, and writes audit/outbox in the same PostgreSQL transaction.
8. Authorized members recover gaps through HTTP after a sequence. A cursor ahead of the head and a
   cursor older than retained history produce distinct stable reset outcomes.
9. Realtime consumes versioned identifier-only RabbitMQ events, suppresses duplicate sequence hints
   per process, and revalidates user, membership and live session family in bounded batches before
   fan-out. The acknowledgement says `delivery=DURABLE_SEQUENCE_HTTP_RECOVERY`.
10. `COMMUNITIES_REALTIME_ENABLED=true` remains rejected in production until the operational proof
    below passes.

## Implemented locally

- Allocate a monotonic sequence in the same PostgreSQL transaction as canonical community content,
  audit and outbox.
- Store an identifier-only durable community event log that supports keyset reads after a sequence.
- Add an authorized HTTP recovery endpoint and define reset semantics for a cursor beyond the
  latest retained sequence.
- Consume only versioned identifier-only RabbitMQ events. RabbitMQ and Redis may trigger hints;
  neither stores canonical history.
- Revalidate current membership for every fan-out recipient, so removal/ban takes effect before
  the next event can be disclosed.

## Required proof before production

- Prove reconnect, duplicate broker delivery, gap recovery, hot-community fan-out, slow clients,
  process loss and broker outage on the exact staging topology.

## Capacity assumptions

- Default limit: 10,000 sockets per realtime process; target deployment has at least two instances
  for the accepted 20,000 concurrent-connection burst.
- Connection memory, file descriptors and ingress idle timeouts must be measured on the staging
  instance type; configuration limits are safety boundaries, not capacity evidence.
- PostgreSQL is queried on authentication and commands, not on every heartbeat. Event fan-out will
  use a bounded recipient authorization query rather than one query per socket.

## Consequences

Clients can safely integrate ticket acquisition, authorized subscriptions and HTTP recovery in
staging without creating a second source of truth. Visible data and event recovery remain
HTTP/PostgreSQL-authoritative; realtime is an optional latency optimization. Production stays
`NO-GO` until the measured proof succeeds.
