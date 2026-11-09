# CUP read of a user's Viva record

Status: implemented as a read-only admin API. Owner boundary: `@phub/viva-adapter`
(`VivaClientAdminReadSource`) + `apps/api/src/admin/user-viva-admin-routes.ts`.

## Purpose

Operators in CUP see what Viva knows about a PadlHub user that LK2 does not store: the Viva
card, counters/statistics, subscriptions, bookings (games and trainings) and transactions.
Viva stays the write owner of all of it; LK2 neither caches nor copies these rows.

## LK2 endpoints (admin audience, `X-App-Platform: cup-admin`, `support.read` | `support.manage`)

| LK2 GET `/admin/api/v1/{tenantKey}/users/{userId}/viva/...`      | Viva GET (Admin API, server key)                                                                                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile`                                                        | `/api/v1/clients/{clientId}`                                                                                                                 |
| `summary`                                                        | `/api/v1/clients/{clientId}/card/meta`, `/card/statistics-snapshot`, `/bonus-points/balance`                                                 |
| `subscriptions?group=CURRENT\|ARCHIVED&page&size`                | `/api/v1/clients/{clientId}/subscriptions?statuses=…&sort=createdAt,desc` (CURRENT = ACTIVE/NEW/HOLD, ARCHIVED = EXPIRED/REFUNDED/NO_VISITS) |
| `bookings?period=TODAY\|FUTURE\|PAST&includeCancelled&page&size` | `/api/v1/clients/{clientId}/bookings?timeFilter=…&includeCanceled=true`                                                                      |
| `transactions?page&size`                                         | `/api/v2/clients/{clientId}/transactions?sort=createDate,desc`                                                                               |

Invariants:

- `clientId` comes only from the synced `integration.external_entity_map` (`viva_profile`) row of
  the path user in the JWT tenant (same resolver as residency). The caller cannot pass it.
- Every Viva call is a GET with timeout, at most 2 attempts on 408/429/5xx, a circuit breaker and
  metrics. 404 is not retried.
- Responses are provider-free projections: no Viva IDs, phone, email, names, loyalty-card number,
  payment links, bank/counterparty data. A row that names another Viva client fails the section
  with `USER_VIVA_OWNERSHIP_CONFLICT`.
- Money from Viva transactions/subscriptions is in kopecks (`*Kopecks`); the statistics snapshot
  reports roubles as Viva does (`*Rub`).
- Each read writes a structured access-audit log line `admin.user_viva.read` (actor, tenant,
  subject, section, correlation ID; never the payload). Page size ≤ 50, `Cache-Control: no-store`.

## Seen in the cabinet HAR but intentionally not exposed

| Viva endpoint                                                              | Reason                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `/api/v2/search/clients?q=`                                                | LK2 resolves by its own user; free-text PII search is a separate decision |
| `/api/v1/clients/{id}/counterparty`                                        | bank details / PII                                                        |
| `/api/notifications/v1/history?phone=`                                     | message bodies (OTP) — sensitive                                          |
| `supadb.vivacrm.ru/functions/v1/get_client_*` (unpaid, callcenter)         | separate host and auth, not the Admin API                                 |
| `/api/v1/clients/{id}/gift-certificates[/purchased]`                       | HAR had only empty pages; LK2 owns its own certificates                   |
| `/api/v1/transactions/{id}`, `/clients/{id}/bookings/{id}`                 | detail is already in list rows; would need Viva IDs                       |
| `/api/v1/audit/clientsubscription/{id}`                                    | needs a Viva subscription ID; follow-up if CUP needs it                   |
| `/api/v1/clients/{id}/families`, `/attachments`, `/contracts/clients/{id}` | empty in HAR; add when a real consumer appears                            |

## Evidence

LOCAL only: unit tests with synthetic payloads shaped after the HAR. Not yet verified that the
server `VIVA_API_KEY` is authorized for the bookings and v2 transactions endpoints (PROVIDER).
