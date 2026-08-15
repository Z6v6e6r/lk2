# Communities realtime readiness

## Current verdict

`DURABLE RECOVERY AND AUTHORIZED FAN-OUT READY LOCALLY; PRODUCTION NO-GO`.

The current slice proves one-time authentication, session and tenant binding, membership
authorization, heartbeat, bounded connections/subscriptions/commands, backpressure, durable
per-community sequence, identifier-only RabbitMQ hints and authorized HTTP gap recovery. Production
still requires the measured capacity and failure-mode evidence below.

## Staging configuration

Keep production at `COMMUNITIES_REALTIME_ENABLED=false`. For the isolated staging gate:

```dotenv
COMMUNITIES_REALTIME_ENABLED=true
# Inject a dedicated secret; never reuse JWT_ACCESS_SECRET or JWT_REFRESH_SECRET.
JWT_REALTIME_SECRET=<staging secret of at least 32 characters>
REALTIME_MAX_CONNECTIONS=10000
REALTIME_MAX_SUBSCRIPTIONS_PER_CONNECTION=100
REALTIME_MAX_SOCKET_BUFFER_BYTES=524288
REALTIME_HEARTBEAT_INTERVAL_MS=30000
REALTIME_DATABASE_POOL_MAX=10
REALTIME_DATABASE_POOL_WARM_CONNECTIONS=2
# Exact rollout target; every live replica must declare the same value.
REALTIME_EXPECTED_REPLICAS=2
# Stable and unique for each replica; do not reuse it during an overlapping rollout.
OTEL_SERVICE_INSTANCE_ID=<staging-realtime-replica-id>
```

The ingress WebSocket idle timeout must exceed two heartbeat intervals. The process/container file
descriptor ceiling must exceed the configured connection limit plus database, Redis, ingress and
operational descriptors.

The staging realtime container uses `/etc/phub/realtime.env`, a service-specific secret file containing
`JWT_REALTIME_SECRET` and must not receive `JWT_ACCESS_SECRET` or `JWT_REFRESH_SECRET`. The API
container needs its normal access/refresh secrets plus the same realtime signing key. Run
`deploy/jetson/verify-runtime-env-isolation.sh` before migrations or container replacement; it
checks deployment-user ownership, mode `0600`, readability by the exact Compose execution identity,
secret separation and key equality without printing values. Root-owned `0600` files are invalid
unless every Compose and verification call uses an audited restricted sudo wrapper.

## Functional smoke

1. Authenticate through the normal PadlHub client flow.
2. Call `POST /user/api/v1/{tenantKey}/realtime/tickets`; verify `Cache-Control: no-store` and a
   30-second `expiresAt`.
3. Open `/realtime/v1/{tenantKey}` without putting the ticket in the URL.
4. Send `{ "type": "authenticate", "ticket": "..." }` as the first frame.
5. Expect `connection.ready` and then send
   `{ "type": "community.subscribe", "communityId": "<PadlHub UUID>" }`.
6. For an ACTIVE member expect `community.subscribed` with current community and membership
   revisions, `latestSequence` and `delivery=DURABLE_SEQUENCE_HTTP_RECOVERY`.
7. Publish a synthetic canonical post through User API and record the `community.event` sequence.
   Recover it independently with
   `GET /user/api/v1/{tenantKey}/communities/{communityId}/events?afterSequence=0&limit=100`.
   Verify that bodies are absent, sequences are increasing and the response headers expose latest
   and retained-from sequence values.
8. Disconnect before another write, reconnect, and recover strictly after the last applied sequence.
   A future cursor must return `COMMUNITY_EVENT_CURSOR_AHEAD`; an expired cursor must return
   `COMMUNITY_EVENT_GAP_EXPIRED` and trigger a canonical feed reload.
9. Confirm the same ticket fails with close code `4401`, a revoked session fails with `4401`, and a
   non-member receives `COMMUNITY_NOT_FOUND`.
10. Confirm `/health/ready` fails closed if PostgreSQL, Redis, or the enabled RabbitMQ consumer is
    unavailable.

RabbitMQ error, connection close or a broker-side consumer cancellation immediately marks the
shared realtime readiness check unavailable, closes both consumers/channels and returns
`/health/ready` 503. The process performs bounded reconnects and recreates both exclusive consumers;
readiness returns to 200 only after both registrations succeed. Clients recover every missed
sequence through the HTTP event endpoint. Prove the 503→200 transition and consumer re-registration
under a bounded broker interruption before production activation.

Never use a successful acknowledgement or a received hint alone as persistence evidence.

The realtime process exports bounded-cardinality OTLP metrics for active/rejected connections,
authentication outcomes, subscription outcomes, accepted/invalid hints, delivered fan-out
recipients, fan-out failures and backpressure closures. Labels are restricted to fixed
`outcome`/`reason` values; tenant, user, session and community identifiers belong only in
correlated structured logs. Prometheus alerts cover invalid contracts, fan-out failures, capacity
rejections and sustained slow-client shedding. A fan-out alert does not imply lost canonical data:
use `messageId` and `correlationId` to inspect the outbox event, then verify HTTP sequence recovery.

The local functional gate on 2026-08-04 used two independent headed browser sessions. One session
published through the canonical User API while the other observed the post without a page reload
and recovered `/events?afterSequence=0`. The subscriber was then forced offline, a second post was
published, and reconnect recovered `/events?afterSequence=1` before the feed rendered both posts.
This is functional evidence only; it does not replace the staging capacity gate below.

Authenticated session/context responses expose server-owned `runtimeCapabilities`. The Web client
treats the optional expand-release field as all false when absent. Invite management mounts only
when `communityDirectInvites=true` and canonical membership is ACTIVE with OWNER/ADMIN role.
Realtime starts only when `communityRealtime=true`. Runtime availability never replaces endpoint
authorization and is never duplicated in a client build-time environment variable.

A flag-off ticket response with `COMMUNITIES_REALTIME_DISABLED` is terminal: the released client
stops reconnecting and continues with canonical HTTP reads. This behavior is a mandatory rollback
smoke because otherwise every open community view could create a ticket retry storm.

## Web durable-recovery controller

`apps/web/src/community-durable-event-controller.ts` is the transport-independent client boundary.
It does not open a WebSocket. The session transport passes `{ communityId, sequence }` hints into
`handleHint`; the controller calls `recoverCommunityEvents(afterSequence)`, checks strict sequence
continuity and invokes one canonical invalidation/refetch callback per recovered page. The cursor
advances only after that callback succeeds, so a failed HTTP refresh is retried from the previous
durable sequence rather than silently skipping visible state.

The caller owns detail/feed/media loaders through `reloadCanonicalState`. On
`COMMUNITY_EVENT_GAP_EXPIRED` with `FULL_CANONICAL_RELOAD`, the controller clears the local cursor,
awaits a reload of all three scopes and only then resumes at the server-provided latest sequence. A
failed reload leaves the cursor cleared. Page discontinuity uses the same fail-closed canonical
reload. No event body or WebSocket hint becomes client-owned canonical state.

`apps/web/src/community-realtime-transport.ts` is the separate WebSocket adapter. It receives the
endpoint, one-time-ticket issuer and socket factory from the caller; tickets are sent only in the
first `authenticate` frame and URLs with credentials, query strings or fragments are rejected. The
adapter is owned once per authenticated web session and opens lazily only while at least one ACTIVE
community member view is mounted. Multiple consumers use reference-counted dynamic subscriptions;
public non-member reading remains HTTP-only. The client limit is 20 active subscriptions, below the
server limit and compatible with its 20 subscribe commands/minute budget.

The adapter waits for `connection.ready`, subscribes, exposes the server `latestSequence`, validates
identifier-only events and forwards only `{ communityId, sequence }` to the recovery controller.
On the first acknowledgement at sequence `S0`, the detail page first reloads the canonical detail
and feed together, atomically installs that snapshot, then associates it with `S0`; hints buffered
during that refresh recover strictly after `S0`. On reconnect, the existing cursor is retained and
the acknowledged head is treated as a recovery hint, never as permission to skip a gap.

Every connection attempt obtains a new one-time ticket. The transport applies bounded exponential
backoff, waits at least 60 seconds after `4429`, at least 5 seconds after `1013`, retries one `4401`
with a fresh ticket and then requires re-authentication. Protocol/disabled errors stop retrying;
community-not-found disables only that subscription. Going offline closes the socket, while merely
hiding a mobile tab keeps a healthy socket and only prevents a new connection until visible. Stop,
logout and unmount suppress callbacks from pending ticket requests and stale sockets.

`apps/web/src/community-realtime-url.ts` derives the same-origin WebSocket endpoint from the trusted
PadlHub API base and rejects credentials, query strings and fragments. Local Vite routes
`/realtime` to the dedicated realtime process with WebSocket upgrade enabled. Both deployment Nginx
templates use a 90-second read timeout, which exceeds two 30-second heartbeat intervals.

## Capacity gate still required

On the exact staging ingress and instance type, prove:

- 10,000 authenticated sockets per instance and 20,000 across two instances for 30 minutes;
- 2,000 subscribers in one hot community;
- reconnect storm of 1,000 connections per second with ticket issue rate controlled separately;
- heartbeat survival and cleanup after client/network loss;
- slow-client buffer closure without process-wide latency or memory runaway;
- command p95 at or below 250 ms and error rate below 1%;
- stable RSS, event-loop lag, CPU, file descriptors, Redis latency and PostgreSQL pool wait.

Exact staging API URL, realtime URL and a synthetic-user token provisioning method are mandatory
inputs. Do not reuse production user sessions or invent credentials.

The external load fixture is secret-mounted outside the checkout and contains one unused ticket per
connection. Certification requires exactly 20,000 connections, at least 1,000 additional unused
reconnect tickets, a foreign-tenant `deniedCommunityId` probe and at least one `slowClient` probe.
It also carries the exact externally committed event contract, so unrelated fan-out cannot satisfy
the gate:

```json
{
  "expectedOrigin": "wss://staging.example",
  "connections": [
    {
      "ticket": "unused-one-time-ticket",
      "reconnectTicket": "second-unused-one-time-ticket",
      "communityId": "00000000-0000-4000-8000-000000000001",
      "deniedCommunityId": "00000000-0000-4000-8000-000000000099"
    },
    {
      "ticket": "unused-slow-client-ticket",
      "communityId": "00000000-0000-4000-8000-000000000001",
      "slowClient": true
    }
  ],
  "expectedEvent": {
    "communityId": "00000000-0000-4000-8000-000000000001",
    "eventType": "community.post.edited.v1",
    "targetType": "POST",
    "targetId": "00000000-0000-4000-8000-000000000002",
    "targetRevision": 2,
    "minimumSequence": 100
  }
}
```

The fixture is an owned regular file outside the checkout, mode `0600` or stricter and at most
32 MiB for 20,000 one-time tickets. `expectedOrigin` must exactly match the approved non-production
realtime ingress; no ticket is sent before this comparison succeeds.

Commit that exact synthetic target only after the harness reports all subscriptions established.
Then produce an approved bounded burst of synthetic events in the isolated hot community so the
paused slow-client transport exceeds the configured server buffer; stop the burst as soon as the
probe is shed. The exact expected event declared in the fixture must be one event in that burst, and
the burst must be large enough to fill `REALTIME_MAX_SOCKET_BUFFER_BYTES` on the paused client.
Record the event count and never run this profile against a shared tenant.
Certification defaults to a 30-minute hold, requires at least one matching delivery on every
non-slow connection, verifies denied subscriptions, requires the slow client to be shed with 1013,
and measures at least 1,000 reconnects at 1,000 connections/second. A loopback run defaults to 60
seconds and can selectively enable the probes. Certification refuses shorter holds, fewer/slower
reconnects or disabled security/failure probes. `COMMUNITIES_REALTIME_CERTIFICATION=false` is only
a local diagnostic override and its output is never release evidence.

## Production gate

The implementation prerequisites are complete locally. Production remains blocked until the
following are proven on staging:

- canonical per-community sequence is allocated atomically with content/audit/outbox;
- HTTP recovery returns every authorized event after the supplied sequence;
- RabbitMQ redelivery does not duplicate visible effects;
- membership removal/ban prevents the next fan-out event;
- broker or realtime outage does not affect HTTP history and recovery;
- rollback disables `COMMUNITIES_REALTIME_ENABLED` without changing canonical data.
