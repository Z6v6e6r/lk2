# Viva Provider Evidence Update Runbook

## Purpose and stop boundary

Use this runbook only after an official written Viva CRM response is received. It updates evidence;
it does not authorize adapter implementation, provider calls, callback publication, flags, gate
activation, deployment or live mutation. Every gate starts and remains `NO-GO` until a separate
reviewed evidence-update PR records an explicit decision.

## 1. Preserve the original response

Save the original email or support-ticket export and each attachment without editing, conversion or
copy/paste normalization. Store it in the approved restricted evidence location, not in Git. Do not
commit customer PII, credentials, provider secrets, raw callback bodies or real transaction IDs.

## 2. Record provenance

Create a redacted copy of
[the response template](./viva-provider-response-template.json) and record:

- receipt timestamp and channel;
- sender name, role/team and answer date;
- provider/product name;
- claimed product/API version and environment;
- restricted reference to the preserved original;
- attachment identifiers and authoritative-document claims.

An oral conversation may be recorded as `ORAL_SUMMARY`, but it cannot use
`ANSWERED_WITH_VERSIONED_EVIDENCE`.

## 3. Verify digital integrity

Calculate SHA-256 for the original message export and every attachment. Record the digest in the
restricted evidence ledger and the redacted template where permitted. Recalculate before review and
compare. If a signature is supplied, verify it independently with an approved trust chain; a hash
alone proves file stability, not provider authorship.

## 4. Check version and environment parity

Confirm that every cited document and answer applies to the merchant's current production Viva CRM
product/API version. Record demo/sandbox/production differences. Do not infer parity from similar
responses, an accessible endpoint, HTTP `401`, HTTP `404`, observed UI behavior or marketing text.

## 5. Validate the redacted response package

Populate only the redacted template. Keep unknown values `null`, `UNKNOWN` or `NO_RESPONSE`; do not
guess. Run:

```bash
node --import tsx scripts/verify-viva-provider-response.ts --response <redacted-response.json>
npx vitest run scripts/viva-provider-clarification-contract.test.ts
```

Resolve structural errors before evidence review. Never weaken the schema or validator to accept an
incomplete answer.

## 6. Map all answers to the 34 requirements

For each `VIVA-Q-*`, use the immutable catalog mapping. Review every one of the 34 audit requirement
IDs. A requirement may be supported by more than one question; evaluate the combined evidence and
record exact source/attachment sections.

Classify each requirement independently:

- `PROVEN`: the exact required semantic is established by production-applicable versioned primary
  evidence;
- `PARTIAL`: an adjacent capability is documented but a required safety property remains open;
- `UNPROVEN`: evidence is absent, ambiguous, unversioned or inapplicable;
- `CONTRADICTED`: two applicable authoritative statements conflict or an authoritative statement
  conflicts with the proposed invariant;
- `SUPPORT_REQUIRED`: a written provider clarification is still required.

`ANSWERED_WITH_VERSIONED_EVIDENCE` only makes `PROVEN` a candidate; it never assigns it automatically.
If applicable authoritative statements conflict, retain a redacted description in
`contradictoryStatements`, set the reviewer and mapped requirement statuses to `CONTRADICTED`, keep
all affected gates `NO-GO` and treat the deterministic validation error as an unresolved evidence
gate rather than deleting the conflict.

## 7. Perform independent callback security review

If any callback answer is supplied, require a security reviewer independent from the evidence author
to assess:

- authentication and cryptographic integrity;
- canonical payload and covered headers;
- key distribution, storage, rotation and environment separation;
- signed timestamp/nonce and replay window;
- event ID, dedupe, retry, ordering and ACK behavior;
- signed tenant/merchant/reference binding;
- PII minimization and raw-body retention prohibition;
- negative tests for missing/invalid signature, replay, wrong tenant/key/environment and stale order.

TLS and IP allowlisting alone are insufficient. The callback must not become the only source of truth.

## 8. Perform amount/currency/refund review

Require a payment-safety reviewer independent from the evidence author to verify:

- unit, scale, rounding and ISO currency representation;
- gross/net/fee/tip semantics;
- authorization/capture/settlement/expiry;
- per-position/per-booking allocation;
- multiple transactions and partial operations;
- partial/full refund, reversal and chargeback identifiers, amounts and ordering;
- exact immutable merchant/reference/payment binding;
- negative tests for rounding, currency mismatch, multi-position totals and later refund/reversal.

A report total or UI currency label is not an authoritative payment fact.

## 9. Update the evidence matrix

Create a new evidence snapshot; do not edit the preserved provider response. For every requirement,
record old status, proposed status, exact evidence, version/environment, reviewer and rationale.
Recalculate coverage from the rows. Record unresolved tensions explicitly; do not convert them into a
more favorable status.

## 10. Re-evaluate every gate separately

Review all nine gates against the acceptance matrix in
[the package](./viva-provider-clarification-package.md). Record evidence and required negative-test
results per gate. `PARTIAL` is insufficient for every gate. Endpoint existence alone is insufficient.

There is no automatic `GO`. A response-template field cannot change a gate. Any proposed transition
requires a separate evidence review, the named topic reviews and explicit decision-owner approval.

## 11. Create a separate evidence-update PR

Create a new branch/worktree from the then-current evidence chain. The PR must contain only redacted
evidence artifacts, mapping updates, validator updates needed for a real documented contract and
review receipts. It must identify exact base/head SHA, response provenance, document digests,
version/environment scope, before/after coverage and every gate decision.

Do not include preserved raw email, attachments with restricted content, credentials, PII or real
provider/payment identifiers. Run format, lint, typecheck, contracts consistency, focused contract
tests, internal links, URL syntax, secret/PII scans and exact-head CI.

## 12. Conditions that still prohibit implementation

Viva's response still does not authorize implementation if any of the following holds:

- the answer is oral, generic, marketing-only, UI/report-only, undated or unversioned;
- product/API version or production environment applicability is unknown;
- documents are not identified as authoritative;
- merchant-controlled lost-response lookup is absent or cannot distinguish delayed visibility;
- idempotency semantics for the exact mutation are incomplete;
- identifier uniqueness, cardinality, tenant binding or lifecycle is ambiguous;
- amount/currency/allocation/refund/reversal facts are incomplete;
- callback authentication, integrity, replay, event identity, retry/order or tenant binding is
  incomplete;
- callback is proposed as the sole source of truth;
- provider operational limits, rate limits, retry/backoff, consistency or failure isolation are
  unknown;
- raw callback body or customer PII would need to be retained without separate privacy review;
- a required negative test has not been designed and passed against an authorized non-live fixture;
- any mapped requirement remains `PARTIAL`, `UNPROVEN`, `CONTRADICTED` or `SUPPORT_REQUIRED` for the
  proposed gate;
- the evidence reviewers disagree or decision-owner approval is absent;
- the next action would require credentials, provider mutation, callback publication, deployment or
  live data change without separate explicit authority.

Until all applicable conditions are closed, keep delayed provider appearance after timeout as
`UNKNOWN`, never repeat an ambiguous create and keep all gates `NO-GO`.
