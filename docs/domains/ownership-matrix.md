# Initial domain ownership matrix

| Domain                  | Initial write owner | Local role                           | Target owner     |
| ----------------------- | ------------------- | ------------------------------------ | ---------------- |
| Identity/authentication | `VIVA_PRIMARY`      | provider-neutral users and sessions  | PadlHub Identity |
| Profile                 | `VIVA_PRIMARY`      | full normalized aggregate            | PadlHub          |
| Permissions             | `VIVA_PRIMARY`      | normalized read model                | CUP              |
| Stations/spaces/coaches | `VIVA_PRIMARY`      | independent domain model             | CUP              |
| Schedule/availability   | `VIVA_PRIMARY`      | freshness-controlled read model      | CUP              |
| Bookings                | `VIVA_PRIMARY`      | local projection and audit           | CUP              |
| Payments                | provider/Viva       | immutable local operation journal    | PadlHub Commerce |
| Games                   | `LOCAL_ONLY`        | source of truth                      | PadlHub          |
| Tournaments             | `LOCAL_ONLY`        | source of truth                      | PadlHub          |
| Community               | `LOCAL_ONLY`        | source of truth                      | PadlHub          |
| Messaging               | `LOCAL_ONLY`        | source of truth                      | PadlHub          |
| Notifications           | `LOCAL_ONLY`        | source of truth and delivery history | PadlHub          |

Before changing a row, document commands, events, invariants, freshness, metrics, reconciliation and rollback.

Authentication write ownership and authentication-provider routing are separate controls. The
server resolves a tenant binding of `VIVA` or `LOCAL`; clients never select a provider. Changing the
binding follows the [authentication provider runbook](../runbooks/auth-provider-switch.md).
