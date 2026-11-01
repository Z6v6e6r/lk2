# Private tournament notification queries

This disabled-by-default adapter reads CUP publication metadata and current recipient
eligibility. It does not import notifications, write an outbox, send messages, install
keys, adopt streams, or recover owner state. The worker is not wired to a scheduler.

The three POST queries under `/internal/tournaments/chat-notifications/v1` are
`publications`, `recipients`, and `eligibility`. The private contract version is
`tournament-chat-notifications.v1`. Responses contain immutable message identifiers,
canonical author UUIDs, witness hashes, positions, and short-lived observations;
they contain no text or phone numbers.

Publication traversal pins the first published frontier. Every returned sequence is
contiguous, and an incomplete page below that frontier fails closed. Recipient pages
scan at most 50 of the existing 640 retained positions. Their cursor binds the fact,
frontier, immutable witness/baseline snapshot, and last scanned witness hash. An empty
eligible page can advance; membership/baseline changes require traversal restart.

The final query derives the default current witness, where participant authority
dominates organizer authority. It compares the original witness and baseline, checks
the latest read position, and excludes the canonical author. An organizer denial
does not remove a later eligible participant for the same user. New JOIN/ASSIGN
positions start at the current publication frontier and cannot receive older facts.

LK2 resolves participant identity by the original immutable JOIN generation using
the existing 0113 lookup and LIMIT 2. The existing decoder verifies hashes and
command identity. Only DISPATCHED or completed REGISTERED originals qualify for
identity resolution; current CUP proof is still required. Current active tenant,
active user and unique current forward/reverse VIVA mapping are mandatory. An
organizer UUID also resolves through the current mapping to discover participant
dominance. No session, phone or alternate identity fallback exists.

The background credential has a dedicated typ/audience/subject/scope and binds the
method, path, body hash, tenant, owner namespace and correlation UUID. Maximum token
lifetime is 30 seconds; identity and final eligibility share a five-second budget.
The client uses a two-second timeout, no retries, bounded response bytes, and a
three-failure/15-second dependency circuit. Source observations cannot make a later
provider delivery atomic; a sender would need its own separately reviewed design.

Configuration owner: tournament notification bridge. Activation requires reviewed
key installation and explicit scope/target authority; no such activation is included
here. Review or remove the disabled adapter before introducing a durable sender.
`TOURNAMENT_CHAT_NOTIFICATION_ENABLED` alone defaults to false. Dedicated issuer,
key ID, key-file and tenant/owner configuration must all be supplied when enabled.

Tests separate synthetic LOCAL protocol proof from CI-only PostgreSQL/Mongo fixture
proof. They do not establish STAGING, PROVIDER or PRODUCTION evidence.

Deduplication in `resolveRecipientPage` is page-local. Membership may change after a
recipient query, so observations from separate pages can allow different contexts
for the same canonical user. A future importer must deduplicate globally by message
and canonical user while retaining the immutable chosen context; it must never
rebind that context. Partial/error/restarted traversals must not advance a durable
watermark. It must obtain current-context proof immediately before final dispatch.
Observations can expire by the time a page returns and provide no delivery or
cancellation guarantee.
