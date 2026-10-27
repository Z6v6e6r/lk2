# C2 reconcile integration — evidence (LOCAL)

Owner: c2-server (task-2) · Branch: `agent/c2-reconcile-integration` · Draft PR: **#498**, base `agent/c2-web-attempt-integration`, head `agent/c2-reconcile-integration` · Date: 2026-10-27.

This is a **stacked integration PR**: it ports only the semantic delta of PR #466 onto the C1 integration branch (PR #497), which already contains PR #453 rebased on `main` plus the C1 review fixes F1/F2. It is not a merge into `main`, not a release, and asserts no STAGING/PROVIDER/PRODUCTION evidence.

## 1. Source identity

| Role                                                     | Ref                                | SHA                                        |
| -------------------------------------------------------- | ---------------------------------- | ------------------------------------------ |
| `origin/main` at integration time                        | `main`                             | `871cc2f8660ec98ec4b95f50a78aad1e6d1b1cfe` |
| C1 integration base (PR #497, review-fix head)           | `agent/c2-web-attempt-integration` | `21d01c5ee051cdf7706ab8e34c2be0802e87336e` |
| Previous C1 base superseded by the review fixes          | `agent/c2-web-attempt-integration` | `5daf5693567f80a407e07cf3db047aa04f2dda45` |
| C2 merge commit (this branch = C1 `21d01c5e` + C2 delta) | `agent/c2-reconcile-integration`   | `594f844718817cfa33a2aa277d28ca467309427d` |
| PR #453 head                                             | `codex/c2-commercial-ui-20261021`  | `9a8bb3e2`                                 |
| PR #466 head                                             | `codex/c2-reconcile-20261023`      | `a8de3c97`                                 |
| PR #466 true base (`merge-base(origin/main, a8de3c97)`)  | —                                  | `cec67b42c5096b445edeccadbcfb53b282f2b996` |
| Auto-merge tree of `cec67b42` + `9a8bb3e2`               | —                                  | `4617fc1f974f8dfd235f7397911faedd34d60934` |
| #453↔`origin/main` fork point                            | —                                  | `29e109fa745d862d3d8eb0a79bfa5b97fb21cb7e` |
| C2 code commits                                          | `fix(api): …` / `feat(android): …` | `4f6f4120`, `bdd6fd86`                     |
| C2 evidence commits                                      | `docs:` / `style:`                 | `cabe9e07`, `0d545cb4`                     |

The final C2 head is the review-follow-up evidence commit on top of merge commit `594f8447`; the exact head SHA is what PR #498 reports as `headRefOid`.

## 2. Semantic-diff proof for #466

`git merge-tree --write-tree cec67b42 9a8bb3e2` exits 1 and emits exactly **one** conflict (`apps/web/src/GamesPage.tsx`); the resulting tree is `4617fc1f`. Diffing that auto-merge tree against the #466 head isolates #466's own contribution from #453/main drift:

```
$ git diff --numstat 4617fc1f a8de3c97
43      0       apps/api/src/games/game-commercial-join.test.ts
27      0       apps/api/src/games/game-commercial-join.ts
5       2       apps/mobile/android/app/src/main/java/ru/padlhub/app/AndroidSessionPolicy.java
14      0       apps/mobile/android/app/src/test/java/ru/padlhub/app/AndroidGameJoinSessionTest.java
4       8       apps/web/src/GamesPage.tsx
```

= **exactly 5 files, +93/−10**, matching the pre-verified delta. The `GamesPage.tsx` part is only the conflict resolution: remove the three conflict markers, keep main's `reconcilePaidJoinOperation` step and deadline-wrap both the GET and the reconcile call.

Accounting against main (3-dot on the final branch, after the evidence doc was added):

```
$ git diff --name-only origin/main...HEAD | wc -l   # 18
$ git diff --name-only origin/main...HEAD -- apps/api
apps/api/src/games/game-commercial-join.test.ts
apps/api/src/games/game-commercial-join.ts
```

18 files = PR #453's 15-file delta (`git diff --name-only origin/main...9a8bb3e2 | wc -l` = 15) + the 2 #466 server files + this evidence document. The code-scope claim is exact: `apps/api` contains **only** those 2 server files, so there is no unexpected server change. (The 100-file GitHub list for #466 is #453 plus main drift, not #466's delta.)

Delta actually re-applied by this PR (vs C1 review-fix head `21d01c5e`, apps only):

```
$ git diff --numstat 21d01c5e HEAD -- apps
43      0       apps/api/src/games/game-commercial-join.test.ts
27      0       apps/api/src/games/game-commercial-join.ts
5       2       apps/mobile/android/app/src/main/java/ru/padlhub/app/AndroidSessionPolicy.java
14      0       apps/mobile/android/app/src/test/java/ru/padlhub/app/AndroidGameJoinSessionTest.java
```

`apps/web/` is **untouched** by this PR (`git diff --stat 21d01c5e HEAD -- apps/web` is empty), so C1's F1/F2 review fixes below are inherited unmodified.

## 3. Integration verification

- **GamesPage needs no C2 change.** The `pollJoinOperation` GET/reconcile block of the final tree (inherited from C1 `21d01c5e`) is **byte-equivalent** to `a8de3c97` (478 bytes):

  ```
  let raw = await withJoinDeadline(
    gateway.getPaidJoinOperation(gameIdValue, attempt.idempotencyKey),
  );
  …
  raw = await withJoinDeadline(gateway.reconcilePaidJoinOperation(raw.operation.id));
  ```

- **C1 custody rules intact** in the final tree: `releaseUndispatchedGameJoinAttempt` (recovery path, and the manual status path at `apps/web/src/GamesPage.tsx` when `dispatchStartedAt === undefined`), `classifyGameJoinReadbackNotFound` + `releaseNotFoundGameJoinAttempt` (404 catch), plus the F2 stale-`SUCCEEDED` discard. Porting `a8de3c97`'s GamesPage verbatim would have reverted these, so it was deliberately not applied.
- **C1 review fixes F1/F2 inherited unchanged.** F1 (`GAME_JOIN_ATTEMPT_QUIET_MS` 60s→180s in `apps/web/src/game-join-attempt.ts`, with the corrected server-side derivation in its comment) and F2 (discard stale `SUCCEEDED` custody on reopen in `apps/web/src/GamesPage.tsx`) come from C1 `21d01c5e`; C2 adds no web change and touches neither rule.
- **Server port is faithful.** The whole `reconcileCommercialJoinOperation` function and the new regression-test block are **byte-equivalent** to `a8de3c97` (5151 chars / exact block). The fix is at `apps/api/src/games/game-commercial-join.ts` (`confirmed.outcome === 'applied'` returns `revision: confirmed.revision`, attempt state `OWNER_CONFIRMED`); regression test `apps/api/src/games/game-commercial-join.test.ts` "returns the confirmed revision even while the attempt projection still lags".
- **Main drift does not collide.** `cec67b42..origin/main` changed `game-commercial-join.ts` (+16/−3, the `prepare()` → `CommercialJoinPrepareResult` contract, `GAME_SUBSCRIPTION_SELECTION_REQUIRED`) and its test (+27/−1), all outside the reconcile block. `git apply -3 --check` of the #466 server patch against a temporary index of `origin/main` applied cleanly; the integrated file keeps main's `CommercialJoinPrepareResult` **and** #466's applied-revision return.
- `git apply -3` of the two Android hunks applied cleanly onto the C1 tree; `apps/mobile/android` had no `main` drift since `29e109fa`.

## 4. LOCAL test evidence (final merged tree)

Environment: macOS, Node v26.8.2, vitest 4.1.10, `NODE_OPTIONS=--no-experimental-webstorage`; JDK `openjdk 21.0.10` (Homebrew `openjdk@21`); Gradle 8.14.3 (wrapper); AGP `com.android.tools.build:gradle:8.13.0`; `com.google.gms:google-services:4.4.4`; `junit:junit:4.13.2`; `androidx.test.ext:junit:1.3.0`; `androidx.test.espresso:espresso-core:3.7.0`; compileSdk/targetSdk 36; `openapi-typescript 7.13.0`.

| Check                             | Command                                                                                                                                                                                                                       | Result                                                                                                                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API acceptance                    | `node_modules/.bin/vitest run apps/api/src/games/game-commercial-join.test.ts apps/api/src/games/game-commercial-join-runtime.test.ts apps/api/src/games/game-routes.test.ts apps/api/src/games/game-join-conditions.test.ts` | **4 files passed; 95 passed, 1 skipped** (`game-commercial-join` 37, `-runtime` 13, `game-routes` 20, `game-join-conditions` 26 with 1 skip)                                                                     |
| Web acceptance                    | `node_modules/.bin/vitest run apps/web/src/GamesPage.test.tsx apps/web/src/game-join-attempt.test.ts apps/web/src/game-join-flow.test.ts`                                                                                     | **3 files passed; 105 passed** (`GamesPage` 50, `game-join-attempt` 22, `game-join-flow` 33) — includes C1's new F2 page test                                                                                    |
| Android host-JVM                  | `./gradlew :app:testDebugUnitTest --offline --no-daemon --rerun-tasks`                                                                                                                                                        | **BUILD SUCCESSFUL; 11 tests, 0 failures, 0 errors** (`AndroidGameJoinSessionTest` 7/7 incl. `forwardsCanonicalReceiptReconciliationWithTheSameKey`; `AndroidYandexLoginCallbackUrlTest` 3; `ExampleUnitTest` 1) |
| Android instrumented-test compile | `./gradlew :app:compileDebugAndroidTestJavaWithJavac --offline --no-daemon --rerun-tasks`                                                                                                                                     | **BUILD SUCCESSFUL** (task executed)                                                                                                                                                                             |
| Typecheck (server closure)        | `tsc -p tsconfig.node.json --noEmit`                                                                                                                                                                                          | exit 0                                                                                                                                                                                                           |
| Typecheck (web closure)           | `tsc -p tsconfig.web-app.json --noEmit`                                                                                                                                                                                       | exit 0                                                                                                                                                                                                           |
| Contracts (for typecheck)         | `npm run contracts:generate`                                                                                                                                                                                                  | exit 0 (generated files are gitignored, not committed)                                                                                                                                                           |

## 5. Review follow-up (F1, F2, F6, F7)

- **F1 (quiet window) — inherited from C1 `21d01c5e`, unchanged.** `GAME_JOIN_ATTEMPT_QUIET_MS` is 180s with the corrected derivation (conditions re-read default 28s + DB prepare/admission before the durable row; the 5s setting only sizes admission/read HTTP clients). C2 touches no web file.
- **F2 (stale SUCCEEDED custody) — inherited from C1 `21d01c5e`, unchanged.** A stored terminal `SUCCEEDED` attempt is discarded on reopen (main parity) instead of blocking JOIN for the retention window; C1's new page test is included in the 105 web passes above.
- **F6 (this document) — fixed.** The 3-dot `origin/main...HEAD` count is **18**, not 17: 15 #453 files + 2 API files + this evidence document. The code-scope claim stays exact (`apps/api` = only the 2 server files, shown in §2).
- **F7 (Android reconcile-key regex looser than the server) — accepted minor, no code change (scope control).** `AndroidSessionPolicy` admits `POST /game-operations/<uuid>/reconcile` with any key matching the generic idempotency-key format, while the server requires the exact header `join-reconcile:<operationId>` plus an empty body (`apps/api/src/games/game-routes.ts:903-911`) and the official SDK builds exactly that key (`packages/api-sdk/src/index.ts:1672`). Server-side enforcement is authoritative: any other key is rejected with `400 INVALID_REQUEST`, so the looser client allowlist grants no trust and creates no security boundary. Tightening it is not a one-line change because the native transport would have to send the prefixed key (the #466 test intentionally forwards the operation UUID "on the same idempotency key"); it is left as a documented follow-up for when the native reconcile caller is wired.

## 6. Environment gaps (LOCAL only, not committed)

1. The shared symlinked `node_modules` (from `.worktrees/lk2-commercial-create-warn-20261027`) lacks `mongodb`, so `game-routes.test.ts` cannot load (`Cannot find package 'mongodb'`). Local/untracked workaround: `packages/legacy-games-adapter/node_modules/mongodb` → `.worktrees/ph-admin-p1-20261021/node_modules/mongodb`. CI installs with `npm ci` and is not affected; nothing about this is committed.
2. Gradle **offline is impossible on this host**: `~/.gradle` has the 8.14.3 wrapper dist but no dependency cache (`modules-2` absent), so `--offline` failed with `No cached version of com.android.tools.build:gradle:8.13.0 available for offline mode` (and `com.google.gms:google-services:4.4.4`), before which the sandbox denied the wrapper lock under `~/.gradle` (`Operation not permitted`). With Lead approval, a one-time resolution of public artifacts from Google Maven/Maven Central was used (`GRADLE_USER_HOME=/tmp/c2-gradle-home`, no secrets/credentials, no repo or global writes); afterwards the Android tasks also run `--offline`.
3. `apps/mobile/android/capacitor-cordova-android-plugins/` is gitignored/generated and absent from a clean checkout (`app/capacitor.build.gradle` requires `cordova.variables.gradle`). Restored locally from `.worktrees/c2-commercial-ui-20261021`; not committed.

## 7. Not run / residual risk

- **NOT run:** STAGING smoke (no authority; out of scope for this task), device/emulator instrumented-test execution (compile only), provider acceptance, full monorepo `npm run check`, local lint/format (CI carries repo-wide gates), Docker image build.
- Residual risk: CI configuration for a **non-main PR base** may skip some `main`-only gates; this stacked PR must be integrated in order (#498 into #497, then #497 into `main`) and re-verified there. Provider/owner reconciliation behavior is unchanged by this delta (it returns the already-applied revision instead of re-reading), but it remains payment-adjacent code and needs a specialist review before merge.
- CI conclusion for the final head is reported on PR #498 (`gh pr checks 498`); this file records LOCAL evidence only.
