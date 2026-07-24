# ADR 0014: Gift certificate order snapshot and local payment sandbox

- Status: Accepted
- Date: 2026-07-19

## Context

The published catalog is safe to read but does not prove the sale boundary. The next slice must show
that public and authenticated buyers receive a server-priced immutable order, that guest ownership
does not depend on an enumerable order UUID, and that a payment transition is idempotent before any
real provider or certificate issuance is connected.

Design images also need to leave operator-entered external URLs without exposing object-storage
credentials or accepting unvalidated media.

## Decision

PadlHub Commerce owns `gift_certificates.orders`, expiring purchase sessions and
`commerce.payment_operations`. Order creation accepts only published catalog, design and
denomination UUIDs plus recipient input. The server validates one catalog version and snapshots the
design, policy and minor-unit amount in one tenant transaction. Later catalog edits cannot change an
existing order.

Anonymous ownership uses a high-entropy token in a short-lived HttpOnly, SameSite=Lax cookie; only
its SHA-256 hash is stored. LK ownership uses the verified PadlHub JWT subject. Both paths require an
idempotency key and return masked email addresses.

The only provider in this slice is `PADLHUB_SANDBOX`. Configuration rejects sandbox mode outside
`local` and `ci`. Confirmation changes the payment and order atomically, emits one identifier-only
`commerce.payment.confirmed.v1` fact and is safe under retries or a second operation key. It does not
issue a certificate or move value.

CUP media upload decodes JPEG, PNG or WebP with bounded pixels, applies orientation, resizes to the
configured maximum, strips metadata, encodes WebP and only then writes a content-addressed private
object. Public catalog media paths redirect to short-lived signed reads.

Every new business table has tenant composite keys and forced RLS. Recipient data is excluded from
audit and outbox payloads. No Viva identifier, secret or external provider payload enters the
aggregate.

## Consequences

Local development can exercise catalog → order → hosted sandbox → paid order without pretending the
certificate exists. The slice proves pricing, ownership and payment state transitions, but is not a
production sale release.

Real payment requires a separate provider adapter with signed callbacks, reconciliation, timeouts,
bounded retries and a rollback runbook. Issuance, PDF/email delivery, activation, expiry/refunds and
the credit ledger remain blocked.
