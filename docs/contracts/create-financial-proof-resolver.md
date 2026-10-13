# CREATE/FIN01 internal proof resolver

Status: **partially implemented; FIN01 and DEFERRED-C2-FIN-01 remain open**.
Stream C starts from frozen `6d761edd61b8f7dad4cac51d57016d74cc733ba6` (PR #388).
The two shared consumer contract files, public DTO, generated SDK, HTTP routes,
commercial CREATE/JOIN guards and runtime composition are unchanged.

## Facts and ownership

| Fact                                            | Actual record/owner                                                         | Permitted source read                                                  | Remaining gap                                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Canonical game and original command             | Games: `games.games`, `games.operations`, `games.command_idempotency`       | Tenant/actor/operation-scoped PostgreSQL reader                        | Existing Games CREATE does not atomically insert the new association.                             |
| Original safe CREATE binding                    | New `games.create_owner_associations`; Games is the only future write owner | `createOwnerAssociationReader`                                         | No admission/quote/consent writer or populated real association exists.                           |
| Mapping continuity                              | Integration: `integration.external_entity_map`                              | Same read-only repeatable-read transaction as the original association | A real approved slot source must be supplied by server composition.                               |
| CREATE booking                                  | Intended C1 LK1 booking owner, existing `lk_subscription_daily_booking_ops` | Future dedicated authenticated CREATE owner read                       | Current B1 GET has only operation/status/asOf/reason, insufficient CREATE binding/receipt detail. |
| Subscription visits applied                     | Intended managed-benefit owner                                              | Future exact operation-bound application receipt read                  | No accepted CREATE benefit receipt producer/read adapter identified.                              |
| Actual monetary settlement and outstanding debt | Intended Commerce/provider or managed-settlement owner                      | Future exact operation-bound financial receipt read                    | Named authority and financial receipt semantics are unaccepted: DEFERRED-C2-FIN-01.               |

The existing `games.payment_confirmation_evidence` is a reservation/JOIN journal.
Its reservation/eligibility/phone/provider linkage is not a CREATE quote/operation,
benefit-visit or debt proof. It is deliberately not used. An observer, advisory
price, a base service amount, absence of an error and a zero quote prove none of
the three financial/booking facts.

## Implemented storage and reads

Migration `0098_create_owner_associations.sql` adds only original custody, not a
ledger or a financial writer. It stores the strict safe PR #388 binding plus
explicit `C1-v1.2`/binding-schema-v1 identifiers and the separate Games request
hash. Raw provider IDs, contacts and secrets are excluded from this record.

The database enforces composite tenant FKs, one operation/one game association,
permanent tenant/actor/intent and tenant/actor/key uniqueness, forced tenant RLS,
and an insert-only trigger. The trigger checks the existing CREATE operation,
organizer, original command receipt/result, original Games request hash and
SHA256 of the original raw command key. That algorithm matches
`subscriptionRuntimeIdempotencyKeySha256`. Initial insertion requires the
PUBLIC/FRIENDLY/open4/SUBSCRIPTION, PROVISIONING/PENDING variant. The reader retains
custody after later terminal operation state; no terminal status releases it.

The reader joins the canonical records and checks exactly one synced actor,
subscription and explicitly selected slot mapping. It recomputes the ordered
C1-v1.2 mapping digest using the actual private actor/subscription Integration
IDs, row IDs, revisions and canonical IDs. Supplied hashes alone are insufficient.
Private IDs remain internal and are not returned. Missing, invalid, unsupported
or drifting sources produce stable internal reason codes.

Limits: this reader does not establish an original quote/consent's provenance or
recompute the private C1 binding/request/intent hashes from incomplete public
terms. It checks the stored hashes as custody, whose future trusted writer must
produce them from the immutable owner quote. `slotVersion` is a recorded owner
source token; it is not inferred from the Integration row revision. The actual
slot source must independently verify that token and quote schedule/station/court
against the canonical game. Those owner-source checks are still absent. The new
table's fences prevent competing associations; unchanged Games code can still
allocate games without an association. Full atomic one-intent/one-game admission
is therefore **not** delivered or claimed by this change.

## Resolver and source quality

`createFinancialProofResolver` loads the expected binding independently before
one owner read, then revalidates original custody/Integration mappings after that
read. It has no create, claim, retry, dispatch, booking, payment, benefit write,
projection persistence, finalization or compensation capability. Separate PG and
owner stores do not become a globally atomic snapshot; completion stays disabled.

`CreateProofOwnerReader` is a **normalized internal server port**, not the frozen
C1 status DTO. Its future adapter must load each receipt from its actual owner,
verify private mappings and current active state, supply booking ID/confirmation
time plus per-receipt binding/attempt/snapshot revision and the receipt's own
binding hash. Frozen C1-v1.2 alone does not supply all these fields. Implementing
this adapter requires a reviewed exact-source read contract, short-lived actor
authorization, timeout, bounded body, no retry/write fallback and redacted metrics.
No production adapter or composition is installed. A payload cannot name its
own authority; injected synthetic test ownership is only LOCAL test evidence.

Structural validation and source quality are distinct. The resolver rejects
foreign tenant/actor/operation/game/quote/slot/subscription identities, changed
terms/currency/visits, mapping drift, wrong receipt binding hash/attempt/revision,
duplicate kinds/refs, timestamps before admission/after owner snapshot, future
snapshots and contradictory settlement/debt. It never manufactures a receipt's
binding hash from expectation or chooses one record out of an ambiguous set.

| Internal state      | Meaning                                                                            | Consumer result                                                  |
| ------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| UNKNOWN             | Missing/unavailable/invalid/conflicting source or no receipts                      | No confirmation; preserve the original operation.                |
| PARTIAL             | Some consistent proofs; another proof/attempt unresolved                           | Separate known facts plus UNKNOWN for missing facts; PROCESSING. |
| PAYMENT_REQUIRED    | Explicit owner receipt reports positive outstanding debt under the accepted amount | Obligation is retained; PROCESSING; no payment action implied.   |
| EVIDENCE_CONSISTENT | All three synthetic/owner-source proofs align and attempt is RESOLVED              | PROCESSING, `canFinalize=false`, FINANCE_ACCEPTANCE_REQUIRED.    |

Amount is checked only against original accepted terms; no price/discount/debt
formula or financial policy is selected. Benefit is separate from monetary
settlement. No-effects rejection, refund, cancellation and benefit reversal are
not inferred. The original `SUCCEEDED` rejection remains in PR #388.

## Stream B handoff and next integration

B receives exported internal reader/resolver types, stable reason codes and the
existing non-final projection (or null when original/source integrity fails).
It may preserve pending recovery with the same operation. This task edits none
of B's UI/SDK/HTTP files and installs no public resolver endpoint.

Required transitions before final success:

1. L/finance owners identify the exact CREATE booking, benefit application and
   settlement/debt records for one original operation, their revision/currentness
   and accepted monetary interpretation. Supply an authenticated read contract
   with the actual evidence fields above; current B1 GET cannot substitute.
2. Games/admission owner validates immutable owner quote/consent and canonical
   slot/game terms, then inserts the association in the original Games transaction
   before any external effect. Rehearse same-intent new-key/terminal/recovery races
   through that actual writer. Schema migration/real activation need separate
   target-specific authority; none occurs here.
3. Implement and review the normalized source adapter; obtain FIN01 financial
   acceptance on exact source receipts for booking, exact visits, actual accepted
   amount/RUB and outstanding debt. Real reads require a known operation/object
   and existing source authorization. No credentials are acquired by this task.
4. Only then consider one separately reviewed common-contract integration diff
   allowing SUCCEEDED after all source/storage/finance predicates and atomic Games
   finalization. The current resolver deliberately has no success switch.

Rollback: revert/unregister the application reader while retaining the expanded
custody table and unique fences. Dropping populated original custody is not a
safe operational rollback. Direct SQL reapply refuses existing security objects;
the normal immutable migration ledger skips the already applied migration.

## Verification scope

LOCAL uses the real resolver and PG reader with synthetic original/owner rows in
the task-owned `fin01-pg-20261013` / `fin01_synthetic`, PG16 on loopback 55431.
Its non-owner NOBYPASSRLS role checks isolation, canonical ties, insert-only custody,
permanent/concurrent uniqueness, actual Integration drift, foreign/ambiguous owner
records, lost response and unchanged business records during concurrent rereads.
No mock returns a predetermined SUCCEEDED. Source tests cover separate partial
facts and receipt/terms/mapping/time/attempt conflicts.

Reproduce the physical tests only against that owned synthetic target, after the
normal migrator has applied this source chain:

```sh
FIN01_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55431/fin01_synthetic \
  npx vitest run packages/database/src/create-owner-association.pg.test.ts --maxWorkers=1
```

Automatic CI does not provision this task's physical PostgreSQL; its PG test is
explicitly skipped without the guarded FIN01_TEST_DATABASE_URL. LOCAL full source
checks and exact-head CI are reported separately. STAGING, PROVIDER and PRODUCTION
financial/storage/runtime acceptance are unavailable and unclaimed.
