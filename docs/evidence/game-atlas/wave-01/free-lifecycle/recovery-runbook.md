# Free/local Games recovery runbook

This runbook is source guidance only. It grants no authority to access or mutate staging/production, replay a live event, change flags, or update rows. Substitute exact approved tenant/game/command identifiers through the operational tooling; never paste credentials into commands or evidence.

## Stop new claims

Disable the Games command consumer through the approved deployment configuration and verify the process-manager reports disabled. Do not change only the read flag: configuration rejects commands-on/read-off, and the process manager requires both read and command flags. A deployment/configuration change needs separate authority.

## Read-only backlog and lease diagnostics

Run through an approved read-only session with tenant context set by the platform connection wrapper:

```sql
select command_type, state, count(*) as commands, min(due_at) as oldest_due
from games.scheduled_commands
where tenant_id = :tenant_id
group by command_type, state
order by command_type, state;

select id, game_id, command_type, state, attempts, due_at, locked_by, locked_until, last_error_code
from games.scheduled_commands
where tenant_id = :tenant_id
  and state in ('PENDING', 'PROCESSING', 'ATTENTION')
order by due_at, id
limit 200;
```

Never clear `locked_by`, decrement attempts, delete commands, or force a state with ad-hoc SQL. Lease expiry and retry/attention transitions belong to the repository worker contract.

## Projection lag scan

Use `GameRepository.listCardProjectionLag({ tenantId, limit })`; it is tenant-scoped, bounded to 500, excludes legacy redirect sources, and performs no write. Compare aggregate and projection revisions.

For an approved repair, replay the exact original durable Games event through the existing broker/consumer path. The event UUID remains the deduplication identity; missing dependencies delete only the unprocessed inbox claim, successful duplicates stop at the inbox fence, and lower projection revisions cannot overwrite newer snapshots. Do not invent an event ID and do not issue direct `UPDATE games.card_projections`. Live replay requires separate exact-event authorization.

## Promotion recovery

A crash after free promotion business commit but before scheduled-command completion is recovered with the same scheduled command ID and `scheduled:<command-id>` idempotency key. The process result replays, then the worker completes its own lease. Do not manually insert a second promotion command. Paid promotion returns audited `no_op` before roster mutation.

## Reservation expiry

The process manager does not claim `game.reservation.expire.v1` in this wave. The current model cannot prove generation plus authoritative unpaid state. Do not enable it and do not manually release the seat; escalate to GL-BLOCK-RESERVATION-EXPIRY.

## Escalation evidence

Capture correlation ID, tenant-scoped PadlHub game UUID, command/event UUID, revisions, state/attempt count and timestamps. Do not capture names, phone numbers, emails, provider secrets, raw payment evidence or JWTs.
