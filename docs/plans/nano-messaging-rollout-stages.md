# Nano messaging and notifications rollout stages

## Current delivery boundary

| Stage                | State                                | Testable result                                                                  |
| -------------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| Foundation           | complete                             | Tenant-scoped PostgreSQL schema, RLS/FORCE RLS, audit and identifier-only outbox |
| M1 direct HTTP       | complete                             | Create/list direct conversations, ordered history/send and monotonic read cursor |
| M2 direct realtime   | implementation complete, runtime off | Single-use ticket, member subscription, RabbitMQ fanout and HTTP gap recovery    |
| In-app notifications | complete, separately gated           | Inbox, unread/read cursor and manual CUP delivery                                |
| Web Push             | complete, separately gated           | VAPID registration/delivery with provider and tenant gates                       |

No messaging gate is enabled by a migration or image deployment. Nano activation is a separate
reviewed operation.

## Remaining stages

1. **M2 Nano canary.** Promote one immutable digest, keep gates off, verify readiness and HTTP
   expected-auth responses, then enable HTTP/direct/realtime for one internal tenant and two test
   users. Roll back realtime independently.
2. **M3 contextual chats.** Add `GAME`, `TOURNAMENT` and `COMMUNITY` creation and membership
   projectors. Membership follows the owning aggregate lifecycle; clients cannot choose or merge a
   source.
3. **M4 message lifecycle and safety.** Add edit/delete tombstones, private attachments with
   malware scan, rate limits and user reports. Preserve server sequence and immutable revisions.
4. **M5 CUP support and one connector.** Add support assignment, external contact mapping,
   inbound/outbound deduplication, bounded retry and DLQ replay. Canonical message state remains in
   PostgreSQL.
5. **M6 moderation.** Add CUP case queue, immutable decisions, reversible quarantine and one
   external provider in `SIGNAL_ONLY`. External services never apply authoritative changes.
6. **M7 native delivery completion.** Add APNs and FCM adapters plus displayed/opened receipts.
   Web Push and in-app stay independently operable during a native-provider incident.
7. **Production expansion.** Load/soak tests, backup/restore rehearsal, sequential-node rollout,
   monitored tenant expansion and tested digest rollback.

## How to test M1 and M2

### Automated gate

Run `npm run check`, `npm run db:migrate:check` and `docker compose config`. A clean PostgreSQL 16
database must accept every migration. Unit/contract tests cover gates, idempotency, one-time ticket
consumption, membership denial, identifier-only broker payloads and Web reconnect behavior.

### Local end-to-end

1. Start PostgreSQL, Redis, RabbitMQ, API, worker, realtime and Web.
2. Apply migrations and seed two active PadlHub users in one synthetic tenant plus one outsider.
3. Grant `chat.direct.create` only to the user who starts the conversation.
4. Enable `http` and `direct`; verify the entire M1 two-user journey and outsider 404.
5. Enable `realtime`; open two independent browser sessions on `/chats/{conversationId}`.
6. Send in both directions and verify the second session updates without waiting for polling.
7. Disconnect one browser, send at least two messages, reconnect and verify exact HTTP gap recovery.
8. Reuse a ticket, alter tenant/conversation UUIDs and remove membership; verify rejection without
   cross-tenant or conversation existence disclosure.
9. Search logs and RabbitMQ bodies for message text, ticket and external identifiers; none may be
   present.

### Nano canary

Deploy the same immutable API/worker/realtime/Web digests that passed CI. Before gates are enabled,
verify manifest SHA, API/realtime readiness and expected authentication failures. Enable only the
internal tenant, capture correlation IDs and sequences for the two-browser journey, then observe
outbox age, RabbitMQ queue health, reconnect rate, realtime errors and HTTP fallback for at least
one test window. Disable `realtime` to prove polling fallback before expanding access.
