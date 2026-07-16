# Runbook: client routing plan switch

Use this procedure to switch one tenant between `PADLHUB_ONLY` and
`MIXED_END_USER_READS`. This control changes read transport only; it never changes write ownership,
authentication provider binding or PadlHub UUIDs.

## Preconditions for mixed mode

1. Deploy migrations `0011_client_routing_plans.sql` and
   `0012_client_routing_operation_allowlist.sql` with the same proven API/web image digest.
2. Verify OAuth delegation, single-flight refresh and in-memory-only Viva access tokens.
3. Verify Viva CORS for every exact production LK origin and every route included in
   `--operations`. Only `Authorization` may be sent to Viva under the current CORS policy.
4. Prove the normalizer for every operation included in `--operations` emits PadlHub DTOs and
   PadlHub UUIDs. The operator command also requires the operation to be present in
   `DIRECT_VIVA_CONTRACT_READY_OPERATIONS`; currently only `profile.read` is eligible. Do not
   include an operation while a Viva identifier can reach the browser.
5. Confirm `VIVA_DIRECT_READ_ENABLED=true` only in the target staging environment. Keep Home
   backend synchronization and other server Viva reads independently budgeted; mixed mode must not
   create duplicate polling.
6. Record the actor UUID, reason, correlation ID, release digest and rollback owner.

## Dry run

```bash
npm run routing:plan:set -- \
  --tenant local-padel \
  --mode MIXED_END_USER_READS \
  --operations profile.read \
  --actor 00000000-0000-4000-8000-000000000001 \
  --idempotency-key routing-mixed-20260715-0001 \
  --correlation-id routing-mixed-20260715-0001 \
  --reason "staging browser egress soak"
```

Dry run validates input and resolves the active tenant but writes nothing. Repeat with `--apply`
only after review. A repeated apply with the same key and payload returns the recorded revision; a
different payload with that key fails with `IDEMPOTENCY_KEY_CONFLICT`.

## Mixed-mode smoke

1. Restore a real PadlHub user session with an active Viva delegation.
2. Request `/routing-plan` with `X-App-Platform: web`; verify the expected new revision, a maximum
   300-second expiry and only the explicitly requested `DIRECT_VIVA` operations.
3. Verify the direct request uses the user device network, `credentials: omit` and only the
   `Authorization` header. Confirm no system key, refresh token or external ID reaches storage,
   analytics, logs or product routes.
4. Force a Viva `401`; verify one broker refresh and one replay. Force `429`, `5xx` and timeout;
   verify the stable unavailable state and zero backend Viva fallback.
5. Execute a booking command and an unknown operation; verify both call PadlHub APIs and preserve
   authorization, `Idempotency-Key` and audit behaviour.
6. Monitor direct read latency/errors, broker refresh failures, API Viva egress and Viva rate-limit
   responses through the agreed soak.

For bookings, verify `/bookings/upcoming` and the `/bookings` UI use PadlHub UUIDs and PadlHub API
transport. Viva currently requires a second details request keyed by its own booking IDs, so
`bookings.read` and `bookings.details.read` must remain non-direct until the provider contract
supports PadlHub identifiers.

## Switch to PadlHub-only / rollback

Run the same command with a new idempotency key, `--mode PADLHUB_ONLY` and no `--operations`. In an incident, also set
the global `VIVA_DIRECT_READ_ENABLED=false` and roll API nodes sequentially. New plans and delegated
access-token issuance become PadlHub-only immediately; existing short-lived plans/tokens expire
naturally.

After the maximum TTL, verify:

- `/routing-plan` has the new revision and no `directViva` block;
- every read calls PadlHub APIs;
- no browser calls Viva and backend egress stays within its approved budget;
- commands and existing PadlHub sessions remain unaffected;
- the audit row contains only mode/revision/TTL metadata and no token or user payload.

Do not down-migrate the table during rollback. Preserve command and audit history.
