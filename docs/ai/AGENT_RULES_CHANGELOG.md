# Agent rules changelog

## 2026-09-05 — LK2 local product loop

Added a short root route to project `lk2-dev`, explicit-only `lk2-release` and `lk2-deploy` skills.
The local runbook and guarded launcher reuse development Compose and dev commands while isolating
task resources. Existing FAST/SAFE/CRITICAL gates, delivery batches and canonical Timeweb approvals
remain authoritative. Ordinary UI work does not inherit release certification; skill invocation
grants no publication or live-write authority.
