# Agent rules changelog

## 2026-09-05 — LK2 local product loop

Added a short root route to project `lk2-dev`, explicit-only `lk2-release` and `lk2-deploy` skills.
The local runbook and guarded launcher reuse development Compose and dev commands while isolating
task resources. Existing FAST/SAFE/CRITICAL gates, delivery batches and canonical Timeweb approvals
remain authoritative. Ordinary UI work does not inherit release certification; skill invocation
grants no publication or live-write authority.

## 2026-09-05 — Task intent and focused QA/debug skills

Separate research, implementation, release/deploy preparation and exact approved execution in root
policy. Consolidate evidence reuse and make existing publication/dispatch/deletion gates explicit.
Add only `lk2-ui-qa` and `lk2-debug`; retain the existing local product loop and three workflow skills.
Preserve FAST/SAFE/CRITICAL, all ownership/live gates and the architecture freeze. Selected upstream
techniques have pinned source/license records and no updater or executable import. Behavioral
fixture results, limitations and semantic changes are recorded in `local-first-skills.md`,
`skill-evaluation.md` and `third-party-skills.md`. No product or deploy architecture changes.

## 2026-09-06 — executable feature delivery

Independent features use task -> PR -> main -> release, with one outcome owner and optional
integration only for real dependencies. Existing FAST/SAFE/CRITICAL boundaries remain; routine
owner-enrolled deployment is distinct from changes to its mechanism. CI presentation syntax,
required-result verification, exact main source reuse and the disabled standard Timeweb Web route
are covered by scenario tests. Blocking review names a concrete consequence and minimum fix;
unrelated improvements are follow-up findings. No current-session production authority changes.
