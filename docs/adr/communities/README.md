# Communities ADR register

The `C-xx` namespace avoids collisions with the repository-wide numeric ADR sequence. An ADR moves
from `proposed` to `accepted` only with decision evidence and an implementation/revisit owner.

| ADR  | Topic                                       | Status   | Accountable                | Current blocker                 |
| ---- | ------------------------------------------- | -------- | -------------------------- | ------------------------------- |
| C-01 | Scope and bounded contexts                  | accepted | Product + Architect        | —                               |
| C-02 | Identity, authorization and capabilities    | accepted | AppSec + Backend Lead      | —                               |
| C-03 | Canonical data and consistency              | proposed | Architect + Data BE        | ownership and state semantics   |
| C-04 | Idempotency, audit and outbox               | accepted | Backend Lead               | —                               |
| C-05 | Feed, cursor and counters                   | proposed | Content BE                 | counters and load proof         |
| C-06 | Messaging sequence and realtime recovery    | accepted | Realtime BE                | load/reconnect proof before GA  |
| C-07 | Media lifecycle and safety                  | accepted | Platform + AppSec          | staging storage/load proof      |
| C-08 | Moderation, privacy, retention and appeal   | proposed | Product + Trust & Safety   | operational DRI/SLA/appeal      |
| C-14 | Content lifecycle and retention             | accepted | Product + Content BE       | —                               |
| C-09 | SLO, capacity, cache and partition triggers | proposed | SRE                        | workload/SLO/RPO/RTO approval   |
| C-10 | Migration, cutover and rollback             | proposed | Architect + Data BE        | data inventory and cohort rule  |
| C-11 | Frontend routes and visual reuse            | accepted | Frontend Lead              | visual state QA per slice       |
| C-12 | Membership lifecycle and ЦУП decisions      | accepted | Backend + Product          | DIRECT invite decisions         |
| C-13 | Reusable DIRECT invite security             | proposed | Product + Backend + AppSec | revoke, PENDING and abuse quota |

Canonical decision register and Gate A status live in
[Communities Architecture Definition Pack](../../architecture/communities-architecture-definition-pack.md).
