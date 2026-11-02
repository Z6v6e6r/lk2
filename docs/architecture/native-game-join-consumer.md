# Native game JOIN consumer

The Android and iOS game detail screens expose free and subscription JOIN through a closed native capability. Android's public catalogue exposes only credential-free GET with bounded limit, availability and opaque cursor. It does not expose waitlist, payment execution or results commands.

## Original intent and recovery

Before HTTP, persist the original account/game, idempotency key, exact JSON body and SHA-256 under a browser lock. Missing storage or locks denies admission. A pending JOIN and a fresh native SELF LEAVE share the same admission lock; each checks the opposite command ledger before dispatch. Existing SELF LEAVE recovery retains its original key.

Free JOIN with a known operation uses GET. If its ACK was lost before an operation ID was known, only an explicit user retry may POST the exact original body/key. Paid JOIN never replays POST: recovery uses GET by original key, or explicit reconcile of an already bound operation with `join-reconcile:<operation UUID>`. Native reconcile emits `{}` as application/json, matching the existing API contract and avoiding implicit Android form encoding.

Subscription conditions are advisory and expire. The user explicitly accepts the returned amount/currency, including zero, then the controller rechecks the current game revision and conditions before dispatch. Paid bare SUCCEEDED is insufficient: the existing commercial classifier must establish trusted owner confirmation. Recovery HTTP errors never release custody. Initial known pre-dispatch refusals may release it. Receipt operation IDs remain immutable and confirmed state cannot regress on delayed responses.

A new JOIN after a completed participation requires observation of PARTICIPANT at or above the confirmed revision, followed by a canonical JOIN action at a later revision. Lagging projections cannot create a fresh command key.

## Identity and wire restrictions

The session/gateway registers each exact native request with the original principal and access token. Check both before and after the bridge and after SDK JSON decoding; concurrent duplicate mutation is rejected. Logout retires the transport generation. No automatic 401/network retry or account switch is allowed for these commands. The same post-decoding token fence covers the iOS training consumer.

TypeScript, Swift and Java validate the concrete resource, UUID, method, query, headers and closed JSON body. Duplicate or escaped member names, foreign namespaces, cookies, provider routing and additional body properties are rejected. Native code independently validates JS bridge inputs.

## Evidence and release boundary

Source and synthetic local/CI tests are separate from signed-device, provider, staging and production acceptance. No provider/payment configuration, deployment, migration, signing or store activation is part of this source change. Native training LEAVE and attributable Viva refund settlement remain separate unresolved contracts.
