# Communities read-only local checkpoint — 2026-08-11

## Verdict and boundary

- Checkpoint: `GO` for the bounded local authenticated read-only preview.
- Baseline commit: `e4499b9957d9375e18052167ef8250939f03ef0c`.
- Integration branch: `codex/communities-read-only-checkpoint-20260811` (clean baseline plus the bounded packet; this audit was finalized before the approved checkpoint commit).
- Supported surface: directory, detail, feed, chat transcript and rating projection.
- Source: server-selected `COMMUNITIES_READ_MODE=legacy`; the browser never selects or receives the legacy source identity.
- Mutations: disabled. Canonical writes/import, media, realtime, invites, worker activation, migrations, staging and production remain `NO-GO`.

The user separately approved creating the local checkpoint commit after this audit. This document does not authorize a push, merge, deployment, migration or data mutation.

## Runtime acceptance evidence

- Runtime processes: healthy `phub-api-1` and `phub-web-1`; worker and realtime were absent.
- Two sequential authenticated browser cycles across all 19 visible communities: `38/38` clean journeys.
- Every journey verified detail, feed, chat and rating readiness.
- Browser journey latency: p50 `4.944 s`, p95 `11.256 s`, max `17.551 s`.
- Browser warnings/errors: `0`.
- Privacy/mutation boundary violations: `0` (no phone-like values, client IDs, legacy IDs or enabled mutation controls).
- API after restart:
  - chat `38/38`, p95 `681 ms`, max `1305 ms`;
  - feed `38/38`, p95 `1876 ms`, max `3564 ms`;
  - membership `114/114`, p95 `2386 ms`, max `7190 ms`;
  - rating `38/38`, p95 `717 ms`, max `836 ms`;
  - failures, retries and warning/error events: `0`.
- Independent R3 review: `B0 / H0 / M0`, local reliability checkpoint `GO`.

## Code and contract gates

- Exact clean-worktree checkpoint suite: `14` files, `201/201` tests passed.
- Root TypeScript check passed for Node, Web, Mobile, CUP and tools projects.
- OpenAPI/imported-contract lint passed. Redocly reported the existing five warnings; no warning was introduced or suppressed for this checkpoint.
- API, API SDK and Web production builds passed. Web retained the existing chunk-size warning.
- `git diff --check` passed before the checkpoint document was added and must be repeated after every integration edit.

Exact focused test command:

```bash
npx vitest run \
  apps/api/src/app.test.ts \
  apps/api/src/auth/auth-routes.test.ts \
  apps/api/src/communities/legacy-community-read-repository.test.ts \
  apps/api/src/communities/community-experience-routes.test.ts \
  apps/api/src/communities/legacy-community-experience-repository.test.ts \
  packages/communities/src/index.test.ts \
  packages/communities/src/community-read-experience.test.ts \
  packages/database/src/community-repository.test.ts \
  apps/web/src/App.test.tsx \
  apps/web/src/auth-gateway.test.ts \
  apps/web/src/CommunityReadOnlyPage.test.tsx \
  apps/web/src/communities-ui/CommunityDetailShell.test.tsx \
  packages/api-sdk/src/index.test.ts \
  packages/config/src/index.test.ts
```

Other exact gates:

```bash
npm run typecheck
npm run contracts:lint
npm run build --workspace=@phub/api
npm run build --workspace=@phub/api-sdk
npm run build --workspace=@phub/web
git diff --check
```

The previous transient membership `404` was not converted into a retry. It remains fail-closed until the provider contract documents whether it can be transient.

## Exact new read-only files

These files can be integrated as whole files after verifying the SHA-256 values:

| SHA-256                                                            | File                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `8426a8a48d0c1b75c5582ffbeb830d0a319627a0c414f913667e7274a584e8c9` | `apps/api/src/communities/community-experience-routes.ts`                 |
| `b7aa9ecbd3a2c89d4170f3120f970fa0e3877d523bf98191faa5b3a32f8a8044` | `apps/api/src/communities/community-experience-routes.test.ts`            |
| `a157e6c05a0f7a6a5fdc00ff9fa1459a6205b56c685f27496f257ad5e8e47b1f` | `apps/api/src/communities/legacy-community-experience-repository.ts`      |
| `6aaa1c149ab1fa6d146033f3ffb31a212b5ea08547d35670e64e18180a72183a` | `apps/api/src/communities/legacy-community-experience-repository.test.ts` |
| `68a5e24b24e04daf471a375999c5e76140ab02a79c00a541796c6bd549dec721` | `packages/communities/src/community-read-experience.ts`                   |
| `76a0f6ce46a020a745a7a8a0ab94496b0c5b4c4f0564522cb71a69c86bba089c` | `packages/communities/src/community-read-experience.test.ts`              |
| `dc63ce2febd58625cc0d6feff9b66a981642e89bd53b62c6370b9a35317e22f5` | `apps/web/src/CommunityReadOnlyPage.tsx`                                  |
| `eaccf384b4935c8bc99020d7d15eb804aac8115ad74940f24a1d3f0417c5a4a3` | `apps/web/src/CommunityReadOnlyPage.test.tsx`                             |
| `eca0307ff1c46be2cc91a56dce57a05768199d8cd439a9a339988eca63b34cd8` | `apps/web/src/communities-ui/CommunitiesReadOnly.module.css`              |
| `0b76dd8450be11e8f22f9dd46aa5517f824b7d994d5fca45ae9c63acd14a4390` | `apps/web/src/communities-ui/CommunityChatTranscript.tsx`                 |
| `e5268f7e1ecdd0b4e864cfa5a0d71ed855055efa127226f1161aeb0fb06b5988` | `apps/web/src/communities-ui/CommunityDetailShell.tsx`                    |
| `baec815b53be34c4851e6bc29628d9f743437c14f4802bfcf68affaf209195cf` | `apps/web/src/communities-ui/CommunityDetailShell.test.tsx`               |
| `dfefc7b5647e66ebaaa79d3e1c2f4c0501f51a802a3b112b7d77e9380389d140` | `apps/web/src/communities-ui/CommunityFeedList.tsx`                       |
| `d7d254e3e06d33776325434beed6bca5c0f539cba36421848ae61e23731b10eb` | `apps/web/src/communities-ui/CommunityRanking.tsx`                        |
| `1f1a6f1365f7c8c0666936afa83649a1df35ab74972ddbb22aa9a24222c34d4e` | `apps/web/src/communities-ui/index.ts`                                    |
| `2cdcc9a3761cbfcf40ce2af243afd7624e2221c379c835c33d291bfe8ef35136` | `apps/web/src/communities-ui/types.ts`                                    |

The directory reuses the baseline `packages/communities/src/index.ts` directory service and the baseline legacy adapter. The new canonical `packages/communities/src/community-read.ts` and its test are not part of this checkpoint.

## Shared-file hunks required for integration

Do not stage or copy these files wholesale from the dirty worktree. Hand-apply and review only the named read-only hunks:

- `.env.example`: four default-false `COMMUNITY_LEGACY_READ_*_ENABLED` flags and bounded legacy provider settings.
- `packages/config/src/index.ts` and test: default-false flags, legacy-only invariant, timeout/retry/circuit/cache bounds.
- `packages/communities/src/index.ts` and test: optional `getCommunityExternalId`, `memberRank` projection and the `community-read-experience` export only. Do not copy any other new export.
- `packages/database/src/community-repository.ts` and test: tenant-scoped reverse lookup of the existing `LK_LEGACY/community` mapping only.
- `apps/api/src/communities/community-runtime.ts`: legacy read-experience factory only. The baseline legacy directory runtime is reused unchanged; canonical runtimes are excluded.
- `apps/api/src/app.ts` and tests: runtime capabilities and experience route registration.
- `apps/api/src/auth/auth-routes.ts`: optional expand-release runtime capabilities in authenticated sessions.
- `apps/api/src/main.ts`: construct/inject the read-experience runtime only; retain the baseline directory wiring.
- `contracts/openapi/user/v1/openapi.yaml`: read-only routes, DTOs and four optional default-deny capabilities.
- `packages/api-sdk/src/index.ts` and test: directory/detail/feed/chat/rating GET methods only.
- `apps/web/src/auth-gateway.ts` and tests: default-deny capability parsing and SDK delegation.
- `apps/web/src/App.tsx` and tests: `/communities` and `/communities/:uuid` read-only routing/gates.
- `apps/web/src/CommunitiesPage.tsx`: directory carousel and read-only navigation only.

The current `apps/api/src/communities/community-routes.ts` and its test contain canonical command/discovery changes and are excluded wholesale. The baseline authenticated directory endpoint remains the source for `/communities/mine`.

Shared-file provenance (`base blob` is the Git blob at baseline `e4499b9`; `candidate SHA-256` identifies the dirty candidate file from which the named hunk is extracted):

| File                                                 | Base blob                                  | Candidate SHA-256                                                  |
| ---------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| `.env.example`                                       | `04c91521d74ebd1bad37e2d5a3aeea815b18b99c` | `20093ceaadf62cc96857d7b0f07ec51c662982a5aca0943a69f43a143ea76f2d` |
| `packages/config/src/index.ts`                       | `ba2b932b81e73e6973073c9908826dac57b98cc2` | `a240c11ddef1681b6fe6f70b4d0ee7ee8fa0ca92b8d01c0c9a3ba23443401015` |
| `packages/config/src/index.test.ts`                  | `89f2ded9831065adaf2822fd337b9f7ace9b5421` | `7cbb037e8e6b04a92308832fe3b93bf0bbc853fda92e82d14c3f6cbf6be9df48` |
| `packages/communities/src/index.ts`                  | `2f7cf30b90c60aa6cd635f5802aae2b3f336aad1` | `ac496faf0cfda21af6c39a44292bfbba5b8c60be7971bfeb576a7c9b2cb06b0a` |
| `packages/communities/src/index.test.ts`             | `bed4e974a11f4837f4d6b91ca3ab5c84ebf515db` | `c1283d837e4ca2d98deed6d0c784a93727a28e7adfa40b3a49622f0aa0baa4f5` |
| `packages/database/src/community-repository.ts`      | `052b40f3e2a81cd74d0592833232059df6d95a92` | `0158a7311b422e15e5c4d5ca745846cca9263fe40ede3280becdb983c710bb1f` |
| `packages/database/src/community-repository.test.ts` | `d4e8b7a13c239e6acc14417f7f800a3ba5e25040` | `dccfdfeb3db6d4bab41d22c6a2015c5aaa0c9b04909d7cbdf79bec6e4cee7c92` |
| `apps/api/src/auth/auth-routes.ts`                   | `ef4a5217a7a5bade99aadfa6e75df3505fd5f9d9` | `faf962e8ef684678595fd9be413f39e69ba06738316ad44153218dd7d1b0d478` |
| `apps/api/src/communities/community-runtime.ts`      | `da5d59c0e2fcbbbb3423566a502a7b9dc757bcb8` | `fa54025c864c30d3c780b2138e0ca1f67962128fb8914606372a5fa334add5a8` |
| `apps/api/src/app.ts`                                | `0b517816d22efb4c3d938a69cb2dbb6182537d3b` | `5782942ce2617be6b62374b5f639e68ad437f49fc3424d91d271efc401f3dc9d` |
| `apps/api/src/app.test.ts`                           | `a1f7b51eed5f86d8b56edf03e8ae207486456d60` | `4b9ccfcc49b48cdc07e0afb12f0dcb27102b58c71e3c26d9f6bafd809ee29021` |
| `apps/api/src/main.ts`                               | `14e67721feb83f1744186669eb3b44a9e1be4eb9` | `0f6d680325165c5db9127f0d327654aa82a559e8a00db66f2ee98caed59c97c4` |
| `contracts/openapi/user/v1/openapi.yaml`             | `6a2b26a082c0732dfccf8a976d27a6e3c145813d` | `391a363001274a813711cfd899eab97297f4c50215adb9b03b618d05ede59c0a` |
| `packages/api-sdk/src/index.ts`                      | `2ed072264d97c30f535e21260fbc0f2b7fdcdf27` | `10bfaf13eeab7b4f20b9c62b871144542fd881e001e244d54c0db72193ecfc82` |
| `packages/api-sdk/src/index.test.ts`                 | `1171d8d7e2e9dacf4a9040982cd028811d16382a` | `c7021773898d0511ef999255db8dc3bc06f2953066e2717f3b2c170a20dea07b` |
| `apps/web/src/auth-gateway.ts`                       | `5b9e957f3ebd22a1a9d79b088eebca48f8513279` | `0c1d89accdd32deb18d745dae6810130a7dc41744d9d205a03e03a2e72d8a33d` |
| `apps/web/src/auth-gateway.test.ts`                  | `1a01df269d8f647f3a66d599ac053b566a09bb59` | `f371abebcbe37775c7440f6d12b7e7319bc0e4c1522d244cd77ff0afc5470b14` |
| `apps/web/src/App.tsx`                               | `ad9fa9f01297a7511f668be0293b3d8f2b07709a` | `0c59a5bbdb10797f3a21dff21023e5f541946d1630c905fbda7d6e1ee53a8a52` |
| `apps/web/src/App.test.tsx`                          | `14175600cbf65fb4474419861969fa678ed0a605` | `54317a0162bfb6db2fec0e414b8c6c60f3e7a90be536854505a0e268d86cb10e` |
| `apps/web/src/CommunitiesPage.tsx`                   | `92bcc35d984ec10fc70d5bcadded7600e8608c16` | `d9f3951e5f58b309753d48d24445b5f538cbb155296116b58e42fa528fe768d6` |

No new package dependency is required by this slice. Exclude the current `package.json` and `package-lock.json` changes; they belong to migration/realtime tooling in the broader candidate.

## Explicit exclusions

- All database migrations `0060+` and all legacy import/staging/finalization scripts.
- Canonical `packages/communities/src/community-read.ts`, its test, canonical database repository and canonical discovery/detail routes.
- Community create, membership commands, ownership transfer and moderation commands.
- Direct invites and quota overrides.
- Media upload, S3/Clam processing and media worker code.
- Realtime tickets, websocket service, broker consumer and durable recovery.
- CUP-admin moderation workspace.
- Worker and realtime package/deployment changes.
- Compose/staging/deployment changes.

## Required integration order

1. Create a clean worktree from the intended integration base.
2. Copy the exact new read-only files after verifying the hashes above.
3. Reuse the baseline directory service/adapter/route and apply only the `memberRank` projection plus reverse-mapping hunks listed above.
4. Hand-apply shared config/package/database/API/OpenAPI/SDK/Web hunks in that order.
5. Regenerate generated contracts if the repository gate requires it; inspect the generated diff.
6. Run focused tests, root typecheck, contract lint, API/SDK/Web builds and `git diff --check`.
7. Repeat the authenticated 19-community browser matrix with worker/realtime stopped.
8. Obtain independent integration/security/UI review of the clean diff.
9. Only after a separate approval, create a checkpoint commit. Push, deploy and activation require their own approvals.

## Current residual risks

- The upstream membership summary may still return an undocumented transient `404`; access remains fail-closed.
- This evidence is local and sequential, not a capacity/SLO or production certification.
- The LK read projections are temporary read ownership, not canonical chat unread state, messaging ownership or rating fact storage.
- Any runtime flag, image, source mount or process-topology change invalidates the runtime evidence and requires re-certification.
