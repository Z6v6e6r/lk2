# Monthly Friendship purchase

This is a default-off canonical consumer of LK private owner contract `monthly-friendship.v1` (LK PR #289, `65c8069eacb2feffe198a1dc655482f4081c360c`). It buys the ordinary monthly Friendship offer `862670f6-a476-4a18-aecb-9e27661fbad3`. It does not select annual/HAB products or accept a client-selected provider product, phone, promo, source or redirect. Existing LK1 checkout remains the owner-compatible legacy consumer.

## Ownership and authorization

Viva remains the business owner. The expanded PostgreSQL tables in migration 0115 store command intent, immutable price consent, dispatch custody, provider receipts and hashed one-use launch capabilities. They do not create entitlements. `PAID` is a historical receipt; the existing subscription projection remains the source for current validity and usage.

Every canonical operation requires an active PadlHub client session and tenant. The server resolves a unique forward and reverse synced profile mapping plus the exact Viva tenant binding. A short-lived RS256 actor delegation binds the user, session, mapping, original operation/key hash, request hash and current actor token. The private owner verifies the actor profile and exact signed request. Provider identifiers and keys never enter mobile DTOs.

## Purchase and recovery

1. Android/iOS persists the original tenant/user/key before requesting a quote. Storage readback and an account-scoped Web Lock are required; unavailable/corrupt custody fails closed.
2. Quote pins the provider inventory epoch, product, price and original payload for 120 seconds. Explicit confirmation sends that exact quote consent under the original key. The native boundary accepts only the reviewed closed body.
3. A PostgreSQL actor lock and unique active-operation index allow only one unresolved purchase. Dispatch marker, audit and outbox are committed before the owner call. Fresh identity is checked again after that transaction and immediately before sending.
4. Only the winner calls the owner once. Network/HTTP ambiguity retains `UNKNOWN`; no timeout or restart releases its slot. The owner has its independent durable attempt and strict receipt reconciliation. Known receipts are retained even if the originating session is revoked while a response is in flight; exposure requires fresh authorization.
5. App mount/foreground reads only the original journal. Explicit status refresh reconciles the same owner operation. Returning from a browser never confirms payment. An explicit repeat of the original purchase is allowed only when a fresh canonical read still reports `QUOTED`; it cannot create a new key or alter consent. For a server-proven `QUOTED` attempt, an explicit quote refresh can renew an expired price under the same operation and key; the repository locks the attempt and requires no dispatch marker. UNKNOWN/started attempts cannot be reset. A paid receipt may be explicitly dismissed before starting a new purchase.
6. Client dispatch and responses are bound to the original account epoch/access token. Logout closes commands before asynchronous cleanup. Native transports never automatically retry these commands on 401 or network errors.

## Bank navigation

The explicit payment button requests a one-use code with a maximum 60-second lifetime. Only its hash is persisted. Native code constructs the fixed configured PadlHub origin and `/user/api/v1/subscription-payment-launch`, carrying only operation UUID/code in the fragment. It accepts no arbitrary URL.

The landing page immediately removes the fragment, has a nonce CSP and no referrer, and consumes the capability through a same-origin JSON POST. Consumption serializes with the attempt, checks single use and expiry, then rechecks expiry and the original session/mapping after the potentially blocking update. Failure rolls back consumption. The server permits only a valid pending payment HTTPS URL, rejecting credentials, local/IP hosts and trailing-root-dot hostnames. The returned URL is never an app API DTO. Launch codes are explicitly redacted from supported log transport paths.

The consume POST accepts only an exact `Origin` from `MONTHLY_SUBSCRIPTION_LAUNCH_ORIGINS` (comma-separated, exact HTTPS origins: no path, trailing slash, port, wildcard, IP or local host). Empty keeps the reviewed default: `https://lk2.padlhub.su`, plus `https://lk.nano.padlhub.su` outside `APP_ENV=production`. The disposable test stand lists `https://test.lk2.padlhub.su` because it serves the landing page from its own host. Adding an origin is a reviewed configuration change; the one-use code, expiry and session/mapping rechecks still apply to every listed origin.

LK sends the bank to the existing API ingress at `https://lk2.padlhub.su/user/api/v1/subscription-payment-return`. The static return page ignores all bank query fields and asks the user to check status in PadlHub. No ingress, scheme, Associated Domains, signing or OAuth callback changes are required.

## Activation and rollback

`MONTHLY_SUBSCRIPTION_PURCHASE_ENABLED` defaults to false. Platform/release owner may activate it only after the immutable paired LK/LK2 source, expand-only migration, delegated actor configuration, provider quote/purchase/reconciliation evidence and device acceptance are verified. `MONTHLY_SUBSCRIPTION_OWNER_BASE_URL` is fixed to `https://padlhub.su/` in production; actor signing configuration must already exist. Owner timeout is bounded from 100 to 10,000 ms. Review/remove the flag after a separately approved rollout and recovery acceptance; it is not a permanent alternate pricing implementation.

No flag, key, owner flow, database or provider was activated by this source change. Migration execution, publication and runtime deployment are separate transitions.

Rollback closes new admission and native payment launches. Retain 0115 tables, original keys, dispatch markers, owner custody, observations and receipts; never delete an uncertain attempt or restore an unjournaled POST. Authenticated journal reads remain available with admission off. If reconciliation is needed during rollback, retain the compatible owner/API recovery code under a separately approved operational plan. Do not infer payment failure from a missing browser return, expired code or unavailable provider.

## Evidence boundaries

Focused automated tests cover wire compatibility, signed delegation, default deny, single dispatch, ambiguous recovery, revoked sessions, launch replay/expiry, privacy, closed native requests, original-key custody and Android/iOS rendered DOM journeys. Physical PostgreSQL tests run only in the existing strict loopback CI fixture and include controlled launch-row lock waits. Native JVM/Swift tests exercise fixed routes, no retries and browser URL construction; actual app-hosted/device behavior requires the mobile workflows and separate acceptance.

Local/CI fixtures do not prove Viva runtime acceptance, bank completion, APNs/FCM, release signing, stores, refund attribution or live rollback. Monetary refund read proof and training cancellation ownership remain separate R1 blockers.
