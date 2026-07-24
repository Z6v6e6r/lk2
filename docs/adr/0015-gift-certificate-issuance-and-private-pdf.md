# ADR 0015: Gift certificate issuance and private PDF

- Status: Accepted
- Date: 2026-07-19

## Context

A paid order is not yet a certificate. Issuance must survive duplicate RabbitMQ delivery and worker
crashes without creating multiple instruments or leaking the activation credential. Buyers need a
downloadable PDF immediately after issue, while scheduled email is an independent delivery concern.

## Decision

The worker consumes `commerce.payment.confirmed.v1` from a bounded durable quorum queue. It verifies
the referenced order and payment are `PAID`/`CONFIRMED` with the same server-owned amount and
currency. A unique `(tenant_id, order_id)` constraint, advisory lock and inbox record make
preparation retry-safe. Deterministic PDF metadata and a content-addressed private object key make a
retry converge on the same artifact without minting another certificate.

The activation display code is derived as HMAC(secret, tenant UUID, certificate UUID, version).
Only its SHA-256 digest is stored. The plaintext is passed directly into the renderer and exists in
the final private PDF; it never enters JSON responses, business events, audit data or logs.

Final issue updates the artifact, certificate, delivery schedule, audit, issued outbox fact and
inbox completion in one tenant PostgreSQL transaction. Validity dates begin at issue only when the
catalog policy says `ISSUE`; activation-based validity remains unset and receives only an activation
deadline.

Download is an owned-order read. Guest ownership is the existing HttpOnly purchase session and LK
ownership is the authenticated PadlHub subject. The API reads the bounded private object through an
S3 adapter with timeout, bounded retry and circuit-breaker behavior, then streams it with
`private, no-store` caching. Design images already in PadlHub storage may be embedded; external URLs
fall back to the branded template and are not fetched by the worker.

Email uses a separate durable delivery row. The first adapter is `sandbox`, allowed only in local or
CI. It marks the journal `SANDBOXED` without making an external call; `DELIVERED` is reserved for a
future real provider acknowledgement.

## Consequences

Local and CI can prove payment → exactly-one certificate → private PDF → due delivery journal. A
worker crash before completion safely retries; a duplicate fact is acknowledged without another
issued event. A later garbage-collection slice may remove unreferenced content-addressed uploads.

Activation still has no API command and issuance does not create spendable balance. Production
remains blocked on a real payment adapter, email adapter/reconciliation, activation abuse controls,
credit ledger and refund/expiry operations.
