# Two-player messaging readiness — 2026-08-05

## Decision

Integration commit `d730259` is **BLOCKED** for an A-to-B chat test. The User API does not mount
conversation routes, its OpenAPI/SDK contains no messaging operations, and the current API test
intentionally keeps chat hidden with `FEATURE_UNAVAILABLE`. The realtime process at this commit is
only the generic ticket handshake; it cannot make the missing HTTP messaging source of truth usable.

HTTP M1 is sufficient for the minimum honest 2026-08-05 acceptance. Realtime is not required if
the result is described as "B receives the message after explicit refresh or bounded polling". Do
not describe this as instant delivery, push or realtime. PostgreSQL history, not a WebSocket marker,
is the acceptance source of truth.

The old `0ddae6c` M1, `b8c50f5` M2 and `00a98e9` GAME/M3 commits are review evidence, not merge
candidates. They are based on a divergent line, and their migration numbers `0043`/`0044` are
already occupied by `0043_community_member_rank.sql` and `0044_profile_level_history.sql` on the
integration line. `00a98e9` does not modify the realtime process and therefore inherits every M2
blocker below. Reimplement M1 narrowly with a new migration number and current auth/privacy
contracts before any environment test; do not use the old claim "Nano canary active" as current
runtime evidence.

## Minimum honest A-to-B acceptance

All preflight gates below must pass first. Then, in an owner-approved mutation window using two
existing internal accounts and one existing direct conversation:

1. Record the exact CI commit and immutable API/Web image digests; `/manifest.json.release` must
   equal that commit.
2. In two independent signed-in browser sessions, A and B open the same conversation. Record its
   PadlHub UUID and current highest server sequence `N` without copying existing message bodies.
3. A sends exactly one uniquely labelled, non-sensitive test message with a fresh
   `Idempotency-Key` and `clientMessageId`. The HTTP response must return one message UUID and
   sequence `N+1`.
4. B explicitly refreshes, or waits for documented HTTP polling, and reads history after `N`. The
   response and rendered UI must contain the same message UUID, sequence `N+1` and body exactly
   once within 10 seconds.
5. Replay A's identical command with the same keys. It must return the original message with
   `replayed=true`; history must still have no sequence `N+2` from that command.
6. B advances the read cursor through `N+1`; replay returns the stored result. An existing tenant
   outsider, if the owner supplies one, receives indistinguishable 404 responses for history/send.
7. Correlate API audit/outbox evidence using correlation IDs. Rabbit and logs may contain message,
   conversation and tenant identifiers, but never the text body or access credentials.

Passing only route probes, health endpoints, unit tests, an A-side 200, or a realtime marker is not
an A-to-B acceptance.

## Read-only preflight

The repository preflight uses GET only. It never creates users, conversations, tickets, messages or
read cursors and never prints tokens or response content. Store values in a mode-0600 environment
file rather than shell history:

```text
MESSAGING_PREFLIGHT_BASE_URL=https://lk.nano.padlhub.su
MESSAGING_PREFLIGHT_TENANT_KEY=local-padel
MESSAGING_PREFLIGHT_EXPECTED_RELEASE=<full-ci-commit-sha>
MESSAGING_PREFLIGHT_PLAYER_A_TOKEN=<short-lived-existing-session-token>
MESSAGING_PREFLIGHT_PLAYER_B_TOKEN=<short-lived-existing-session-token>
MESSAGING_PREFLIGHT_CONVERSATION_ID=<existing-a-b-conversation-uuid>
```

Run:

```bash
node --env-file=/secure/path/messaging-preflight.env \
  --import tsx scripts/preflight-messaging-two-player.ts
```

Required `HTTP_M1_PREFLIGHT_PASS` evidence:

- immutable manifest matches the intended commit;
- public readiness returns ready JSON, not an SPA shell;
- anonymous conversations request reaches `401 AUTH_REQUIRED`, not `404 ROUTE_NOT_FOUND`;
- A and B each receive a no-store conversation list;
- both can read the same existing conversation history;
- `mutationCount` is zero.

If no existing conversation is available, the preflight must remain `BLOCKED`. The owner must
explicitly authorize a separate direct-conversation creation window; the reviewer must not create
one merely to turn the preflight green.

## Old M2 safety audit

| Gate                      | Old M2 evidence                                                                                                                                    | Decision                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| One-time ticket           | 30-second JWT, issuer/audience/scope/tenant claims, Redis `GETDEL`, ticket sent in first frame rather than URL                                     | **ACCEPT code-level**               |
| Membership recheck        | subscription queries active membership; every fanout resolves current active recipients from canonical message/sequence                            | **ACCEPT code-level**               |
| Identifier-only event     | outbox and WebSocket marker carry tenant/conversation/message IDs and sequence, not body                                                           | **ACCEPT code-level**               |
| Ordered fanout            | Rabbit consumer has no `prefetch(1)` or keyed serializer; async handlers can complete out of order                                                 | **BLOCKER**                         |
| HTTP gap recovery         | subscribe emits latest sequence/gap; Web merges HTTP pages by sequence and polls every 5 seconds                                                   | **ACCEPT code-level, E2E required** |
| Rabbit readiness          | readiness checks Rabbit, but connection/channel close only flips a flag; process stays alive without reconnecting consumers                        | **BLOCKER**                         |
| Invalid-event retention   | consumer acknowledges rejected events in `finally` without DLQ/quarantine                                                                          | **BLOCKER**                         |
| Session/member revocation | `sid` is signed but not rechecked by realtime; active socket has no bounded lifetime; removed member stops receiving fanout but remains subscribed | **BLOCKER before public rollout**   |
| Abuse controls            | payload, subscription count and socket buffer are bounded; command rate and repeated membership-query rate are not                                 | **BLOCKER before public rollout**   |

Do not port M2 until current M1 exists and passes HTTP acceptance. A future M2 candidate must add
serial broker processing or per-conversation ordering, fail-fast/reconnect with consumer recovery,
DLQ handling, session/socket revocation semantics and command rate limits. Its separate test must
prove ticket replay rejection, removed-member denial, ordered sequences under concurrent publish,
Rabbit restart recovery and exact HTTP gap fill. Disabling realtime must leave M1 fully usable.

## Owner-provided inputs and access

The owner must provide or coordinate:

- target canonical URL, tenant key, intended CI commit and four immutable service digests;
- two consenting existing internal users in the same tenant, authenticated through normal login;
- an existing A/B conversation UUID, or explicit approval to create one during a bounded window;
- confirmation that A may start/direct-message B under current permission and privacy policy;
- short-lived A/B sessions delivered through an approved secret channel, never pasted into tickets,
  logs or chat transcripts;
- exact test window, one-message consent, retention/removal decision and rollback owner;
- read-only access to release manifest, service readiness, correlation-safe API/worker logs, outbox
  age and Rabbit consumer/queue metrics;
- authority to enable only HTTP/direct gates for the internal tenant and to disable them immediately.

Realtime additionally requires a separately reachable realtime readiness endpoint, authority to
issue one audited short-lived ticket per session, Rabbit restart/canary coordination and approval to
exercise disconnect/reconnect. None of those is required for the 2026-08-05 HTTP M1 acceptance.
