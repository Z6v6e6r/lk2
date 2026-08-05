# Community creation quota grants runbook

## Issuance boundary

Use ЦУП with an admin-audience token, `X-App-Platform: cup-admin`, exact permission
`communities.create.quota.override`, an `Idempotency-Key`, target PadlHub user UUID, at least one
scope, `reasonCode` and `ticketId`. Do not accept a grant ID, capability or override from LK/web.

Scopes:

- `DAILY_CREATE_LIMIT` — permits one otherwise blocked create inside the rolling 24-hour window;
- `ACTIVE_OWNER_LIMIT` — permits one otherwise blocked create at three ACTIVE owned communities.

If both limits are exceeded, one grant must contain both scopes. Grant TTL is exactly 24 hours and
at most one ACTIVE grant exists per user.

## Verification

For a controlled staging smoke test:

1. Issue the grant from ЦУП and record its non-secret ID, subject, scopes, expiry and ticket.
2. Confirm an in-quota create does not consume the grant.
3. Trigger the selected quota and create through the ordinary User API without override fields.
4. Confirm the create command references the grant and grant state becomes `CONSUMED` exactly once.
5. Confirm `community.create.quota_grant.created.v1`, `.consumed.v1`, `community.created.v1` and
   corresponding audit records share the expected tenant/correlation evidence.
6. Confirm ownership transfer to a user already owning three ACTIVE communities is rejected even
   while that user has an ACTIVE create grant.

Alert on duplicate ACTIVE grants, missing reason/ticket evidence, consumption without a successful
community command, or sustained owner-quota lock timeouts.
