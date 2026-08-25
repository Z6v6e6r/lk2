## Change

Describe the user/domain outcome and affected tenant scope.

## Risk and boundary

- Highest tier: `FAST` / `SAFE` / `CRITICAL`
- Changed command/write/trust boundary:
- Boundary map (`boundary -> tier -> gates/evidence`):
- Follow-up findings kept out of scope:

## Boundary checklist

Mark every item as `PASS` with evidence or `N/A` with a reason. `N/A` is valid only when that
boundary is untouched, regardless of the highest tier.

- [ ] Clients/UUID/system boundary — `PASS + evidence` / `N/A + reason`
- [ ] Auth, tenant isolation and PII — `PASS + evidence` / `N/A + reason`
- [ ] Booking, capacity and roster integrity — `PASS + evidence` / `N/A + reason`
- [ ] Provider identity and ambiguous-write recovery — `PASS + evidence` / `N/A + reason`
- [ ] Idempotency, authorization and audit — `PASS + evidence` / `N/A + reason`
- [ ] Schema expand/migrate/contract and rollback — `PASS + evidence` / `N/A + reason`
- [ ] Public API/events and older-client compatibility — `PASS + evidence` / `N/A + reason`

## Evidence

List only evidence actually obtained and label it `LOCAL`, `CI`, `STAGING`, `PROVIDER` or
`PRODUCTION`. Missing STAGING/PRODUCTION evidence does not block a FAST/SAFE implementation PR.

## Live actions

State whether merge, deploy, migration apply, activation, provider write or production mutation
occurred. A Draft PR does not authorize any of them.
