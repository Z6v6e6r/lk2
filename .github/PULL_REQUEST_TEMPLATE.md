## Change

Describe the user/domain outcome and affected tenant scope.

## Architecture checklist

- [ ] Clients still call only PadlHub APIs and use PadlHub UUIDs.
- [ ] Domain ownership and single-write-owner rules are preserved.
- [ ] Critical commands are idempotent, authorized and audited.
- [ ] External calls have timeout/retry/circuit/metrics and redact secrets.
- [ ] Database changes follow expand/migrate/contract and have rollback notes.
- [ ] API/OpenAPI compatibility and older mobile clients were considered.
- [ ] Metrics, business invariants, alerts and runbooks were updated.

## Verification

List tests, smoke checks, migration checks and deployment/rollback evidence.
