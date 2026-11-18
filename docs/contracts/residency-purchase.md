# Residency purchase: web/SDK contract

Status: Draft #682; CRITICAL client custody of a payment operation. Source only, no deployment.

## Compatible source set

- Web/SDK baseline: `fb9fcbdb12cda0f25cc4e9c9795c6074cae1f2ab` in [lk2#682](https://github.com/Z6v6e6r/lk2/pull/682); this PR contains the v2 adaptation. Final web head is recorded in the PR (a commit cannot contain its own SHA).
- Owner: [lk#443](https://github.com/Z6v6e6r/lk/pull/443), `93692e64853df63bb2165ddc54145d86cf8a078a`, contract `residency-lifecycle.v2`, schemaVersion 1.
- Consumer: [lk2#684](https://github.com/Z6v6e6r/lk2/pull/684), `965efa7959d9ff4b402b4312a89b908bc6ca5707`.

The supplied heads matched at task start. A later recheck found owner 93692e64 and consumer 965efa79; their delta was read and these current heads are now pinned. Owner changed price consent from a ceiling to exact equality; consumer runtime bytes are unchanged, while its docs/tests and unrelated main CI tooling changed. Server sources remain owned by DeepSeek. Executable snapshots under `contracts/imported/lk1-residency-lifecycle/93692e64` and `contracts/imported/lk2-residency-consumer/965efa79` are byte-identical to those commits; `SOURCE.sha256` and tests verify contents. Local `.d.mts` declarations describe the imported JS test seam, not upstream executable code. The older adc9c644 snapshot is historical and no longer used by compatibility tests.

## Surface and custody

All browser requests use the authenticated LK2 SDK at `/user/api/v1/{tenantKey}`. The browser never calls Viva or selects an actor/provider credential.

| Operation                       | Request                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Independent entitlement read    | `GET /residency` (ADR 0027)                                                                           |
| Catalog and renewal eligibility | `GET /residency/catalog`                                                                              |
| Own unfinished orders           | `GET /residency/orders?state=unresolved`                                                              |
| Create                          | `POST /residency/orders`, `{ mode, expectedTotalMinor, expectedProductId }`, caller `Idempotency-Key` |
| Read order/payment              | `GET /residency/orders/{id}` / `GET /residency/orders/{id}/payment`                                   |
| Reconcile                       | `POST /residency/orders/{id}/reconcile`, `{}`, caller `Idempotency-Key`                               |

The SDK never automatically retries a residency POST, including on 401. Each new attempt is durably stored before create in its own account/key entry. New records carry the exact `createPayload` (mode, confirmed total, confirmed product), key, orderId and creation time. The stored total is user consent, not an authoritative client price. No payment URL, bank data or tokens are stored. Neither refresh nor page load sends create. Explicit recovery replays only the saved payload with its original key; a fresh catalog cannot change consent.

Existing v3 records without `createPayload` were sent as `{mode}`. They are not silently upgraded. With an orderId they use GET/reconcile. Without one they use unresolved lookup and offer support; neither an empty result nor a 400 proves absence of an earlier ACTIVE/terminal operation. The old record remains held without a new create. Lookup results are separate orderId-based entries, never falsely attributed to a local create key; aliases are removed only once the same order is known by its original attempt.

Recovery rereads **all** current storage entries, removes disappeared entries from the screen, reads orders for known IDs and explicitly replays complete unanswered attempts. This works with two visible windows without visibilitychange. Per-key storage and Web Locks where available retain the earlier race protection.

## Price consent

Unified with the updated owner and DeepSeek consumer contract: `totalMinor === expectedTotalMinor`. Both a lower and a higher server total are refused before order insertion/provider POST. The user sees the changed amount and must confirm the refreshed catalog as a separate attempt after the proven refusal. Same-key replay retains the original exact total and product even when the catalog changes. No consent is silently updated. DeepSeek corrected its server document to explicitly allow persisting the confirmed total for replay. Quote-only discounts remain unavailable unless the catalog exposes the same exact total.

`ApiClientError.details` preserves the untrusted server details; UI validates fields before using them. Refusal classification is based on the precise owner control flow, not merely HTTP 400/409:

| Refusal                                                                                      | Custody                                                                                    |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `RENEWAL_REQUIRED`, `RENEWAL_NOT_ELIGIBLE`, `RENEWAL_TOO_EARLY`, `ORDER_ALREADY_PENDING`     | Owner checks key first: clear only the refused attempt                                     |
| `PRICE_CHANGED` with matching original amount/product, RUB and a different total             | Exact-amount guard is after key lookup: definitive refusal; fresh consent required         |
| `PRICE_CHANGED` product mismatch or malformed details                                        | Before lookup/uncertain: preserve                                                          |
| `PRICE_CONSENT_REQUIRED`, `REQUEST_INVALID`, `MODE_INVALID`, `IDEMPOTENCY_KEY_REQUIRED`      | Consumer/owner may reject before key lookup: preserve                                      |
| `IDEMPOTENCY_CONFLICT`, `ORDER_CONFLICT`, 401/403/429, HTML, transport failure, consumer 5xx | Preserve original operation                                                                |
| `OWNER_CONFIGURATION_INVALID` (details.ownerCode), disabled/unavailable/config mismatch      | Preserve; configuration is not proof of a terminal operation                               |
| `REAUTH_REQUIRED`                                                                            | Preserve; explicit Viva reauthorization action uses existing recovery flow and return path |

The legacy availability codes are definitive only when directly emitted by the owner after lookup. The actual consumer maps several of them to `OWNER_CONFIGURATION_INVALID`, which remains held.

## Renewal and recovery

The UI validates `catalog.renewal` (`eligible`, `reason`, `eligibleAt`, `currentValidUntil`, expected term/start/end). For ACTIVE status and ineligible renewal it displays the server reason and exact Moscow availability date/time, without a payment confirmation. It does not calculate transferred days. `RENEWAL_TOO_EARLY.details` uses the same explanation. CUP's window begins at paymentDate; only the owner decides eligibility.

Order recovery (`state`, `required`, `reason`, `action`, `retryable`, `since`) and payment `overdue` are validated. `UNKNOWN_OUTCOME`, `AWAITING_CONFIRMATION`, `ACTIVATION_PENDING`, `REVIEW_REQUIRED` and overdue block payment and new purchase. Payment launch requires `AWAITING_PAYMENT/PAY`, PENDING, non-overdue and exact-consent/product checks. The local deadline never promises closure; the owner can retain PENDING/UNKNOWN indefinitely pending evidence. No cancellation is offered while bank outcome is unresolved.

Every load performs unresolved lookup, including on a new device. Purchase is unavailable until that read succeeds. Activation success requires **both** order ACTIVE and independent `GET /residency` ACTIVE covering the order's own end date in the Moscow calendar; an old ACTIVE read is insufficient. Reconciliation remains bounded (8 × 4 seconds plus explicit checks/foreground). Account epochs discard late results after account switches.

## Evidence boundaries

LOCAL tests mount the real screen and real SDK and run the real #684 Fastify routes, runtime validation/error mapping and owner HTTP client, then #443 HTTP/domain modules. Synthetic: Fastify injected transport instead of sockets, authentication middleware and delegation issuance, clock, in-memory durable-store stand-in, independent status-read data and Viva/CUP ports. This does not prove real JWT/Keycloak delegation, Mongo durability, provider adapter behavior or a real payment.

Regression scenarios cover NEW, missing consent, price increase/decrease, replay after catalog changes, early renewal with zero provider creates, unresolved recovery, lost success/refusal, unknown outcome, overdue, reauth, two visible windows, account isolation, HTML fallback, bounded wait and independent confirmation of the new term. Snapshot hashes are checked for both dependencies.

CI is reported on the final #682 SHA in its PR. STAGING and PROVIDER are untested: owner install/indexes/flag, matching consumer product/config, lk2 return target and real delegated-token/provider acceptance remain external dependencies. No native purchase wiring, merge, deployment, live configuration or real payment is included.
