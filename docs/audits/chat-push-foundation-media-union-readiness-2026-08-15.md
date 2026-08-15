# Chat/push foundation and media staging semantic-union readiness — 2026-08-15

## Verdict

- Source integration: `GO` for a local merge commit after independent R4 re-review.
- Push, pull request and staging dispatch: not covered by this evidence.
- Staging foundation dispatch: `NO-GO` until the protected Environment and the exact live
  PostgreSQL, tenant, producer, Rabbit, Prometheus, backup and runtime preconditions in the
  runbooks are independently established.
- Chat, Web Push and booking-reminder activation remain `NO-GO`; this merge does not provide an
  authoritative booking lifecycle producer or provider delivery evidence.

## Exact integration boundary

- Worktree: `.worktrees/chat-push-staging-foundation-20260815`.
- Branch: `codex/chat-push-staging-foundation-20260815`.
- First merge parent: `797137cc4a7ef4d3157d21a0a427640811f8462c`.
- Second merge parent and observed `origin/main`:
  `378701a0ca72ac478e2be608791b3ce681af8093`.
- Manually resolved semantic-union paths:
  `.github/workflows/deploy-staging.yaml`, `apps/migrator/tsup.config.ts`,
  `docs/runbooks/jetson-staging.md` and `scripts/nano-presentation-contract.test.ts`.
- Staged source files before this audit: `26`; untracked files: `0`; unmerged entries: `0`.
- SHA-256 of the staged binary diff from the first parent, excluding this audit:
  `1749ec0785c4c9466e04b2d4aff5e296381f8ecf2804a1804657c33d0d27556b`.

The earlier
[chat-push-staging-foundation-readiness-2026-08-15.md](./chat-push-staging-foundation-readiness-2026-08-15.md)
is checkpoint evidence for the pre-union branch. Its old source boundary, counts and integration
stop condition are historical and are not reused as proof for this merge candidate.

## Preserved semantic union

- `verify` depends on request validation, protected foundation authorization and the media
  baseline. The conditional gates apply only to their respective profiles.
- Recovery alone skips image build; every other deploy profile requires a successful immutable
  build. `deploy` keeps both the recovery identity constraints and the media-baseline dependency.
- A common validation-job scanner runs before every downstream third-party Action. All `21`
  external `uses:` references are exact reviewed 40-hex commits; no executable `@vN` remains.
- `MEDIA_BINARY_ONLY` rejects every foundation input. Foundation profiles reject diagnostics,
  media, routing, messaging-player and user-access inputs. User-access rejects media-only active
  release input before its early return.
- Read-only runtime isolation, foundation preflight and media re-attestation occur before the first
  staging write. Runtime verifier scripts are streamed over SSH for those checks.
- Candidate Compose is uploaded only to a run-bound same-directory `.next`, validated as a regular
  non-symlink with `docker compose config --no-interpolate`, and atomically renamed. Direct SCP to
  active `compose.yaml` is forbidden by contract tests.
- Foundation and media helpers are installed only for their owning profiles. Foundation/recovery
  execute their release helper and exit before ordinary or media rollout logic.
- Media baseline now fingerprints the present/absent foundation overlay and resolves it at final
  API/worker precedence. Any shell, `infrastructure.env` or `release.env` redirection of that overlay
  fails closed.
- The migrator bundle contains the main migrator, common role verifier, media runtime-role verifier
  and all three foundation verifiers.
- Both foundation profiles and `MEDIA_BINARY_ONLY` preserve `staging.auth.env` byte-for-byte;
  ordinary profiles retain their existing atomic rewrite behavior.

## Verification on this boundary

- Focused foundation/media/rollback/migrator suite: `16` files, `243` tests passed.
- Initial semantic-union suite: `8` files, `186` tests passed.
- `npm run check`: `PASS`.
  - Vitest: `315` files passed, `4` skipped; `2049` tests passed, `41` skipped.
  - Formatting, ESLint, full TypeScript, contract lint, all builds and runtime import verification
    completed successfully.
- `npm run contracts:lint`: `PASS` with six unchanged non-blocking baseline warnings.
- `npm run db:migrate:check`: `PASS`, `85` migrations.
- `npm run build -w @phub/migrator`: `PASS`; all six required entry points were emitted.
- `docker compose -f deploy/compose.staging.yaml config --quiet --no-interpolate`: `PASS`.
- YAML parse, all `30` Jetson shell syntax checks, Action scanner `21/21` and
  `git diff --check`: `PASS`.
- No staging/production endpoint, secret-bearing environment, database, broker, provider or
  deployment workflow was accessed by these source gates.

## External stop conditions

Before an authorized staging dispatch, independently prove all runbook gates for the exact
committed candidate: protected Environment policy and operator allowlist; active release and image
digests; complete tenant inventory; global and tenant gates disabled; no endpoints or semantic
rows; no unpublished booking lifecycle outbox records or active external producer; exact runtime,
realtime and migrator PostgreSQL contour and privileges; writer drain; verified backup and restore;
exact pending migration set; Rabbit topology/backlog; Prometheus target/rule/current-instance
series; lock timing; and sequential runtime recovery.

Any mismatch keeps the foundation profile fail-closed. Production promotion, provider calls,
schema rollback and activation are outside this integration step.
