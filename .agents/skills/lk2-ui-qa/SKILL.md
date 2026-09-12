---
name: lk2-ui-qa
description: Check an LK2 Web or CUP UI change against the existing design, rendered behavior, keyboard access and responsive layout in the task's local preview. Use for UI implementation verification or an explicitly read-only UI audit.
---

# LK2 UI QA

Read the current root and applicable nested `AGENTS.md`; task intent determines write authority.
An audit produces findings, not fixes. For implementation, complete the authorized small change and
its checks; use the existing `lk2-dev` workflow when available. This skill does not redesign the UI.

1. Identify the changed screen, expected behavior and current design reference from neighboring
   components, styles and tests. Keep LK2's React/Vite stack, components, tokens and visual language.
   Do not import a framework, UI kit, data source or a third-party redesign process.
2. Follow `docs/runbooks/local-development.md` for the current Docker preview when present. Read
   its actual launcher before using unfamiliar commands. Verify the preview's worktree/source and
   ownership with its status command. An occupied port is not permission to stop another preview,
   kill a process, delete a volume or silently connect to the wrong source. Report the owner/conflict
   and continue source checks; use another port only if the current launcher explicitly supports it.
   If the launcher is absent, use the checked-in Compose/runbook; do not invent a replacement.
3. Inspect rendered DOM before choosing selectors. Prefer accessible roles/names and bounded waits
   for the expected UI condition. LK2 can use polling/Realtime: network idle alone is not a reliable
   readiness signal. Use available browser tooling; do not install Python Playwright or run an
   external server wrapper merely because an upstream example uses it.
4. Check the touched behavior at a representative narrow and wide viewport, keyboard focus/order,
   accessible name, wrapping/overflow and relevant loading/empty/error states. For a copy-only fix,
   keep this proportional. Capture before/after evidence with viewport, route, source identity and
   browser result. Exclude credentials, real user records and authenticated storage from artifacts.
5. Reuse valid focused test/lint/type/build results under the root evidence rule. Run missing affected
   checks. A successful build or HTTP 200 does not prove rendering; missing browser access is an
   explicit unverified item. QA actions that book, pay or mutate provider/shared state require their
   own authority; use synthetic local fixtures or interception for this verification.

When investigating a measured performance problem, check independent request waterfalls,
unnecessary repeat work and avoidable imports only in the affected path. Upstream Vercel's
`CRITICAL` means optimization priority, not LK2 risk. No automatic broad optimization, new caching
library, Next.js API, Supabase, auth change or architectural rewrite follows.

Report observed versus expected behavior, actionable file/line findings, checks and evidence limits.
Mark `LOCAL` browser evidence separately from component tests, CI and live evidence. Retain the
existing design unless a redesign is explicitly requested. Sources, adaptations and license scope:
[third-party record](../../../docs/ai/third-party-skills.md).
