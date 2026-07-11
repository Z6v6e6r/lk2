# ADR 0003: Immutable delivery and expand-contract migrations

- Status: accepted
- Date: 2026-07-11

## Decision

GitHub Actions builds images once and promotes their digests. Staging deploys after merge; production deploys after approval and backup verification, one app node at a time. Migration runs as a separate job before new application traffic.

Database evolution uses expand, background migrate, code switch and later contract. Destructive migration patterns are rejected by the baseline checker.

## Consequences

Rollback selects a previous digest and does not depend on rebuilding source. Old and new application versions must coexist with the expanded database schema during rollout.
