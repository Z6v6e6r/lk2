# Initial domain ownership matrix

| Domain                   | Initial write owner | Local role                                      | Target owner           |
| ------------------------ | ------------------- | ----------------------------------------------- | ---------------------- |
| Identity/authentication  | `VIVA_PRIMARY`      | provider-neutral users and sessions             | PadlHub Identity       |
| Profile                  | `VIVA_PRIMARY`      | full normalized aggregate                       | PadlHub                |
| Profile privacy          | `LOCAL_ONLY`        | owner policy, audit and versioned commands      | PadlHub Profile        |
| Permissions              | `VIVA_PRIMARY`      | normalized read model                           | CUP                    |
| Stations/spaces/coaches  | `VIVA_PRIMARY`      | independent domain model                        | CUP                    |
| Public location profiles | `LOCAL_ONLY`        | editorial source of truth and publication       | PadlHub Locations      |
| Schedule/availability    | `VIVA_PRIMARY`      | freshness-controlled read model                 | CUP                    |
| Bookings                 | `VIVA_PRIMARY`      | local projection and audit                      | CUP                    |
| Payments                 | provider/Viva       | immutable local operation journal               | PadlHub Commerce       |
| Games                    | `LOCAL_PRIMARY`     | canonical aggregate, command journal and cards  | PadlHub Games          |
| Tournaments              | `LOCAL_ONLY`        | source of truth                                 | PadlHub                |
| Community                | `LOCAL_ONLY`        | source of truth                                 | PadlHub                |
| Messaging                | `LOCAL_ONLY`        | conversations, ordered messages and read state  | PadlHub Chats          |
| Notifications            | `LOCAL_ONLY`        | trigger intents, inbox and delivery history     | PadlHub Notifications  |
| Moderation               | `LOCAL_ONLY`        | reports, review cases and enforcement decisions | PadlHub Trust & Safety |

Before changing a row, document commands, events, invariants, freshness, metrics, reconciliation and rollback.

Messaging connectors are not an additional write owner. They translate inbound and outbound
traffic while the canonical conversation and notification state remains in PostgreSQL.
External moderation providers are also not write owners: only PadlHub policy or an authorized
PadlHub moderator can apply a moderation action.

The temporary current-LK community adapter is a read bridge, not another write owner. Community
commands stay disabled in the new contour until they can commit canonical PostgreSQL state and an
outbox event atomically; no command dual-writes the legacy store and the new tables.

Authentication write ownership and authentication-provider routing are separate controls. The
server resolves a tenant binding of `VIVA` or `LOCAL`; clients never select a provider. Changing the
binding follows the [authentication provider runbook](../runbooks/auth-provider-switch.md).

Read transport is a third, independent control. During migration the server may return a short-lived
`MIXED_END_USER_READS` plan for supported user clients, but write ownership does not change. Every
command still follows the owner in this matrix through PadlHub APIs. See
[ADR 0008](../adr/0008-server-owned-client-routing-plan.md).

Profile media is a derived local asset, not a second profile write owner. Viva owns the current
source photo while `VIVA_PRIMARY`; PadlHub worker normalizes it to WebP, stores the private object
and projects only a signed PadlHub delivery URL. Provider URL and validators remain in integration
storage, and the local media mapping changes in the same transaction as the Home profile outbox
component.
