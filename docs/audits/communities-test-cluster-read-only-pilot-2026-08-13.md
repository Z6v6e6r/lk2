# Communities test-cluster read-only pilot — 2026-08-13

## Verdict and scope

- Pilot status: `GO` for the bounded authenticated read-only pilot on the existing test cluster.
- Pilot URL: `https://lk.nano.padlhub.su`.
- Release: `1b061c2813caabe791e717adfc7d69f7d60c5f9a`.
- Deployment evidence: GitHub Actions run `31699515147`, completed successfully.
- Evidence refreshed at `2026-08-13T14:18:32Z`.
- Supported surface: Communities directory, detail, feed, chat transcript and rating projection.
- Source ownership: server-selected legacy read projection; the browser does not select a provider.

This cluster is the test pilot target. This evidence does not authorize a production promotion,
canonical import, cutover, community commands, media, invites or realtime activation.

## Runtime evidence

- Public web entrypoint returned HTTP `200`.
- `/health/ready` returned `ready` with database and auth dependencies ready.
- `/realtime/health/ready` returned HTTP `502`, consistent with the pilot profile keeping realtime
  stopped.
- The successful deployment workflow verified the API-only legacy Communities profile and stopped
  worker and realtime before completing its authenticated projection check and smoke suite.
- Authoritative DNS works without a local `/etc/hosts` override. The stale local mapping to
  `192.168.31.100` was removed before the final pilot checks.

## Authenticated UAT evidence

- Directory: `20` visible Communities entries using PadlHub UUID navigation.
- Three representative Communities were checked independently.
- Each Community loaded detail, `20` feed entries, a read-only chat transcript and a rating list.
- Chat transcript sizes in the sampled Communities were `1`, `22` and `6` messages.
- Rating list sizes were `100`, `100` and `20` rows.
- Create, attachment and message-send controls were disabled in every sampled Community.
- Feed/rating mode selectors that are not supported by the legacy projection were disabled.
- The previously observed transient chat load was retested three times against the same Community:
  `3/3` successful loads, with no alert state.
- Browser warning/error log entries attributable to the Communities journey: `0`.
- No mutation control was invoked and no message, upload, invite or community command was sent.

## Pilot stop conditions

Stop the pilot and use the saved application rollback contour if any of these conditions occurs:

- API readiness fails or authenticated directory/detail access fails repeatedly;
- a write, media, invite or realtime capability becomes enabled;
- worker or realtime starts under the API-only legacy profile;
- the release SHA, API-specific Communities environment or legacy source URL changes;
- tenant isolation, membership authorization or PadlHub UUID mapping cannot be proven;
- repeated chat/feed/rating failures remain after one bounded retry.

Do not roll back expand-only database migrations. Restore the previous digest-pinned application
release and API-specific environment, retain the PostgreSQL backup and investigate before retrying.

## Next gate

Before expanding the pilot audience or changing any capability:

1. Recheck the exact release SHA and runtime profile.
2. Confirm API readiness and that realtime remains unavailable.
3. Repeat authenticated directory/detail/feed/chat/rating UAT.
4. Review redacted API error metrics for legacy provider timeouts and circuit-open events.
5. Obtain a separate approval for any audience expansion, production promotion or write-capability
   activation.
