# LK2 local-first Codex skills

The root `AGENTS.md` owns intent, FAST/SAFE/CRITICAL, architecture and approval policy. Skills add
small task techniques; they do not grant permissions. The local-first delivery work owns
`lk2-dev`, `lk2-release`, `lk2-deploy`, `scripts/lk2-local.js` and the local development runbook.
This change adds only `lk2-ui-qa` and `lk2-debug`. Its base is [Draft PR #175](https://github.com/Z6v6e6r/lk2/pull/175),
checkpoint `ca18eda2cb04c6d3e8d747c54972f53895e5949f`. Integrate it after that local-first delivery PR;
do not recreate its launcher, environment configuration or three workflow skills.

## Usage

| Request                                                      | Workflow                                                                                                                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “Investigate why this screen fails; no changes.”             | Read-only diagnosis with `lk2-debug`; inspect test side effects before running anything. Return findings, not a patch.                                                                          |
| “Fix this label and verify it.”                              | Existing `lk2-dev` implementation loop plus `lk2-ui-qa` when rendered verification applies. Preserve the existing design, complete the patch and affected checks, then authorized Draft PR/CI.  |
| “Fix this failing test.”                                     | `lk2-debug`: reproduce, trace, test one hypothesis, implement narrowly and verify. Reuse valid earlier evidence.                                                                                |
| “Prepare a release.”                                         | Existing `lk2-release`: source/CI eligibility and a reviewable plan. No dispatch or image publication.                                                                                          |
| “Check deployment readiness.”                                | Existing `lk2-deploy`: input/custody checks and missing prerequisites. No host-writing preparation, pull/up, migration or live write.                                                           |
| “Execute this approved operation on this source and target.” | Follow the corresponding existing runbook for only that exact transition, with its prerequisites/readbacks. Stop at the next unapproved boundary.                                               |
| “Preview port is occupied.”                                  | Read the current launcher/status and identify ownership. Preserve the existing owner; continue independent source checks. No automatic kill, reset, port workaround or replacement environment. |

Explicit invocation is supported: `$lk2-ui-qa` or `$lk2-debug`. Normal selection uses their narrow
frontmatter descriptions. Read skills manually if the current session catalog predates the files;
start a new task in the correct worktree to verify automatic discovery. Do not change global
settings or copy skills into a user-wide skill directory to repair discovery.

The current local-first runbook is `docs/runbooks/local-development.md`. Use its checked-in Docker
commands, actual context and per-worktree ownership; do not paste upstream server commands.
Fresh disposable database initialization remains separately authorized. Preview/mock evidence
covers only its actual service closure, not provider behavior, messaging or production readiness.

## Instruction and capability audit (2026-09-05)

Evidence was obtained from disk, `codex --version`, `codex exec --help`, `codex debug --help`,
`codex debug models`, `codex debug prompt-input` and a real read-only `codex exec` probe.

- Installed CLI: `0.153.0`; Node `v22.13.1`, npm `11.1.0`.
- The primary checkout was dirty on an unrelated branch. Its root instructions and untracked
  `agent-orchestration` references differ from current main, including old commit/push stops,
  universal full-check wording and a stale 2026-08-08 model catalog. They were read and preserved.
- Fresh main at the audit base was `cd5718fe55ec9bbf1204194ab63f258278429d43`.
  Its tracked instruction inventory contained only root `AGENTS.md`; no closer AGENTS/override
  applied to the new skill or docs paths. The clean worktree did not contain the primary checkout's
  untracked `.codex/config.toml` or orchestration skill. They were not copied.
- `codex debug prompt-input` in the primary checkout included the user-level global routing policy
  plus old project instructions; it did not contain the architecture freeze. In the clean task
  worktree it included global routing plus current project policy and the freeze, and excluded the
  old project commit/push stop. This verifies assembled CLI input, not a hypothetical file search.
- After adding the two skills, a new diagnostic input contained both names/descriptions and the
  intent block. Skill bodies remain on-demand. The pre-existing desktop conversation retains its
  supplied startup context; editing files does not prove that conversation was reloaded.
- The direct CLI probe actually executed `pwd` in the task worktree and returned its initially
  supplied instruction/skill inventory. It was not merely asked to predict what Codex would do.
- `exec` supports `--ephemeral`, `--ignore-user-config`, JSON events, last-message output and sandbox
  selection. `debug prompt-input` is a diagnostic snapshot, not an agent execution. These commands
  initially hit sandbox permission errors; the same read-only diagnostics worked with the existing
  per-command approval mechanism. No global approval/configuration changes were made.
- The current catalog includes Astra, Sol, Terra, Luna and Spark. Availability is execution-path
  dependent; the comparisons use the actually successful `gpt-5.6-terra`/medium path. No persistent
  model or custom-agent configuration was changed.

Official references: [instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
and [skill discovery](https://learn.chatgpt.com/docs/build-skills). The installed diagnostic input,
not documentation alone, is the evidence for the observed machine behavior.

## Meaning changes and retained rules

1. **Explicit intent boundary:** research/audit/diagnosis no longer inherits implementation writes;
   tests that write, setup and instrumentation need the proper scope. A requested report artifact
   permits that artifact only. Conversely, “fix” includes implementation and verification rather
   than stopping at a plan.
2. **Explicit preparation boundary:** release/deploy preparation stops before publication, dispatch
   and host-writing “prepare” commands. Approved execution is bound to one concrete transition.
   These preserve existing live runbook gates while removing ambiguity in ordinary wording.
3. **External technique boundary:** no upstream process/risk label overrides LK2; inspect pinned
   material before execution, preserve design/stack, and never auto-update third-party skills.
4. **Evidence clarification:** consolidate duplicate rerun wording into one rule, require stating
   when a result is reused, and limit branch synchronization to the owner's branch. No successful
   result is invalidated merely by unrelated main drift.
5. **Approval list made explicit:** image publication, workflow dispatch/rerun and tag/branch
   deletion are now named in the root list. They were already gated by global policy/runbooks;
   no new permission is granted and no existing approval boundary is removed.

Unchanged: FAST/SAFE/CRITICAL definitions and automatic critical boundaries; four-task portfolio,
two read-only subagent limit, one platform/release owner and branch/integration/release/deploy role
ownership; source/CI/live evidence separation; system/data/API/security invariants; immutable image
promotion; and the 2026-08-25–2026-11-23 architecture freeze. No product architecture, deployment
implementation, `.github/workflows/**`, `deploy/**`, secret, DNS, shared/prod data or global Codex
configuration was changed. The local-product-loop block comes from the separate delivery task;
its behavior is not attributed to this skills change.

## Verification and limitations

See [behavioral comparison](skill-evaluation.md) for actual commands, outcomes and known limits;
see [source/license record](third-party-skills.md) for exact upstream commits, hashes, licenses and
rejected techniques. The optional fixture generator is [evals/prepare.py](evals/prepare.py). It is not installed
as a hook, updater, CI job or global process. It generates inputs only and never runs an agent or grades a result. Keep raw
agent logs and disposable repositories outside Git. A fixture result cannot certify live deployment
or guarantee future model behavior.
