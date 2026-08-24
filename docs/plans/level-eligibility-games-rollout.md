# Participation level eligibility: Games rollout plan

Date: 2026-08-24
Base: `d6f772b0a9f57888923b3640e751bf4b5f2b95aa` (`origin/main`)
Branch: `codex/level-eligibility-games-20260824`

## Outcome and authority

Complete the first production-oriented, default-OFF Games slice on current `main`: JOIN,
WAITLIST_JOIN, WAITLIST_PROMOTION, exact personal-invitation bypass, missing-level recovery,
trusted assessment, CUP policy control, immutable decisions, a client-neutral response contract,
bounded observability, local migration evidence, and an OFF -> SHADOW -> WARN -> BLOCK runbook.

This branch may change source, run local/disposable checks, commit, push the feature branch and
open a Draft PR. It must not merge, deploy, apply a migration outside a disposable local database,
change live flags or secrets, call a live provider write, or activate any policy.

## Existing implementation and gap matrix

| Area                                                                    | Status on base                                | This change                                                                           |
| ----------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| Canonical PADEL scale, player projection, policy history/readiness, RLS | Already integrated (`0084`, `0087`)           | Verify; keep additive/default OFF                                                     |
| Pure OFF/SHADOW/WARN/BLOCK level rule                                   | Already integrated                            | Add stable TOO_LOW/TOO_HIGH and safe decision mapping                                 |
| Native GAME JOIN and WAITLIST_JOIN evaluation                           | Already integrated                            | Publish the stored decision through the existing response envelope                    |
| WAITLIST_PROMOTION re-evaluation                                        | Implemented but not operationally integrated  | Add the missing leased worker dispatcher and denial signal                            |
| Promotion-denial notification                                           | Event/rule path existed without this event    | Add strict event contract and explicit audited tenant provisioner                     |
| Exact personal invitation lookup/consume                                | Already integrated                            | Preserve; add negative regression coverage                                            |
| Missing-level selection and trusted assessment recovery                 | Already integrated for Web                    | Consume the client-neutral recovery decision and show WARN without duplicate command  |
| CUP Levels policy/preview/history/rollback                              | Already integrated                            | Expose readiness and impact truth; do not create another section                      |
| Immutable decision/payment snapshot                                     | Already integrated                            | Complete the safe snapshot fields used by Games responses                             |
| Public OpenAPI / generated contracts / SDK                              | Incomplete and inconsistent with runtime      | Add backward-compatible optional eligibility decision data                            |
| Legacy Games bridge                                                     | Present but default OFF and not a live writer | Document as live-gated; do not activate                                               |
| Generic participation-command foundation                                | Present but default OFF and not routed        | Keep as an external-writer extension point; do not dual-route native Games            |
| Tournament/Training writers                                             | Unsupported                                   | Record exact integration points; keep BLOCK prohibited                                |
| Provider callback-loss reconciliation                                   | Missing                                       | Keep readiness false; specify the next bounded package                                |
| Source-specific player-level freshness contract                         | Missing                                       | Preserve explicit STALE rule branch; prohibit WARN/BLOCK until TTL policy is approved |
| Production data-quality evidence                                        | Requires live read-only gate                  | Add an anonymized read-only audit query; do not run live                              |

All historical eligibility commits (`3f833fb`, `1833c54`, `229ee87`, `b0bf0fb`, `22a866c`,
`43a1c3e`, `f45d411`, `d967aea`, `1ae3db0`, `74c5d78`, `06cb12d`) are already ancestors of
the base. No old branch or historical merge is transferred.

## Delivery order

1. Keep the native transactional Games roster path as the single authoritative GAME gateway;
   do not route the same command through the dormant external-writer command foundation.
2. Complete stable rule reasons and the additive safe decision/recovery contract, then update
   generated contracts, SDK and the existing Web recovery/warning UI.
3. Execute reservation expiry and waitlist promotion through a bounded leased worker path; a
   denied candidate is terminal, the queue advances, and a strict notification event is emitted.
4. Complete bounded metrics/logging, CUP readiness/impact visibility and the read-only audit query.
5. Run focused tests first, then formatting, lint, typecheck, contract generation/lint, full tests,
   builds, runtime imports, migration safety, disposable PostgreSQL 16 and targeted browser checks.
6. Perform independent security/integration reviews, inspect the outgoing diff for secrets/PII,
   commit, push only this branch and open a Draft PR.

## Rollout and rollback

- Schema and runtime defaults remain OFF; old clients ignore additive response properties.
- SHADOW observes complete server decisions without blocking. WARN adds a safe warning while the
  command still succeeds. BLOCK publication remains fail-closed behind all readiness evidence.
- Roll back application code while leaving additive tables/columns in place. Roll policy behavior
  back by publishing a new immutable OFF version; never mutate published history.
- A live rollout, migration, flag change, writer switch or data audit is a separate authorized step.
