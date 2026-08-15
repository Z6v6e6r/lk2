# Community DIRECT invites runbook

## Safety boundary

Keep `COMMUNITY_INVITES_ENABLED=false` until migrations 0058 and 0059, real-PostgreSQL quota race
tests, Admin/User contract tests and staging smoke tests pass. The API and worker must run the same
immutable release image/config. Never paste invite tokens into logs, tickets, shell history or
monitoring labels.

The wider database/HTTP/outbox/realtime capacity gate is defined in
`docs/runbooks/community-load-readiness.md`; passing invite-specific tests alone is not a 100k DAU
release certificate.

## Keyring configuration

`COMMUNITY_INVITE_TOKEN_KEYS` is a JSON object from key ID to an exact 32-byte base64 secret.
`COMMUNITY_INVITE_ACTIVE_KEY_ID` selects the key used for new issue commands. Store both values in
the deployment secret manager, never in Git or a shared `.env` file.

Rotation procedure:

1. Generate a new independent 32-byte secret in the approved secret manager.
2. Add it under a new non-secret key ID while retaining every previous key.
3. Deploy the same keyring with the new active ID to API and worker processes.
4. Verify create and idempotent replay in staging; confirm logs/audit/outbox contain no token.
5. Promote the same image digest and secret version through the normal rollout.
6. Retain old keys for at least the command-idempotency replay window. Submitted invite redemption
   uses the stored token hash and does not depend on the HMAC key.

If an old replay key is removed too early, restore it from the secret manager. Do not regenerate or
replace database token hashes.

## Operational checks

- API responses for create/preview/redeem/list/revoke use `Cache-Control: no-store`.
- Active invite list returns metadata only; token, token hash and key ID are absent.
- `community.direct_invite.expired.v1` outbox events continue advancing and due ACTIVE rows remain
  bounded.
- Lock timeout failures are retryable service failures; alert on sustained rate and pool wait.
- A demoted/removed issuer makes preview and redemption return the same unavailable result as an
  invalid/expired/revoked token.
- `BANNED` never receives preview data; PENDING remains unchanged and redemption returns a conflict.
- Any current ACTIVE OWNER/ADMIN may revoke an ACTIVE link; authorization is rechecked in the same
  tenant transaction as the revision-checked transition.
- Standard issue is rejected before token allocation when the community already has five
  unexpired ACTIVE links or twenty successful ISSUE commands in the preceding rolling 24 hours.
  Revoking a link frees active-link capacity but does not refund rolling-window issue capacity.
- Idempotent replay of a successful ISSUE returns the original result before quota evaluation and
  does not consume either quota twice.
- User API quota responses expose stable `COMMUNITY_DIRECT_INVITE_ACTIVE_LIMIT_EXCEEDED` or
  `COMMUNITY_DIRECT_INVITE_DAILY_LIMIT_EXCEEDED` codes and a bounded `Retry-After` header.
- CUP may create a one-use, 24-hour community quota grant only with an Admin-audience token,
  `x-app-platform: cup-admin`, the exact `communities.invite.quota.override` capability, an
  `Idempotency-Key`, and non-empty `reasonCode` plus `ticketId`. It does not issue or receive an
  invite token and does not select an issuer.
- At most one unexpired ACTIVE grant may exist per community. Issuance inside ordinary quotas must
  not consume it; the next over-quota issue by a current ACTIVE OWNER/ADMIN consumes it atomically.
  Monitor grant creation, expiry and consumption; alert on missing evidence, double-consumption or
  abnormal operator volume.

## Emergency containment

Set `COMMUNITY_INVITES_ENABLED=false` and perform a normal sequential rollout to stop issue,
preview, redemption and management endpoints. Existing hashes remain inert while the flag is off.
For a single compromised link, an authorized community staff member uses the revision-checked
revoke command. Database mutation is not an operational substitute for the API command.
