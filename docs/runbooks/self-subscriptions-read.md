# Current self subscriptions: source-only boundary

`GET /user/api/v1/{tenantKey}/subscriptions` requires an active PadlHub session,
tenant membership and the existing `profile.read` permission. The SDK method is
`getSelfSubscriptions`. Only `limit` (1–50) and an API-issued cursor are accepted.

The optional `SubscriptionSelfReadSource` must return a complete canonical snapshot
for the verified tenant, user and session. It supplies canonical product UUIDs,
real field values, a snapshot UUID, source time, staleness time and the exact total.
Pages are strictly ordered by UUID. The API rejects missing coverage, unmapped or
duplicate IDs, incomplete pages and foreign principals. `coverage: COMPLETE`
describes source coverage; `hasMore` describes API pagination. Read every page of
the same snapshot before claiming a full list. CURRENT excludes archive/history.

Unknown title, remaining amount and validity stay null; unknown units stay UNKNOWN.
Null validity never means unlimited. This contract version cannot represent proven
no-expiry products. Snapshot freshness is explicit; it is not the HTTP fetch time.
These presentation fields do not prove payment, entitlement or financial settlement.

The API signs a 15-minute cursor bound to tenant/user/session, snapshot, source times,
total, page size and position using a domain-separated HMAC with the existing access
signing key. Key rotation invalidates cursors. A changed snapshot returns
`409 SUBSCRIPTIONS_SNAPSHOT_CHANGED`; explicitly restart at page one. Invalid or
foreign cursors return 400. Missing, incomplete or failed sources return
`503 SUBSCRIPTIONS_READ_UNAVAILABLE`, never Home data or a successful empty list.

Production composition deliberately supplies no source. This change does not wire
Viva, a client-assisted job, mapping writes, a Worker, new permissions or a new flag.
ADR 0005/0020/0023 transport restrictions remain in force. Before runtime wiring,
the integration owner must prove the complete provider-free source contract,
canonical ownership/mappings for every product, snapshot pagination and actual field
semantics, with independent security review and separately authorized activation.
Home remains its six-item summary. Removing the injection restores unavailable
behavior; no schema or durable data rollback is needed.
