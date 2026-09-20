-- Expand-only chat moderation queue support. The moderation foundation of migration 0007 has no
-- queue index at all: a CUP review queue ordered by state and arrival would scan the whole report
-- table. Both indexes are additive and change no existing row or constraint.
-- phub:reviewed-new-table-index

set local lock_timeout = '5s';
set statement_timeout = '30s';

-- Oldest-first review queue over pending reports, tenant-local.
create index moderation_reports_queue_idx
  on moderation.reports (tenant_id, state, created_at, id);

-- A decided case lists its actions; the moderated message references exactly one of them.
create index moderation_actions_case_idx
  on moderation.actions (tenant_id, case_id, created_at);
