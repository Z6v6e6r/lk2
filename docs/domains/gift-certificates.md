# Gift certificates

## Product boundary

The product is split into three user-facing blocks:

1. Sale on the public site and in the personal cabinet, with recipient email and post-payment PDF
   download.
2. CUP management of designs, denominations, checkout structure, validity rules and operational
   analytics.
3. Activation in the authenticated personal cabinet.

The catalog, PadlHub-owned design media, server-priced order snapshot, local payment sandbox,
exactly-once issuance, private PDF and local email-delivery sandbox are implemented. Real payment,
external email, activation and spending remain deliberately unavailable.

## Implemented aggregate: catalog

`gift_certificates.catalog_versions` is the aggregate root. A tenant has at most one `DRAFT` and
one `PUBLISHED` version. Publishing archives the previous published version in the same transaction.
Published versions are never edited in place; the next CUP save creates a new draft.

Catalog children are:

- `designs`: stable operator key, audience, text, PadlHub media path or HTTPS image URL, alt text,
  per-background percentage coordinates for the code and denomination overlays, active flag and
  order;
- `denominations`: positive RUB amount in kopecks, active flag and order.

The root holds availability bounds, ordered flow steps and the versioned policy. Required checkout
steps are `DESIGN`, `DENOMINATION` and `REVIEW`. Validity can start at issue or activation; the
activation variant requires a bounded activation deadline.

## Commands and reads

Admin API:

- `GET /admin/api/v1/{tenantKey}/gift-certificate-catalog`
- `PUT /admin/api/v1/{tenantKey}/gift-certificate-catalog/draft`
- `POST /admin/api/v1/{tenantKey}/gift-certificate-catalog/draft/publish`

Commands require the `cup-admin` platform, an admin role, the corresponding
`gift_certificates.catalog.*` permission, `Idempotency-Key`, correlation ID and the current draft
revision. They emit `gift.catalog.draft_saved.v1` or `gift.catalog.published.v1` through the
transactional outbox and write an audit entry in the same transaction.

Sale-surface reads:

- `GET /public/api/v1/{tenantKey}/gift-certificate-catalog`
- `GET /user/api/v1/{tenantKey}/gift-certificate-catalog`

Both return only the current explicitly public version, filtered to active designs and active
denominations. Reads use one tenant transaction and never merge draft state. Absence, scheduling
gates or an incomplete active set returns not found rather than a partial catalog.

## Media, orders and local payment sandbox

CUP uploads JPEG, PNG or WebP bytes through
`POST /admin/api/v1/{tenantKey}/gift-certificate-media`. The API decodes the file with bounded
pixels, applies orientation, resizes it, strips source metadata and stores a normalized WebP in
private object storage. Catalogs reference only the stable PadlHub media path. Public reads redirect
that path to a short-lived signed object URL; object keys and storage credentials are never returned.

Public and authenticated sale commands are:

- `POST /{surface}/api/v1/{tenantKey}/gift-certificate-orders`
- `GET /{surface}/api/v1/{tenantKey}/gift-certificate-orders/{orderId}`
- `POST /{surface}/api/v1/{tenantKey}/gift-certificate-orders/{orderId}/payment-intents`
- `POST /{surface}/api/v1/{tenantKey}/gift-certificate-payments/{paymentId}/sandbox-confirm`

The web client exposes the same form at `/giftcard` without authentication and at
`/gift-certificates` inside LK. Public commands use the purchase cookie and never receive an access
token; LK commands use the verified user boundary. The SDK resolves the relative hosted-payment
action against the configured PadlHub API origin before navigation.

The browser submits catalog, design and denomination UUIDs, never an amount. In one tenant
transaction the API validates one current published version and snapshots its design, policy and
server-owned minor-unit price into `gift_certificates.orders`. A guest sees only orders bound to a
hashed, expiring HttpOnly purchase session; an LK buyer sees only orders bound to their PadlHub user
UUID. Responses mask both email addresses.

`commerce.payment_operations` is an immutable-operation journal for the current
`PADLHUB_SANDBOX` adapter. Payment and order move to `CONFIRMED`/`PAID` atomically. Idempotency
commands, audit records and identifier-only outbox facts are written in the same PostgreSQL
transaction. Re-confirming with another operation key returns the state without emitting a second
payment-confirmed business fact.

## Issuance, PDF and delivery journal

The worker consumes only the verified `commerce.payment.confirmed.v1` fact through a durable quorum
queue with bounded redelivery and dead-letter routing. `gift_certificates.certificates` has one row
per paid order. Preparation is retryable; final issue, private artifact metadata, email delivery
journal, audit entry, `gift.certificate.issued.v1` outbox fact and inbox completion are committed in
one tenant transaction.

The display activation code is deterministically derived with a versioned HMAC from the tenant and
certificate UUID. PostgreSQL stores only its SHA-256 digest. The plaintext code exists only while
the worker renders the PDF and inside the private PDF object; it is excluded from API JSON, audit,
outbox and logs. Changing the HMAC secret while `PREPARING` certificates exist is a release blocker.

Internal PadlHub design media is read directly from private object storage and normalized to a
1990×1280 PNG for the PDF. The uploaded artwork is the complete first page: the worker adds only the
activation code and server-priced denomination at the percentage coordinates snapshotted with that
design. Legacy external HTTPS image URLs use the plain fallback instead of a worker-side remote
fetch. The artifact key is content-addressed and private; buyer/session authorization is rechecked
before the API streams the bounded PDF with private, no-store caching.

`gift_certificates.deliveries` is the durable email schedule. `SCHEDULED` orders set its due time;
PDF download remains available as soon as issuance completes. The only delivery adapter in this
slice is `sandbox`, accepted only in local/CI. It records `SANDBOXED` and makes no external network
call, so this status must never be presented as a real email delivery.

## Security and data ownership

The domain is `LOCAL_PRIMARY`. Every row contains `tenant_id`; composite keys and forced RLS enforce
tenant isolation. CUP commands use PadlHub actor UUIDs. Viva is outside the aggregate.

Recipient email and message exist only in the order and delivery aggregates. They are excluded from
audit payloads, logs and outbox events. Activation code plaintext is never persisted in PostgreSQL.
External provider payloads do not exist in this slice.

## Next implementation slices

1. Real hosted provider adapter, signed webhook and reconciliation with reserve/confirm/cancel
   semantics.
2. Authenticated activation using the stored digest with rate limits and non-enumerable errors.
3. Immutable certificate credit ledger integrated with Commerce reserve/capture/release/refund.
4. Real email provider adapter with attachment delivery, reconciliation and provider callbacks.
5. CUP operational views for issued, delivered, activated, expired, refunded and remaining value.

Production sale remains blocked until provider webhook replay/reconciliation, real email delivery,
activation abuse controls, expiry/refund runbooks and credit-ledger invariants are proven.
