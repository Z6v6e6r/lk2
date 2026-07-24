# ADR 0013: Gift certificate catalog foundation

- Status: Accepted
- Date: 2026-07-19

## Context

PadlHub needs gift certificate sale on the public site and in the personal cabinet, management in
CUP, and activation in the personal cabinet. Accepting payment before the configuration, issuance,
delivery and value-ledger invariants exist would create an unrecoverable partial product.

The first releasable boundary is therefore the catalog used by all future sale surfaces. Operators
must be able to prepare a draft without affecting customers and publish one consistent tenant
version. Clients must not assemble the catalog from mixed draft and published records.

## Decision

Gift certificates are a `LOCAL_PRIMARY` PadlHub Commerce domain. The first implementation owns:

- a tenant-scoped versioned catalog;
- certificate designs and their HTTPS media references;
- RUB denominations stored in minor currency units;
- the ordered sale-flow structure;
- validity start, duration, activation deadline and delivery feature flags;
- one mutable draft and one immutable current published version per tenant.

CUP reads both current states. Saving and publishing are authenticated, tenant-scoped, authorized,
idempotent, optimistic-locking commands. Each successful command writes its business state, audit
record and outbox event in the same PostgreSQL transaction. Published replacement archives the old
version atomically.

Public and authenticated catalog reads return one projection from one published version. They fail
closed when the version is absent, disabled, outside its availability window, or has no active
design or denomination. Draft and inactive records never reach sale clients.

Database row-level security is forced for every table. Public identifiers are PadlHub UUIDs and no
Viva identifiers or credentials enter this domain.

## Explicitly deferred

This decision does not enable sale. The following require separate implementation and release
gates:

- order snapshots and recipient data;
- hosted payment session, signed provider webhooks and reconciliation;
- certificate issuance and non-enumerable activation secret handling;
- PDF generation, object storage and email delivery;
- activation in the personal cabinet;
- immutable credit ledger and Commerce reserve/capture/release/refund integration;
- expiry jobs, refunds, support operations and operational analytics.

Activation will attach value to the authenticated owner; it will not spend value. Spending will be
performed only by the Commerce ledger during a payable business operation.

## Consequences

The current site can integrate the catalog without receiving unfinished payment capabilities. CUP
can safely prepare content and rules ahead of the sale release. Future orders will snapshot the
published catalog version so later editorial changes cannot alter already purchased certificates.

The trade-off is intentional: a published catalog alone is not a sellable certificate product and
must not be described or deployed as one.
