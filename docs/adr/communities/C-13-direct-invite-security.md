# C-13: Reusable DIRECT invite security

- Status: accepted; implementation verification pending
- Date: 2026-08-04
- Accountable: Product + Backend + AppSec

## Context

Communities need a shareable DIRECT invitation that can restore a removed user without copying the
legacy `inviteCode` flow or accepting identity, role, expiry or membership state from a client.
The same link may be used by multiple authenticated people, so compromise, replay and staff-role
changes must fail closed.

## Accepted product rules

- one opaque link is reusable by multiple users;
- expiry is fixed by the server at exactly seven days after issue;
- preview never changes membership and redemption requires an explicit user action;
- redemption always creates or restores `ACTIVE/MEMBER`; an existing ACTIVE role is not downgraded;
- `REMOVED` may redeem, `BANNED` may not;
- an invite becomes unusable when its issuer is no longer an ACTIVE OWNER or ADMIN.
- any current ACTIVE OWNER or ADMIN may revoke an ACTIVE invite;
- an existing PENDING request remains a conflict and redemption does not mutate it;
- standard issuance permits fewer than five unexpired ACTIVE links and fewer than twenty successful
  ISSUE commands in the preceding rolling 24 hours per community;
- only a separately authorized CUP/Admin command with
  `communities.invite.quota.override` may create a one-use community quota grant; it must carry
  `reasonCode` and `ticketId` into command and audit evidence, expires exactly 24 hours after
  creation and never makes the CUP operator an invite issuer.

## Decision

`communities.direct_invites` is a LOCAL_ONLY aggregate. A dedicated 256-bit HMAC key derives a
43-character base64url token from tenant, issuer, community and Idempotency-Key. PostgreSQL stores
only SHA-256 of the token and a non-secret key ID. Idempotent issue replay regenerates the same raw
token from the retained key; raw tokens never enter command results, audit, outbox or logs.

The client share URL is `/community-invite#TOKEN`. The web app captures the fragment into transient
React state and immediately removes it with `history.replaceState`; API calls carry the token only
inside a `no-store` JSON body. Token is never placed in a server path, query or referrer.

Preview and redemption recheck, inside the canonical tenant transaction:

- invite ACTIVE state and seven-day expiry;
- active community;
- active issuer identity and ACTIVE OWNER/ADMIN membership;
- current viewer membership revision;
- BANNED and PENDING guards.

Redemption uses invite and membership optimistic revisions, actor-scoped idempotency, deterministic
membership-lock ordering and one transaction for membership, command result, audit and outbox.
Concurrent redemptions take a shared invite eligibility lock; revoke takes an exclusive lock. The
hot command path does not synchronously increment a shared counter. Usage can be aggregated from
successful redemption commands/events. The link has no maximum use count.

Issue replay is checked before quota evaluation and does not consume capacity twice. A new issue
serializes on one tenant/community advisory lock, then atomically enforces both limits from
PostgreSQL business facts: unexpired ACTIVE invite rows and successful ISSUE command rows created
inside the preceding rolling 24 hours. Revocation does not erase daily usage. Limit responses use
stable `COMMUNITY_DIRECT_INVITE_ACTIVE_LIMIT_EXCEEDED` and
`COMMUNITY_DIRECT_INVITE_DAILY_LIMIT_EXCEEDED` codes with a server-derived `Retry-After` value.

The User API always invokes the standard policy and its strict request schema rejects override or
grant selectors. The CUP route creates only an Admin-audience quota-exception grant: the server
verifies the exact capability and derives operator identity from the authenticated principal.
There may be at most one unexpired ACTIVE grant per community. A grant is community-scoped,
one-use and valid for exactly 24 hours.

An ordinary issue within both limits leaves the grant untouched. When either limit is exceeded,
the repository may atomically consume the ACTIVE grant under the same community lock and
transaction that creates the invite, command result, audit and outbox event. The issuer must still
be a current ACTIVE OWNER/ADMIN. Concurrent issuers cannot consume the same grant twice. Grant
creator, capability, bounded reason code, ticket ID, consumer and resulting invite are persisted in
command/audit evidence; the raw token remains excluded.

## Consequences

- Old keys must remain configured for at least the longest idempotency replay window. Removing an
  old key makes only issue replay unavailable; submitted tokens still resolve by stored hash.
- Expired rows remain ordinary retained business data; list endpoints return only unexpired ACTIVE
  metadata and never token/hash/key ID. A bounded worker claims due rows with `SKIP LOCKED`, changes
  them to EXPIRED and emits audit/outbox state.
- Feature rollout requires migrations 0058 and 0059, a configured keyring, real-PostgreSQL
  concurrency coverage for both quotas, Admin/User contract tests and staging smoke tests. Product
  policy is accepted; the flag remains off until those technical gates pass.
