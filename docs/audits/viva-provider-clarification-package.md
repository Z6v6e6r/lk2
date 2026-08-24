# Viva Provider Clarification Package

## Verdict and authority boundary

This is a documentation/evidence-only package derived from Draft PR #123 at commit
`7593288932c66678311cf3ceeef791ada386ca3b`. It does not authorize a Viva adapter, provider write,
callback route, recovery lookup, runtime flag change, state-machine change, deployment or live
mutation.

All nine gates remain **NO-GO**. A provider answer is evidence input, not an automatic gate decision.

## Package contents

- [Canonical question catalog](./viva-provider-clarification-catalog.json): stable question IDs,
  English/Russian wording, requirement/gate mapping and acceptance criteria.
- [Provider-facing English letter](./viva-provider-clarification-letter.en.md): ready to send without
  technical rewriting.
- [Internal Russian letter](./viva-provider-clarification-letter.ru.md): equivalent content with
  risk explanations.
- [Response template](./viva-provider-response-template.json): unanswered, synthetic and PII-free
  response package.
- [Response schema](./viva-provider-response.schema.json): closed-world Draft 2020-12 contract.
- [Evidence update runbook](./viva-provider-evidence-update-runbook.md): preservation, review and
  evidence-update procedure.
- [`scripts/viva-provider-clarification-contract.ts`](../../scripts/viva-provider-clarification-contract.ts):
  dependency-free cross-reference and response validator.
- [`scripts/viva-provider-clarification-contract.test.ts`](../../scripts/viva-provider-clarification-contract.test.ts):
  deterministic positive and negative contract checks.
- [`scripts/verify-viva-provider-response.ts`](../../scripts/verify-viva-provider-response.ts): local
  verifier for a redacted received response.

## Source parity and stable IDs

The source Markdown and JSON both contain exactly twelve questions in the same order and with the
same meaning. The Markdown wording is more explicit; the JSON strings are compressed. Neither
source previously assigned question IDs or structured question-to-requirement/gate mappings.

This package assigns `VIVA-Q-01` through `VIVA-Q-12` positionally, preserves both source forms in
the catalog and validates them against the source audit. This closes the referential-integrity gap
without changing any original requirement status or gate decision.

## Question inventory and mapping

| Question  | Topic                                    | Requirement IDs                    | Gate IDs                                                                               |
| --------- | ---------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| VIVA-Q-01 | Lost-response correlation                | ID-01, ID-05, IDEM-05              | realProviderWriter, realProviderReadBack                                               |
| VIVA-Q-02 | Exact-operation idempotency              | IDEM-01–IDEM-05                    | realProviderWriter                                                                     |
| VIVA-Q-03 | Authoritative recovery lookup            | ID-05, RB-01, RB-02, RB-05, PAY-08 | realProviderWriter, realProviderReadBack, SHADOW, WARN, BLOCK                          |
| VIVA-Q-04 | Identifier lifecycle                     | ID-02, ID-04, ENV-01               | realProviderWriter, realProviderReadBack, WARN                                         |
| VIVA-Q-05 | Booking/payment state machine            | RB-03, PAY-03, PAY-07              | realProviderReadBack, livePaymentConvergence                                           |
| VIVA-Q-06 | Immutable operation binding              | RB-04, PAY-05                      | realProviderReadBack, providerNativeAmountCurrencyVerification, livePaymentConvergence |
| VIVA-Q-07 | Amount, currency and allocation          | PAY-01–PAY-04, PAY-06, PAY-07      | providerNativeAmountCurrencyVerification, livePaymentConvergence                       |
| VIVA-Q-08 | Callback authentication and integrity    | CB-00–CB-03, CB-05, ENV-01         | publicCallbackRoute, callbackAsAccelerationOnly                                        |
| VIVA-Q-09 | Callback delivery semantics              | ID-03, CB-04                       | publicCallbackRoute, callbackAsAccelerationOnly                                        |
| VIVA-Q-10 | Versioned authoritative contract         | VER-01, ENV-01                     | all nine gates                                                                         |
| VIVA-Q-11 | Timeout/retry/rate-limit/SLO contract    | OPS-01, RB-05                      | all nine gates                                                                         |
| VIVA-Q-12 | Privacy-safe observability and isolation | OBS-01, SEC-01                     | all nine gates                                                                         |

The union covers all 34 source requirement IDs and all nine source gate IDs. Exact, expanded arrays
are authoritative in the catalog; ranges in this human table are display abbreviations only.

## Per-question acceptance contract

Every catalog entry contains:

- stable `questionId`, exact English wording and equivalent Russian wording;
- affected `requirementIds` and `gateIds`;
- the critical risk;
- `minimumAcceptableAnswer`;
- mandatory `requiredEvidence`;
- explicitly insufficient answer forms;
- the fail-closed `noResponseDecision`.

A sufficient answer must identify the exact operation or property, product/API version,
environment and contractually authoritative written evidence. Oral statements, marketing pages,
UI/report observations, undated examples and an unqualified “yes” are insufficient. Unknown
properties remain `UNKNOWN`/`UNPROVEN`.

## Response status policy

Only these statuses are valid:

- `ANSWERED_WITH_VERSIONED_EVIDENCE`;
- `ANSWERED_WITHOUT_SUFFICIENT_EVIDENCE`;
- `PARTIALLY_ANSWERED`;
- `NOT_SUPPORTED`;
- `UNKNOWN`;
- `NO_RESPONSE`.

Only `ANSWERED_WITH_VERSIONED_EVIDENCE` may become a candidate for `PROVEN`, and only after the
mapped evidence review. It must include a written answer, answering person and role/team, answer
date, version, non-unknown environment, authoritative HTTPS evidence and mapped requirement review.
The authoritative evidence may instead be a preserved, digest-pinned attachment identified in the
response provenance. It never changes a gate automatically.

## Gate acceptance matrix

| Gate                                       | Required questions    | Minimum evidence and security properties                                                                                          | Required negative tests                                                                                                                | Is PARTIAL enough? | Review owner                                                              | Why an endpoint is insufficient                                                      |
| ------------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `realProviderWriter`                       | Q01–Q04, Q10–Q12      | Pre-write correlation; exact idempotency semantics; production version/parity; bounded retries; redacted observability            | Accepted response lost; same key/same payload; same key/changed payload; retry after TTL; provider 429/timeout/reset                   | No                 | Integration + payment-safety + security                                   | Existence does not prove duplicate prevention, recovery or tenant binding.           |
| `realProviderReadBack`                     | Q01, Q03–Q07, Q10–Q12 | Independent lookup; cardinality; authoritative negative window; immutable tenant/object/money binding; state/history semantics    | Never-created vs not-yet-visible; multiple matches; stale/refunded/reversed fact; cross-tenant/object mismatch                         | No                 | Integration + payment-safety                                              | A GET path does not prove authority, consistency or exact-object matching.           |
| `publicCallbackRoute`                      | Q04, Q08–Q12          | Cryptographic authentication/integrity; signed tenant/reference; timestamp/nonce; replay window; event ID; rotation; PII controls | Invalid/missing signature; old timestamp; replay; wrong tenant/key/environment; oversized/PII payload; duplicate/out-of-order delivery | No                 | Security                                                                  | A webhook URL or IP allowlist does not prove message integrity or replay resistance. |
| `callbackAsAccelerationOnly`               | Q01, Q03–Q12          | All callback properties plus independent authoritative read-back; callback remains observation only                               | Callback before/after read visibility; missing callback; duplicate/stale callback; read-back disagreement                              | No                 | Security + integration                                                    | Callback delivery cannot replace provider truth or recovery lookup.                  |
| `providerNativeAmountCurrencyVerification` | Q04–Q07, Q10–Q12      | Exact unit/scale/rounding/ISO currency; immutable merchant/reference; per-booking allocation; refund/reversal model               | Currency mismatch; rounding boundary; multi-position total; partial refund; fee/net/tip discrepancy                                    | No                 | Payment-safety                                                            | An amount field alone does not identify units, currency, allocation or lifecycle.    |
| `livePaymentConvergence`                   | Q01–Q12               | Writer, read-back, state machine, amount/currency/allocation, refunds, operations, callback if used, observability                | Ambiguous write; delayed appearance; duplicate effect; partial/full refund; reversal/chargeback; callback loss/replay/order            | No                 | Payment-safety + integration + security                                   | One endpoint cannot establish an end-to-end monotonic recovery lifecycle.            |
| `SHADOW`                                   | Q03–Q07, Q10–Q12      | Read-only production parity; exact matching; rate limits; failure isolation; no user-state effect                                 | Stale/absent provider fact; cross-tenant match; rate-limit/circuit isolation; disagreement recording                                   | No                 | Integration + security                                                    | Comparison is unsafe when the provider fact itself is unauthoritative.               |
| `WARN`                                     | Q03–Q07, Q10–Q12      | All SHADOW evidence plus calibrated disagreement semantics and observable false-positive/negative bounds                          | False warning from delayed visibility; stale/refunded state; missing currency/allocation; tenant isolation                             | No                 | Integration + product/payment-safety                                      | A readable response does not prove that a warning is correct or timely.              |
| `BLOCK`                                    | Q01–Q12               | All preceding evidence; authoritative negative semantics; proven safety of denial; audited rollback/recovery and observability    | False negative lookup; delayed fact; provider outage; stale status; callback loss/replay; amount/currency/reference mismatch           | No                 | Payment-safety + security + integration; separate decision owner approval | A provider endpoint cannot by itself justify denying or mutating user state.         |

Every gate in the response template has `currentDecision: NO-GO`, `reviewedDecision: NO-GO` and
`automaticTransition: false`.

For `VIVA-Q-11`, the negative-test set must also include missing, malformed and contradictory
`Retry-After`; retryable versus nonretryable 4xx, 5xx, provider and transport errors; retry-horizon
exhaustion; circuit-breaker trip, half-open and recovery-probe behavior; maintenance/outage behavior;
and read-after-write visibility both inside and beyond the documented consistency window.

## Security and privacy invariants

- Do not send customer PII, credentials, secrets, production URLs or real transaction IDs to Viva
  in this package.
- Do not retain a raw callback body before a separate PII/access/encryption/retention/deletion review.
- A generic webhook is not secure without a confirmed authentication and integrity scheme.
- An IP allowlist is not automatically message integrity.
- A callback is observation/acceleration only and cannot be the sole source of truth.
- Event ID, signature, signed timestamp, replay window, retries, duplicate/order behavior and ACK
  semantics require independent validation.
- Amount/currency must bind unambiguously to one local operation.
- Delayed provider appearance after timeout remains `UNKNOWN` until an authoritative negative lookup
  is proven.

## Deterministic validation

The repository has no declared root Draft 2020-12 validation engine. The checked-in schema follows
the repository's Draft 2020-12 convention, while the dependency-free TypeScript contract performs
closed-world instance and cross-reference validation without a dependency or lockfile change.

Run:

```bash
npx vitest run scripts/viva-provider-clarification-contract.test.ts
node --import tsx scripts/verify-viva-provider-response.ts \
  --response docs/audits/viva-provider-response-template.json
```

The validator rejects missing/duplicate/unknown questions, mapping drift, unknown requirements or
gates, insufficient versioned answers, non-authoritative `PROVEN` candidates, malformed nested
fields, unresolved contradictions, any gate transition and credential/token/PII-shaped values. The
package test additionally enforces the exact ten-file task scope; the reusable response CLI does not.
It performs no network request.

Regex/DLP checks are defense-in-depth, not proof of redaction. Before commit or push, perform a human
redaction review plus the repository secret scan and explicit PII/provider-identifier scan. Preserve
raw originals only in the approved restricted evidence location.
