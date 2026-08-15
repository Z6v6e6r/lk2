# Chat and Push staging foundation readiness — 2026-08-15

## Verdict

- Local code and workflow design: `GO` for commit and immutable-CI preparation.
- Staging dispatch: `NO-GO`. Immutable GitHub Action pinning is now closed in source, but the
  protected Environment, exact committed candidate and live staging preconditions remain external.
- Chat, Web Push and booking reminder activation: `NO-GO` until the separate runtime, provider and
  authoritative booking-producer gates below are closed.
- No commit, push, workflow dispatch, deployment, migration, provider request or shared-data
  mutation was performed while producing this evidence.

The earlier
[chat-push-p1-integrated-readiness-2026-08-15.md](./chat-push-p1-integrated-readiness-2026-08-15.md)
remains historical integrated-foundation evidence. It is not an attestation for the staging
maintenance workflow recorded here.

## Source boundary

- Worktree: `.worktrees/chat-push-staging-foundation-20260815`.
- Branch: `codex/chat-push-staging-foundation-20260815`.
- Pre-commit `HEAD` and merge base:
  `dbfed4367dcc414b2ee9f8644c5e4aa4a4417804`.
- A final read-only fetch observed `origin/main` advance to
  `378701a0ca72ac478e2be608791b3ce681af8093` (`ci(staging): add media binary-only rollout gate
(#30)`). That commit overlaps this patch in the staging workflow, migrator build config, both
  release runbooks and the nano-presentation contract. It is not integrated into this frozen patch;
  semantic integration and a full evidence rerun remain required before PR or staging dispatch.
- Tracked changed files: `19`.
- Untracked source inputs in the manifest below: `19`.
- This audit file is the twentieth untracked file and is excluded from its own manifest.
- Staged entries: `0`; unmerged entries: `0`.
- SHA-256 of `git diff --binary` before this audit file:
  `d90024d62ee40dfc7e6c3ab150790b76e6cf1dba79269a9dfee6694ebc067ca4`.

Untracked SHA-256 manifest:

```text
cd7b600c667b0c63e168f15112a7360582dc66adc1377cf105ed058d666b720f  apps/migrator/src/chat-push-foundation-clients.test.ts
7e309f35b232a932491c5804773f82b1480950d8c99557ca6c7a7d953b05120a  apps/migrator/src/chat-push-foundation-clients.ts
726148dbb16364dd79fb13d6c57765bcaffa9667808fcd2b3f61b978204b95f6  apps/migrator/src/chat-push-foundation-contour.ts
874153357646b84787407dfd103c01d124c80f7ae4a80e8c5a647633036341a8  apps/migrator/src/chat-push-foundation-operational.test.ts
f9b53ce76cf20668f18444ff4418b37d88ad4a2fce341e3d323be0a8fe8e163f  apps/migrator/src/chat-push-foundation-operational.ts
30e71b9504e5eb719d61fb5a5ad4ffefbd482e2841cb458826e08dfec3314b2d  apps/migrator/src/chat-push-foundation-verifier.pg.test.ts
7cde00b5eb87086405c287ad4f3c539a92d265c8669475ce2ea7fa1d50c4a452  apps/migrator/src/chat-push-foundation-verifier.test.ts
736cd1b10d66cdceb93c890c2bc79e13b994cfddff512a3e1ff3371576c81a53  apps/migrator/src/chat-push-foundation-verifier.ts
6913200b776cef9e7c94bfc88fa52d512a27f6ee71ac74aa268a07965d448663  apps/migrator/src/verify-chat-push-foundation-contour.ts
3d5ffc74b2d19c074c250fbdf157189cf52ce104e83676ab05f1c1a4a36895c9  apps/migrator/src/verify-chat-push-foundation-operational.ts
d34b87cbcb091bf2d5f475944101c8ad8584a761543914c8018bc77dc0931555  apps/migrator/src/verify-chat-push-foundation.ts
03fb2139b01b5a7865e5e0ab7e63a9055903f76d15cf14db0d1055cbdfdd0a6e  deploy/jetson/run-chat-push-foundation-release.sh
f3a33512f4c451a3450429a6d5e8a4d3f2eb8417857fa7f4fc21662feba755ec  deploy/jetson/verify-chat-push-foundation-clone.sh
6070794a341e8a7e583e3d72df3806ded79e8c34a7f2d598b90e1b165a4259b5  deploy/jetson/verify-chat-push-foundation-runtime.sh
4d998cd1d2fef3506bf3e17f571c12b133e1a5c1e73c223cc40430c3376e67b1  scripts/chat-push-foundation-release-contract.test.ts
1479d65176f2a14c771c22d60bf9cfa826678b654676f697df7ebcef3a188121  scripts/chat-push-foundation-request-validation.test.ts
4288c97974fccc7878907aae8fb572a195fe1df903e43df17058d9974fd354f2  scripts/verify-chat-push-foundation-clone.test.ts
ee2b439d50f0ed1d7ea5e85c6d6c52aaef12ac17e64f1386b04af8889791507c  scripts/verify-chat-push-foundation-runtime.test.ts
f1cb354c331a17ab628b79e69cedcb51befab9c5d573846ff05e757748798067  scripts/verify-direct-chat-realtime-e2e.loopback.test.ts
```

## What is ready in code

- `CHAT_PUSH_FOUNDATION` is a dedicated, non-promotable staging maintenance profile. It cannot
  inherit the normal messaging-test, routing, Home, Communities, Viva, CUP or production-promotion
  paths.
- `CHAT_PUSH_FOUNDATION_RECOVERY` is bound to the original run, attempt, candidate SHA, image
  digests, application snapshot, PostgreSQL archive size and SHA-256, clone catalog digest,
  monitoring source digest and durable phase marker.
- The one-shot migration acknowledgement is passed only to the drained foundation migrator
  invocation. Ordinary staging and production migration paths retain no acknowledgement.
- API, worker and realtime are drained before the final backup and migration. Runtime sessions,
  tenant inventories, endpoint/semantic rows, relevant unpublished outbox events and exact Rabbit
  topology are rechecked immediately before the irreversible marker and acknowledgement.
- Runtime, realtime, migrator and infrastructure-admin observations are bound to one PostgreSQL
  system identifier and database. Exact role, ACL, forced-RLS, policy, constraint, index, ledger and
  zero-state postconditions fail closed.
- The final-precedence foundation overlay contains only the three default-off API/worker gates and
  cannot be redirected by Compose interpolation. Realtime, web and migrator do not receive it.
- Candidate definitions use a run-bound same-directory temporary Compose file, remote structural
  validation and atomic rename. A partial upload cannot corrupt the active definition needed by
  failure containment.
- Candidate startup is sequential: API, worker, realtime and web. Worker evidence is bound to the
  current service instance, successful operational collection, booking gauge presence, exact
  Rabbit state and a monotonic minimum 30-second quiet window.
- Recovery writes `RECOVERY_STARTED` before operational mutation, records drain progress and never
  restores the database or automatically restarts old writers after migration starts.
- The direct-chat verifier now has deterministic injected-transport unit coverage for message,
  buffer, malformed JSON and readiness failures. Its default path still constructs a real
  `ws.WebSocket`; the same four real loopback cases run when `CI=true` or by explicit opt-in.
- Every external staging workflow Action is pinned to the exact 40-hex commit resolved from its
  official upstream major tag. The fail-closed authorization scanner now reports `17` pinned and
  `0` unpinned references.

## Local verification

- `npm run check`: `PASS` on this source boundary. It completed formatting, lint, full typecheck,
  contract lint, the full default local test command, every build and runtime-import verification.
- Full Vitest result: `312` files passed, `4` skipped; `2008` tests passed, `38` skipped.
- The four real WebSocket loopback cases are among the visible local skips because the default local
  policy does not enable that suite. `CI=true npx vitest list` discovers all four. A separate
  explicit opt-in attempted all four and confirmed that this sandbox rejects `listen` on
  `127.0.0.1` with `EPERM`; it is not recorded as a transport PASS.
- Deterministic direct-realtime verifier suite: `10/10` passed.
- Official upstream `git ls-remote` resolution and the workflow scanner: `PASS`. The immutable pins
  are recorded below; major tags remain comments only and are not executable refs.

  ```text
  actions/checkout@11d5960a326750d5838078e36cf38b85af677262              # v4
  tailscale/github-action@306e68a486fd2350f2bfc3b19fcd143891a4a2d8      # v4
  actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020          # v4
  docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f # v3
  docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9         # v3
  docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8    # v6
  actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02     # v4
  actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093   # v4
  ```

- Workflow YAML parse, targeted Prettier and the request/release/nano-presentation contract suites:
  `PASS`, `3` files and `53` tests.
- `npm run db:migrate:check`: `PASS`, `85` migrations.
- `npm run contracts:lint`: `PASS` with six unchanged non-blocking baseline warnings.
- Focused staging-foundation suites, shell syntax, TypeScript, ESLint, Prettier, Compose structural
  rendering and `git diff --check`: `PASS` in their recorded local runs.
- No production or staging endpoint, provider, database, broker or secret-bearing environment was
  accessed by these source gates.

## Independent R4 review

- Staging release design and recovery: `GO` after atomic Compose installation and recovery
  containment fixes; no remaining P0-P2 code finding.
- Cross-system integration: `APPROVE`; the latest WebSocket testability delta preserves the real
  default transport and all fail-closed behavior.
- Security: `APPROVE`; the socket factory is not reachable through CLI or environment input, and no
  new lower-privilege injection or trust-boundary bypass was introduced.
- Migration design: `APPROVE`; the final test-only verifier delta does not change DDL, ledger, ACL,
  RLS, backup or acknowledgement ordering.

## Pre-dispatch stop conditions

The initial staging dispatch remains `NO-GO` until every remaining item below is independently
evidenced for the exact committed candidate SHA:

1. Integrate the exact candidate commit with `origin/main` at or after `378701a0ca72`, preserve both
   the media binary-only rollout and staging-foundation semantics across the five overlapping files,
   then regenerate this source boundary and repeat the full R4 gates.
2. Configure and independently verify the protected `staging-foundation-maintenance` Environment:
   required reviewer, prevented self-review, `main`-only deployment branch, disabled administrator
   bypass, exact readiness variable and numeric actor-ID allowlist.
3. Run PR CI on the exact integrated SHA and prove the four real loopback tests
   executed rather than skipped.
4. Capture read-only staging inventory for exact active release, tenant keys, per-tenant gates,
   endpoint and semantic row counts, relevant pending outbox records, runtime sessions and absence
   of every authoritative booking lifecycle producer. Prove the exact runtime and migrator roles
   can execute `pg_catalog.pg_control_system()` without broad `pg_monitor` membership.

## Acceptance inside an authorized foundation run

An approved first-attempt dispatch is not a pre-existing proof. The run itself must fail closed while
it builds five immutable images once, binds every digest artifact to the candidate SHA, and then
proves the verified backup and real restore, exact lower-gap clone, lock timing,
role/RLS/catalog pre/postflight, Rabbit arguments and bindings, Prometheus target/rule/series
evidence and sequential API, worker, realtime and web startup. Any failed check keeps production
untouched and follows the phase-specific containment rules. Deliberate fault injection on actual
staging is not part of the first maintenance dispatch; recovery fault exercises require separate
authorization and should first be rehearsed on a disposable equivalent contour.

## Post-run and activation gates

After a successful foundation run and before any broader release claim:

1. Run authenticated direct-chat HTTP/realtime recovery on the exact staging digest, including real
   broker interruption, readiness `503 -> 200`, consumer re-registration and no duplicate fanout.
2. Keep Web Push, block commands and reminders globally and per-tenant disabled. Provider delivery,
   VAPID lifecycle and booking reminder activation require their own later authorization and
   evidence. The reviewed repository does not implement an authoritative transactional booking
   lifecycle producer; absence of every active external Viva, Node-RED or scheduler producer remains
   unverified under pre-dispatch gate 4.

Production is outside this profile and remains untouched. Application rollback retains the
additive schema; no destructive schema rollback is authorized.
